import { z } from "zod";
import { GatewayError } from "../contracts";
import type { AccountId, Credentials } from "../contracts";
import { DOTS_CLIENT_ID, type DotsAuthHttp } from "./http";
import { tokenCredentials } from "./tokens";

const DEVICE_LIFETIME_MS = 900_000;
const userCodeSchema = z.object({
  device_auth_id: z.string().min(1).max(4_096),
  user_code: z.string().min(1).max(128).optional(),
  usercode: z.string().min(1).max(128).optional(),
  interval: z.union([z.string().trim().regex(/^\d+$/), z.number()])
    .transform(Number).pipe(z.number().int().min(0).max(900)).optional(),
});
const authorizationSchema = z.object({
  authorization_code: z.string().min(1).max(8_192),
  code_verifier: z.string().min(1).max(4_096),
  code_challenge: z.string().min(1).max(4_096),
});
export interface DotsDeviceStart {
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly expiresAt: number;
  readonly pollIntervalMs: number;
}
export type DotsDeviceResult =
  | { readonly status: "pending"; readonly retryAfterMs: number }
  | { readonly status: "connected"; readonly credentials: Credentials };
type Session = {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly expiresAt: number;
  readonly intervalMs: number;
  readonly controller: AbortController;
  readonly expiry: ReturnType<typeof setTimeout>;
  nextPollAt: number;
};

export class DotsDeviceAuth {
  private readonly sessions = new Map<AccountId, Session>();
  private readonly starting = new Map<AccountId, AbortController>();
  private readonly finishing = new Map<AccountId, Promise<DotsDeviceResult>>();

  constructor(private readonly http: DotsAuthHttp) {}

  async start(id: AccountId, signal?: AbortSignal): Promise<DotsDeviceStart> {
    this.clear(id);
    const controller = new AbortController();
    this.starting.set(id, controller);
    const startedAt = this.http.now();
    try {
      const response = await this.http.post("/api/accounts/deviceauth/usercode", { client_id: DOTS_CLIENT_ID },
        AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]));
      if (controller.signal.aborted) throw new GatewayError("dots_auth_cancelled", "Login was replaced or cancelled.", 409);
      if (response.status !== 200) throw new GatewayError("dots_auth_start", "Device login could not be started.", 502);
      const parsed = userCodeSchema.safeParse(response.data);
      const userCode = parsed.success ? parsed.data.user_code ?? parsed.data.usercode : undefined;
      if (!parsed.success || !userCode) throw new GatewayError("dots_auth_protocol", "Device login response was invalid.", 502);
      const intervalMs = Math.max(1_000, (parsed.data.interval ?? 5) * 1_000);
      const expiresAt = startedAt + DEVICE_LIFETIME_MS;
      const expiry = setTimeout(() => this.clear(id), Math.max(0, expiresAt - this.http.now()));
      expiry.unref();
      this.sessions.set(id, {
        deviceAuthId: parsed.data.device_auth_id, userCode, expiresAt, intervalMs,
        controller, expiry, nextPollAt: this.http.now(),
      });
      return { verificationUrl: `${this.http.issuer}/codex/device`, userCode, expiresAt, pollIntervalMs: intervalMs };
    } finally {
      if (this.starting.get(id) === controller) this.starting.delete(id);
    }
  }

  finish(id: AccountId, signal?: AbortSignal): Promise<DotsDeviceResult> {
    const active = this.finishing.get(id);
    if (active) return active;
    const operation = this.poll(id, signal).finally(() => {
      if (this.finishing.get(id) === operation) this.finishing.delete(id);
    });
    this.finishing.set(id, operation);
    return operation;
  }

  private async poll(id: AccountId, signal?: AbortSignal): Promise<DotsDeviceResult> {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= this.http.now()) {
      this.clear(id);
      throw new GatewayError("dots_auth_expired", "Device login expired. Start login again.", 409);
    }
    if (session.nextPollAt > this.http.now()) {
      return { status: "pending", retryAfterMs: session.nextPollAt - this.http.now() };
    }
    const combined = AbortSignal.any([session.controller.signal, ...(signal ? [signal] : [])]);
    const response = await this.http.post("/api/accounts/deviceauth/token", {
      device_auth_id: session.deviceAuthId, user_code: session.userCode,
    }, combined);
    if (this.sessions.get(id) !== session || session.expiresAt <= this.http.now()) {
      throw new GatewayError("dots_auth_expired", "Device login expired or was replaced.", 409);
    }
    if (response.status === 403 || response.status === 404) {
      session.nextPollAt = this.http.now() + session.intervalMs;
      return { status: "pending", retryAfterMs: session.intervalMs };
    }
    const authorization = authorizationSchema.safeParse(response.data);
    if (response.status !== 200 || !authorization.success) {
      this.clear(id);
      throw new GatewayError("dots_auth_rejected", "Device login could not be confirmed. Start login again.", 401);
    }
    // The one-time authorization code is never replayed, even after a lost response.
    try {
      const exchanged = await this.http.post("/oauth/token", new URLSearchParams({
        grant_type: "authorization_code", client_id: DOTS_CLIENT_ID,
        code: authorization.data.authorization_code, code_verifier: authorization.data.code_verifier,
        redirect_uri: `${this.http.issuer}/deviceauth/callback`,
      }), combined);
      if (exchanged.status !== 200) throw new GatewayError("dots_auth_rejected", "Device login token exchange failed.", 401);
      if (this.sessions.get(id) !== session || session.expiresAt <= this.http.now()) {
        throw new GatewayError("dots_auth_expired", "Device login expired or was replaced.", 409);
      }
      return { status: "connected", credentials: tokenCredentials(exchanged.data, this.http.now()) };
    } finally {
      if (this.sessions.get(id) === session) this.clear(id);
    }
  }

  clear(id: AccountId): void {
    this.starting.get(id)?.abort();
    this.starting.delete(id);
    const session = this.sessions.get(id);
    if (session) {
      session.controller.abort();
      clearTimeout(session.expiry);
      this.sessions.delete(id);
    }
    this.finishing.delete(id);
  }

  close(): void {
    for (const id of new Set([...this.sessions.keys(), ...this.starting.keys()])) this.clear(id);
  }
}
