import { useSyncExternalStore } from "react";
import type { Account, AccountId, Job, ProviderId, ProviderStatus } from "../../contracts";
import * as api from "./api";

export type LiveState = "connecting" | "open" | "reconnecting" | "closed";

export interface Resource<T> {
  readonly data: T | null;
  readonly error: api.ApiError | null;
  readonly loading: boolean;
}

interface ResourceData {
  readonly providers: readonly ProviderStatus[];
  readonly accounts: readonly Account[];
  readonly jobs: readonly Job[];
}

type ResourceKey = keyof ResourceData;

export type GatewayState = { readonly [K in ResourceKey]: Resource<ResourceData[K]> } & {
  readonly live: LiveState;
  readonly syncing: boolean;
  readonly checkStartedAt: ReadonlyMap<AccountId, number>;
};

const pending = { data: null, error: null, loading: true } as const;

// Server state refreshes on SSE `change`, SSE (re)open and explicit refresh only — never polling.
// Writes bump the resource ticket so an older in-flight GET cannot overwrite them.
class GatewayStore {
  private state: GatewayState = {
    providers: pending,
    accounts: pending,
    jobs: pending,
    live: "connecting",
    syncing: false,
    checkStartedAt: new Map(),
  };
  private readonly listeners = new Set<() => void>();
  private readonly tickets: Record<ResourceKey, number> = { providers: 0, accounts: 0, jobs: 0 };
  private source: EventSource | null = null;
  private everOpened = false;
  private syncRun: Promise<void> | null = null;
  private syncAgain = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): GatewayState => this.state;

  start(): () => void {
    void this.loadProviders();
    void this.sync();
    this.connect();
    const onVisible = (): void => {
      if (document.visibilityState === "visible" && this.state.live === "closed") this.connect();
    };
    const onOnline = (): void => {
      if (this.state.live !== "open") this.connect();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      this.source?.close();
      this.source = null;
    };
  }

  reconnect(): void {
    this.connect();
  }

  async refresh(): Promise<void> {
    if (this.state.live === "closed") this.connect();
    await Promise.all([this.loadProviders(), this.sync()]);
  }

  sync(): Promise<void> {
    if (this.syncRun) {
      this.syncAgain = true;
      return this.syncRun;
    }
    const run = async (): Promise<void> => {
      this.commit({ syncing: true });
      do {
        this.syncAgain = false;
        await Promise.all([this.loadAccounts(), this.loadJobs()]);
      } while (this.syncAgain);
      this.commit({ syncing: false });
    };
    this.syncRun = run().finally(() => {
      this.syncRun = null;
    });
    return this.syncRun;
  }

  async createAccount(input: api.AccountInput): Promise<Account> {
    const account = await api.createAccount(input);
    this.putAccount(account);
    return account;
  }

  async updateAccount(id: AccountId, patch: api.AccountPatch): Promise<Account> {
    const account = await api.updateAccount(id, patch);
    this.putAccount(account);
    return account;
  }

  async deleteAccount(id: AccountId): Promise<void> {
    await api.deleteAccount(id);
    this.tickets.accounts += 1;
    const data = (this.state.accounts.data ?? []).filter((account) => account.id !== id);
    this.commit({ accounts: { data, error: null, loading: false } });
    void this.sync();
  }

  async setProviderEnabled(id: ProviderId, enabled: boolean): Promise<ProviderStatus> {
    const provider = await api.setProviderEnabled(id, enabled);
    const list = this.state.providers.data ?? [];
    const data = list.map((item) => (item.id === id ? provider : item));
    this.tickets.providers += 1;
    this.commit({ providers: { data, error: null, loading: false } });
    return provider;
  }

  async checkAccount(id: AccountId): Promise<Account> {
    this.setCheck(id, Date.now());
    try {
      const account = await api.checkAccount(id);
      this.putAccount(account);
      return account;
    } finally {
      this.setCheck(id, null);
      void this.sync(); // a failed check may still have recorded an observed status
    }
  }

  async createJob(target: api.JobTarget, prompt: string): Promise<Job> {
    const job = await api.createJob(target, prompt);
    this.tickets.jobs += 1;
    const rest = (this.state.jobs.data ?? []).filter((item) => item.id !== job.id);
    this.commit({ jobs: { data: [job, ...rest], error: null, loading: false } });
    void this.sync();
    return job;
  }

  private connect(): void {
    this.source?.close();
    const source = new EventSource("/api/events");
    this.source = source;
    this.commit({ live: this.everOpened ? "reconnecting" : "connecting" });
    source.addEventListener("open", () => {
      if (this.source !== source) return;
      this.everOpened = true;
      this.commit({ live: "open" });
      void this.sync(); // catch up on anything persisted while the stream was down
    });
    source.addEventListener("change", () => {
      if (this.source === source) void this.sync();
    });
    source.addEventListener("error", () => {
      if (this.source !== source) return;
      // CONNECTING means the browser retries on its own; CLOSED means it gave up (HTTP error).
      this.commit({ live: source.readyState === EventSource.CLOSED ? "closed" : "reconnecting" });
    });
  }

  private loadProviders(): Promise<void> {
    return this.load("providers", () => this.state.providers, (providers) => this.commit({ providers }), api.listProviders);
  }

  private loadAccounts(): Promise<void> {
    return this.load("accounts", () => this.state.accounts, (accounts) => this.commit({ accounts }), api.listAccounts);
  }

  private loadJobs(): Promise<void> {
    return this.load("jobs", () => this.state.jobs, (jobs) => this.commit({ jobs }), api.listJobs);
  }

  private async load<T>(
    key: ResourceKey,
    current: () => Resource<T>,
    write: (value: Resource<T>) => void,
    fetcher: () => Promise<T>,
  ): Promise<void> {
    this.tickets[key] += 1;
    const ticket = this.tickets[key];
    write({ ...current(), loading: true });
    try {
      const data = await fetcher();
      if (ticket === this.tickets[key]) write({ data, error: null, loading: false });
    } catch (error) {
      const failure = await api.toApiError(error);
      if (ticket === this.tickets[key]) write({ data: current().data, error: failure, loading: false });
    }
  }

  private putAccount(account: Account): void {
    const list = this.state.accounts.data ?? [];
    const data = list.some((item) => item.id === account.id)
      ? list.map((item) => (item.id === account.id ? account : item))
      : [...list, account];
    this.tickets.accounts += 1; // a GET started before this write must not overwrite it
    this.commit({ accounts: { data, error: null, loading: false } });
    void this.sync();
  }

  private setCheck(id: AccountId, startedAt: number | null): void {
    const checkStartedAt = new Map(this.state.checkStartedAt);
    if (startedAt === null) checkStartedAt.delete(id);
    else checkStartedAt.set(id, startedAt);
    this.commit({ checkStartedAt });
  }

  private commit(patch: Partial<GatewayState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export const gateway = new GatewayStore();

export function useGateway(): GatewayState {
  return useSyncExternalStore(gateway.subscribe, gateway.getSnapshot);
}
