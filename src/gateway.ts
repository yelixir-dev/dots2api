import { GatewayError, jobIdSchema } from "./contracts";
import type { Account, AccountId, Credentials, Job, JobId, ProviderAdapter, ProviderId, ProviderStatus, ReferenceImage } from "./contracts";
import { validateReferenceImages } from "./images";
import { Store } from "./store";
import type { DotsAuth } from "./dots-auth";

export class Gateway {
  private readonly busy = new Set<AccountId>();
  private readonly tasks = new Map<JobId, Promise<Job>>();
  private readonly listeners = new Set<() => void>();
  private readonly shutdown = new AbortController();
  private readonly leases = new Set<Promise<void>>();
  constructor(readonly store: Store, readonly adapters: Readonly<Record<ProviderId, ProviderAdapter>>, private readonly dotsAuth?: DotsAuth) {}

  private async credentials(id: AccountId, signal: AbortSignal): Promise<Credentials> {
    if (this.account(id).provider !== "dots" || !this.dotsAuth) return this.store.credentials(id);
    return this.dotsAuth.refresh(id, {
      read: () => this.store.credentials(id),
      save: (credentials) => { this.store.saveAccount(this.account(id), credentials); },
    }, signal);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
  /** Hold an account across an interactive login; only this lease may release it. */
  reserve(id: AccountId): () => void {
    if (this.shutdown.signal.aborted) throw new GatewayError("shutting_down", "Gateway is shutting down.", 503);
    if (this.account(id).busy) throw new GatewayError("account_busy", "An operation is still active.", 409);
    const done = Promise.withResolvers<void>();
    this.leases.add(done.promise);
    this.busy.add(id);
    this.changed();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy.delete(id);
      this.leases.delete(done.promise);
      done.resolve();
      this.changed();
    };
  }
  stop(): void { this.shutdown.abort(); }
  async drain(): Promise<void> { await Promise.all([...this.leases]); }
  accounts(): Account[] { return this.store.accounts().map((a) => ({ ...a, busy: this.busy.has(a.id) })); }
  /** Every registered provider with the operator's on/off switch applied. */
  providerStatuses(): ProviderStatus[] {
    const states = this.store.providerStates();
    return Object.values(this.adapters).map((adapter) => ({ ...adapter.info, enabled: states[adapter.info.id] }));
  }
  setProviderEnabled(id: ProviderId, enabled: boolean): void {
    this.store.setProviderEnabled(id, enabled);
    this.changed();
  }
  account(id: AccountId): Account {
    const account = this.store.account(id);
    if (!account) throw new GatewayError("account_not_found", "Account not found.", 404);
    return { ...account, busy: this.busy.has(id) };
  }
  create(provider: ProviderId, label: string, credentials: Credentials): Account {
    // Empty configuration can be saved as unconnected; validation occurs when connecting.
    const account = this.store.createAccount(provider, label, credentials);
    this.changed();
    return account;
  }
  update(id: AccountId, patch: { readonly label?: string; readonly enabled?: boolean; readonly credentials?: Credentials }): Account {
    const account = this.account(id);
    if (account.busy) throw new GatewayError("account_busy", "Wait for the account's current operation.", 409);
    const previous = { ...this.store.credentials(id) };
    if (account.provider === "dots" && patch.credentials &&
      ("accessToken" in patch.credentials || "accountId" in patch.credentials)) {
      for (const key of ["refreshToken", "idToken", "expiresAt", "refreshState"]) delete previous[key];
      if ("accountId" in patch.credentials && !("accessToken" in patch.credentials)) delete previous["accessToken"];
    }
    const updated = this.store.saveAccount({
      ...account, label: patch.label ?? account.label, enabled: patch.enabled ?? account.enabled,
      ...(patch.credentials ? { status: "unconnected", detail: "Credentials changed. Check connection again.", checkedAt: null } as const : {}),
    }, patch.credentials ? { ...previous, ...patch.credentials } : undefined);
    this.changed();
    return updated;
  }
  remove(id: AccountId): void {
    const account = this.account(id);
    if (account.busy) throw new GatewayError("account_busy", "An operation is still active.", 409);
    this.store.deleteAccount(id);
    this.changed();
  }
  async check(id: AccountId): Promise<Account> {
    const release = this.reserve(id);
    try { return await this.checkReserved(id); }
    finally { release(); }
  }
  /** Login coordinators call this while retaining their account lease. */
  async checkReserved(id: AccountId): Promise<Account> {
    const account = this.account(id);
    if (!account.busy) throw new GatewayError("account_not_reserved", "Connection check requires an account lease.", 409);
    try {
      const adapter = this.adapters[account.provider];
      const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(300_000)]);
      const credentials = adapter.validate(await this.credentials(id, signal));
      const result = await adapter.check(credentials, {
        accountId: id, dataDir: this.store.dataDir, signal,
        // A check may repair credentials (for example a renewed browser session); persist them without touching status.
        saveCredentials: (repaired) => { this.store.saveAccount(this.account(id), repaired); },
      });
      return this.store.saveAccount({
        ...account, status: "ready", detail: result.detail, checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      return this.store.saveAccount({
        ...account, status: "error", detail: publicError(error), checkedAt: new Date().toISOString(),
      });
    } finally {
      this.changed();
    }
  }
  /**
   * Automatic recovery after an uncertain failure: the provider re-verifies its own session (what the console's Check
   * button does) so a transient remote problem does not quarantine the account until a human notices. Only adapters
   * that declare `reconnect` participate, and a recovery that fails leaves the account in error exactly as before.
   */
  private async autoReconnect(id: AccountId): Promise<Account | null> {
    const adapter = this.adapters[this.account(id).provider];
    if (!adapter.reconnect) return null;
    try {
      const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(300_000)]);
      const credentials = adapter.validate(await this.credentials(id, signal));
      const result = await adapter.reconnect(credentials, {
        accountId: id, dataDir: this.store.dataDir, signal,
        saveCredentials: (repaired) => { this.store.saveAccount(this.account(id), repaired); },
      });
      return this.store.saveAccount({
        ...this.account(id), status: "ready",
        detail: `Connection re-verified automatically after an unconfirmed job. ${result.detail}`,
        checkedAt: new Date().toISOString(),
      });
    } catch {
      // The caller's quarantine is the honest outcome when the session cannot be re-verified.
      return null;
    }
  }
  submit(input: { readonly accountId?: AccountId; readonly provider?: ProviderId; readonly prompt: string; readonly referenceImages?: readonly ReferenceImage[] }): Job {
    if (input.referenceImages) validateReferenceImages(input.referenceImages);
    const referenceImages = input.referenceImages?.map((image) => ({ mime: image.mime, data: new Uint8Array(image.data) }));
    const account = input.accountId
      ? this.account(input.accountId)
      : this.accounts()
        .filter((a) => a.provider === input.provider && a.enabled && a.status === "ready" && !a.busy)
        .sort((a, b) => (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? ""))[0];
    if (!account) throw new GatewayError("no_account", "No connected idle account is available for this provider.", 503);
    if (input.provider && account.provider !== input.provider) throw new GatewayError("provider_mismatch", "Account and provider do not match.");
    if (!this.store.providerEnabled(account.provider)) throw new GatewayError("provider_disabled", `${account.provider} is switched off in the console; no new jobs are routed to it.`, 503);
    if (!account.enabled || account.status !== "ready") throw new GatewayError("account_not_ready", "Enable and check this account before submitting work.", 409);
    if (account.busy) throw new GatewayError("account_busy", "This account already has an active operation.", 409);
    this.adapters[account.provider].validate(this.store.credentials(account.id));
    const release = this.reserve(account.id);
    const job: Job = {
      id: jobIdSchema.parse(crypto.randomUUID()), accountId: account.id, provider: account.provider,
      prompt: input.prompt, status: "running", output: "", error: null, remoteId: null, images: [],
      createdAt: new Date().toISOString(), finishedAt: null,
    };
    this.store.saveAccount({ ...account, lastUsedAt: job.createdAt });
    this.store.saveJob(job);
    const task = Promise.resolve().then(() => this.execute(job, referenceImages)).finally(release);
    this.tasks.set(job.id, task);
    this.changed();
    return job;
  }
  async wait(id: JobId): Promise<Job> {
    const pending = this.tasks.get(id);
    if (pending) return pending;
    const job = this.store.job(id);
    if (!job) throw new GatewayError("job_not_found", "Job not found.", 404);
    return job;
  }
  private async execute(job: Job, referenceImages?: readonly ReferenceImage[]): Promise<Job> {
    let remoteId: string | null = null;
    try {
      const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(300_000)]);
      const credentials = this.adapters[job.provider].validate(await this.credentials(job.accountId, signal));
      const result = await this.adapters[job.provider].run(credentials, job.prompt, {
        accountId: job.accountId, dataDir: this.store.dataDir, signal,
        ...(referenceImages ? { referenceImages } : {}),
        saveCredentials: (repaired) => { this.store.saveAccount(this.account(job.accountId), repaired); },
        onAccepted: (id) => {
          remoteId = id;
          this.store.saveJob({ ...job, remoteId });
          this.changed();
        },
      });
      // The remote work is finished and its text is valid; a local storage problem must not turn it into a failure.
      let images: Job["images"] = [];
      let note = "";
      if (result.images?.length) {
        try {
          images = this.store.saveImages(job.id, result.images);
        } catch {
          note = "\n\n[dots2api] The remote agent produced images, but they could not be saved locally.";
        }
        if (images.length < result.images.length && !note) note = `\n\n[dots2api] ${result.images.length - images.length} image(s) were not stored (unsupported type or too large).`;
      }
      return this.store.saveJob({
        ...job, status: "completed", output: result.text + note, remoteId: result.remoteId, images, finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      const uncertain = !(error instanceof GatewayError) || error.uncertain;
      if (uncertain || (error instanceof GatewayError && (error.status === 401 || error.status === 403))) {
        const account = this.store.account(job.accountId);
        // Re-verify a session we can no longer trust before quarantining: an account that answers its own check is
        // usable again, which is exactly the state a human would restore by hand.
        const recovered = account && uncertain ? await this.autoReconnect(job.accountId) : null;
        if (account && !recovered) this.store.saveAccount({
          ...account, status: "error",
          detail: uncertain
            ? "Remote work may still be active. Inspect it in the provider, then check this account before reuse."
            : "Provider authentication failed. Reconnect this account before reuse.",
        });
      }
      return this.store.saveJob({
        ...job, remoteId, status: uncertain ? "unknown" : "failed", error: publicError(error),
        finishedAt: new Date().toISOString(),
      });
    } finally {
      this.tasks.delete(job.id);
      this.changed();
    }
  }
}

export function publicError(error: unknown): string {
  // Only adapter-authored errors may reach clients. Raw upstream text can contain credentials.
  if (error instanceof GatewayError) return error.message;
  return "The operation could not be confirmed. Check the provider before retrying.";
}
