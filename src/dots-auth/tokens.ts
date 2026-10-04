import { z } from "zod";
import { GatewayError } from "../contracts";
import type { Credentials } from "../contracts";

const token = z.string().min(1).max(32_768);
const claimsSchema = z.object({
  exp: z.number().positive().optional(),
  "https://api.openai.com/auth": z.object({ chatgpt_account_id: z.string().min(1).optional() }).optional(),
});
const tokensSchema = z.object({
  access_token: token,
  refresh_token: token.optional(),
  id_token: token.optional(),
  expires_in: z.number().positive().max(31_536_000).optional(),
  token_type: z.string().optional(),
});
const errorSchema = z.object({
  error: z.union([z.string(), z.object({ code: z.string() })]),
});

/** JWT metadata is not signature verification; only issuer-returned tokens establish login. */
function claims(value: string | undefined): z.infer<typeof claimsSchema> {
  const payload = value?.split(".")[1];
  if (!payload) return {};
  try {
    const parsed = claimsSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : {};
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

export function tokenExpiry(credentials: Credentials): number | undefined {
  const stored = credentials["expiresAt"];
  const explicit = stored === undefined ? undefined : Number(stored);
  if (explicit !== undefined && (!Number.isFinite(explicit) || explicit <= 0)) {
    throw new GatewayError("dots_auth_credentials", "Stored token expiry is invalid. Reconnect this account.", 401);
  }
  const exp = claims(credentials["accessToken"]).exp;
  const jwt = exp === undefined ? undefined : exp * 1_000;
  if (explicit === undefined) return jwt;
  return jwt === undefined ? explicit : Math.min(explicit, jwt);
}

export function tokenCredentials(raw: unknown, now: number, previous?: Credentials): Credentials {
  const parsed = tokensSchema.safeParse(raw);
  if (!parsed.success) throw new GatewayError("dots_auth_protocol", "Authentication returned invalid tokens.", 502);
  const tokens = parsed.data;
  if (tokens.token_type && tokens.token_type.toLowerCase() !== "bearer") {
    throw new GatewayError("dots_auth_protocol", "Authentication returned an unsupported token type.", 502);
  }
  const access = claims(tokens.access_token);
  const identity = claims(tokens.id_token);
  const accessId = access["https://api.openai.com/auth"]?.chatgpt_account_id;
  const identityId = identity["https://api.openai.com/auth"]?.chatgpt_account_id;
  const accountId = identityId ?? accessId ?? previous?.["accountId"];
  if (!accountId || (accessId && identityId && accessId !== identityId) ||
    (previous?.["accountId"] && previous["accountId"] !== accountId)) {
    throw new GatewayError("dots_auth_account", "Authentication account identity did not match.", 401);
  }
  const refreshToken = tokens.refresh_token ?? previous?.["refreshToken"];
  const idToken = tokens.id_token ?? previous?.["idToken"];
  if (!refreshToken || (!previous && !idToken)) {
    throw new GatewayError("dots_auth_protocol", "Authentication did not return renewable credentials.", 502);
  }
  const advertised = tokens.expires_in === undefined ? undefined : now + tokens.expires_in * 1_000;
  const jwt = access.exp === undefined ? undefined : access.exp * 1_000;
  const expiresAt = advertised === undefined ? jwt : jwt === undefined ? advertised : Math.min(advertised, jwt);
  if (expiresAt === undefined || !Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new GatewayError("dots_auth_protocol", "Authentication returned no usable token lifetime.", 502);
  }
  return {
    ...previous, accessToken: tokens.access_token, refreshToken, accountId,
    ...(idToken ? { idToken } : {}), expiresAt: String(expiresAt), refreshState: "ready",
  };
}

export function revoked(response: { readonly status: number; readonly data: unknown }): boolean {
  const parsed = errorSchema.safeParse(response.data);
  const code = parsed.success
    ? (typeof parsed.data.error === "string" ? parsed.data.error : parsed.data.error.code).toLowerCase()
    : "";
  return response.status === 401 || ["invalid_grant", "refresh_token_expired", "refresh_token_reused",
    "refresh_token_invalidated", "refresh_token_revoked"].includes(code);
}
