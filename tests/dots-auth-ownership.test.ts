import { expect, test } from "bun:test";
import { accountIdSchema, type Credentials } from "../src/contracts";
import { DotsAuth } from "../src/dots-auth";

const id = accountIdSchema.parse("00000000-0000-4000-8000-000000000004");
const now = 1_800_000_000_000;
const original: Credentials = {
  accessToken: "old-access", refreshToken: "old-refresh", accountId: "workspace",
  expiresAt: String(now), refreshState: "ready",
};

async function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  action: (auth: DotsAuth) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const auth = new DotsAuth({ issuer: `http://127.0.0.1:${server.port}`, now: () => now });
  try { await action(auth); } finally { auth.close(); await server.stop(true); }
}

test("refresh cancellation after transmission immediately quarantines the account with 401", async () => {
  // Given a grant observed on the wire but without a response yet.
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let stored = original;
  let requests = 0;
  await fixture(async () => {
    requests++; entered.resolve(); await release.promise;
    return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3_600 });
  }, async (auth) => {
    const controller = new AbortController();
    const persistence = { read: () => stored, save: (value: Credentials) => { stored = value; } };
    const outcome = auth.refresh(id, persistence, controller.signal).catch((error: unknown) => error);
    await entered.promise;
    // When the caller cancels after the issuer could have rotated its grant.
    controller.abort();
    release.resolve();
    const error = await outcome;
    // Then the first failure is already a 401, and another call cannot replay it.
    expect(error).toMatchObject({ code: "dots_auth_refresh_uncertain", status: 401 });
    expect(stored["refreshState"]).toBe("refreshing");
    await expect(auth.refresh(id, persistence)).rejects.toMatchObject({ status: 401 });
    expect(requests).toBe(1);
  });
});

test("a subsequent refresh reads current persisted credentials instead of retaining a stale snapshot", async () => {
  // Given a completed rotation and a later request using the same persistence port.
  let stored = original;
  let requests = 0;
  let reads = 0;
  await fixture(() => {
    requests++; return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3_600 });
  }, async (auth) => {
    const persistence = { read: () => { reads++; return stored; }, save: (value: Credentials) => { stored = value; } };
    await auth.refresh(id, persistence);
    // When another operation asks for current credentials.
    const result = await auth.refresh(id, persistence);
    // Then it re-reads the durable rotated value without another token POST.
    expect(result["refreshToken"]).toBe("rotated");
    expect(reads).toBe(2);
    expect(requests).toBe(1);
  });
});

test("failure to persist the ownership marker prevents transmitting a refresh token", async () => {
  // Given a store that cannot make refresh ownership durable.
  let requests = 0;
  await fixture(() => { requests++; return Response.json({}); }, async (auth) => {
    // When refresh tries to acquire ownership through persistence.
    await expect(auth.refresh(id, {
      read: () => original, save: () => { throw new Error("private-storage-error"); },
    })).rejects.toMatchObject({ code: "dots_auth_storage" });
    // Then the token was never consumed remotely.
    expect(requests).toBe(0);
  });
});

test("an earlier JWT expiry triggers refresh even when stored expiry is later", async () => {
  // Given a JWT expiring sooner than the separately persisted timestamp.
  const payload = Buffer.from(JSON.stringify({ exp: now / 1_000 + 30 })).toString("base64url");
  let stored: Credentials = { ...original, accessToken: `h.${payload}.s`, expiresAt: String(now + 3_600_000) };
  let requests = 0;
  await fixture(() => {
    requests++; return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3_600 });
  }, async (auth) => {
    // When a provider operation requests credentials before JWT expiry.
    const result = await auth.refresh(id, { read: () => stored, save: (value) => { stored = value; } });
    // Then refresh uses the earlier lifetime, not the stale timestamp.
    expect(result["accessToken"]).toBe("new");
    expect(requests).toBe(1);
  });
});

test("an expired access-only account requires reconnect without trying an OAuth grant", async () => {
  // Given a legacy account with a known expired bearer token.
  let requests = 0;
  await fixture(() => { requests++; return Response.json({}); }, async (auth) => {
    // When it is used after expiry.
    await expect(auth.refresh(id, {
      read: () => ({ accessToken: "manual", expiresAt: String(now) }), save: () => undefined,
    })).rejects.toMatchObject({ code: "dots_auth_expired", status: 401 });
    // Then manual credentials are never treated as a refresh token.
    expect(requests).toBe(0);
  });
});
