import ky from "ky";
import { z } from "zod";
import { GatewayError } from "../contracts";

// Official protocol: openai/codex, codex-rs/login/src/{device_code_auth.rs,oauth/client.rs}.
export const DOTS_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const MAX_BODY_BYTES = 65_536;
const optionsSchema = z.object({
  issuer: z.url().default("https://auth.openai.com"),
  timeoutMs: z.number().int().min(1).max(20_000).default(20_000),
});
export interface DotsAuthOptions {
  /** Only the official issuer or an explicit loopback fixture server is accepted. */
  readonly issuer?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}
export interface AuthResponse {
  readonly status: number;
  readonly data: unknown;
}

/** No redirects, retries, request logging, or upstream errors cross this boundary. */
export class DotsAuthHttp {
  readonly issuer: string;
  readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly lifetime = new AbortController();

  constructor(options: DotsAuthOptions) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) throw new GatewayError("dots_auth_config", "Invalid authentication configuration.");
    const url = new URL(parsed.data.issuer);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.origin !== "https://auth.openai.com" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new GatewayError("dots_auth_config", "Use the official authentication issuer or a loopback fixture.");
    }
    this.issuer = url.origin;
    this.timeoutMs = parsed.data.timeoutMs;
    this.now = options.now ?? Date.now;
  }

  async post(path: string, body: URLSearchParams | Readonly<Record<string, string>>, signal?: AbortSignal): Promise<AuthResponse> {
    const cleanup = new AbortController();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([this.lifetime.signal, cleanup.signal, deadline, ...(signal ? [signal] : [])]);
    try {
      const response = await ky.post(`${this.issuer}${path}`, {
        ...(body instanceof URLSearchParams ? { body } : { json: body }),
        retry: 0, timeout: false, redirect: "manual", throwHttpErrors: false, signal: combined,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new GatewayError("dots_auth_redirect", "Authentication redirect was refused.", 502);
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > MAX_BODY_BYTES) {
              throw new GatewayError("dots_auth_protocol", "Authentication response exceeded its limit.", 502);
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        if (response.ok) throw new GatewayError("dots_auth_protocol", "Authentication returned invalid JSON.", 502);
        data = null;
      }
      return { status: response.status, data };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (deadline.aborted) throw new GatewayError("dots_auth_timeout", "Authentication request timed out.", 504);
      if (combined.aborted) throw new GatewayError("dots_auth_cancelled", "Authentication request was cancelled.", 409);
      // This is the HTTP error boundary: request bodies, causes, and server text can contain tokens.
      throw new GatewayError("dots_auth_network", "Authentication service could not be reached.", 502);
    } finally {
      cleanup.abort();
    }
  }

  close(): void { this.lifetime.abort(); }
}
