import { GatewayError } from "./contracts";
import type { AccountId, Credentials } from "./contracts";
import { DotsDeviceAuth } from "./dots-auth/device";
import type { DotsDeviceResult, DotsDeviceStart } from "./dots-auth/device";
import { DOTS_CLIENT_ID, DotsAuthHttp } from "./dots-auth/http";
import type { DotsAuthOptions } from "./dots-auth/http";
import { revoked, tokenCredentials, tokenExpiry } from "./dots-auth/tokens";

export type { DotsDeviceResult, DotsDeviceStart, DotsAuthOptions };
export interface DotsCredentialPersistence {
  /** Read the latest encrypted-store value, not a previously captured snapshot. */
  readonly read: () => Credentials | Promise<Credentials>;
  /** Persist the entire value before resolving. Never expose it through an API response. */
  readonly save: (credentials: Credentials) => void | Promise<void>;
}

/**
 * One instance is the sole refresh owner for this serving process. The parent must
 * hold its account lease through each operation and exclude other processes or CLI
 * clients from this refresh-token grant. This service never opens a Store or auth file.
 */
export class DotsAuth {
  private readonly http: DotsAuthHttp;
  private readonly device: DotsDeviceAuth;
  private readonly refreshes = new Map<AccountId, Promise<Credentials>>();
  private closed = false;

  constructor(options: DotsAuthOptions = {}) {
    this.http = new DotsAuthHttp(options);
    this.device = new DotsDeviceAuth(this.http);
  }

  start(id: AccountId, signal?: AbortSignal): Promise<DotsDeviceStart> {
    return this.device.start(id, signal);
  }

  finish(id: AccountId, signal?: AbortSignal): Promise<DotsDeviceResult> {
    return this.device.finish(id, signal);
  }

  /**
   * Refreshes within 60 seconds of expiry; access-token-only accounts pass through.
   * All concurrent callers share the first caller's operation and cancellation.
   * Save runs twice: durable refreshState="refreshing" before HTTP, then "ready"
   * with rotated tokens. A crash/ambiguous response requires reconnect, not replay.
   */
  refresh(id: AccountId, persistence: DotsCredentialPersistence, signal?: AbortSignal): Promise<Credentials> {
    const active = this.refreshes.get(id);
    if (active) return active;
    const operation = this.refreshOwned(persistence, signal).finally(() => this.refreshes.delete(id));
    this.refreshes.set(id, operation);
    return operation;
  }

  private async refreshOwned(persistence: DotsCredentialPersistence, signal?: AbortSignal): Promise<Credentials> {
    if (this.closed || signal?.aborted) throw new GatewayError("dots_auth_cancelled", "Authentication request was cancelled.", 409);
    let current: Credentials;
    try {
      current = await persistence.read();
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("dots_auth_storage", "Authentication credentials could not be read.", 500);
    }
    if (current["refreshState"] === "refreshing") {
      throw new GatewayError("dots_auth_refresh_uncertain", "Token rotation was interrupted. Reconnect this account.", 401);
    }
    if (current["refreshState"] === "revoked") {
      throw new GatewayError("dots_auth_revoked", "Authentication was revoked. Reconnect this account.", 401);
    }
    const expiry = tokenExpiry(current);
    const refreshToken = current["refreshToken"];
    if (!refreshToken) {
      if (expiry !== undefined && expiry <= this.http.now()) {
        throw new GatewayError("dots_auth_expired", "Access token expired. Reconnect this account.", 401);
      }
      return current;
    }
    if (expiry !== undefined && expiry > this.http.now() + 60_000) return current;
    if (this.closed || signal?.aborted) throw new GatewayError("dots_auth_cancelled", "Authentication request was cancelled.", 409);
    await this.save(persistence, { ...current, refreshState: "refreshing" });
    try {
      const response = await this.http.post("/oauth/token", {
        grant_type: "refresh_token", client_id: DOTS_CLIENT_ID, refresh_token: refreshToken,
      }, signal);
      if (response.status !== 200) {
        if (revoked(response)) {
          await this.save(persistence, { ...current, refreshState: "revoked" });
          throw new GatewayError("dots_auth_revoked", "Authentication was revoked. Reconnect this account.", 401);
        }
        throw new GatewayError("dots_auth_refresh_uncertain", "Token rotation could not be confirmed. Reconnect this account.", 401);
      }
      const credentials = tokenCredentials(response.data, this.http.now(), current);
      await this.save(persistence, credentials);
      return credentials;
    } catch (error) {
      if (error instanceof GatewayError && error.code === "dots_auth_revoked") throw error;
      // After the durable marker, even transport/protocol/storage failure can hide rotation.
      throw new GatewayError("dots_auth_refresh_uncertain", "Token rotation could not be confirmed. Reconnect this account.", 401);
    }
  }

  private async save(persistence: DotsCredentialPersistence, credentials: Credentials): Promise<void> {
    try {
      await persistence.save(credentials);
    } catch (error) {
      if (error instanceof GatewayError && error.code === "account_not_found") throw error;
      throw new GatewayError("dots_auth_storage", "Authentication credentials could not be saved. Reconnect if rotation started.", 500);
    }
  }

  /** Clears only device login state, never permits a previously rotating token to replay. */
  clear(id: AccountId): void { this.device.clear(id); }

  close(): void {
    this.closed = true;
    this.device.close();
    this.http.close();
  }
}
