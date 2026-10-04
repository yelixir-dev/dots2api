import { expect, test } from "bun:test";
import { accountIdSchema } from "../src/contracts";
import { DotsAuth } from "../src/dots-auth";

const id = accountIdSchema.parse("00000000-0000-4000-8000-000000000001");
const epoch = 1_800_000_000_000;
const jwt = (body: unknown) => `header.${Buffer.from(JSON.stringify(body)).toString("base64url")}.signature`;
const tokens = {
  access_token: jwt({ exp: epoch / 1_000 + 3_600, "https://api.openai.com/auth": { chatgpt_account_id: "workspace-42" } }),
  id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "workspace-42" } }),
  refresh_token: "refresh-secret", token_type: "Bearer",
};
const device = { device_auth_id: "device-secret", user_code: "ABCD-EFGH", interval: "5" };
const authorization = { authorization_code: "code-secret", code_verifier: "verifier-secret", code_challenge: "challenge" };

async function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  action: (auth: DotsAuth, clock: { now: number }) => Promise<void>,
): Promise<void> {
  const clock = { now: epoch };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const auth = new DotsAuth({ issuer: `http://127.0.0.1:${server.port}`, now: () => clock.now });
  try { await action(auth, clock); } finally { auth.close(); await server.stop(true); }
}

test("device login exchanges the official wire grants and returns renewable account credentials", async () => {
  // Given an official-protocol fixture, including private device and PKCE fields.
  const requests: { path: string; type: string | null; body: string }[] = [];
  await fixture(async (request) => {
    const path = new URL(request.url).pathname;
    requests.push({ path, type: request.headers.get("content-type"), body: await request.text() });
    if (path.endsWith("/usercode")) return Response.json(device);
    if (path.endsWith("/deviceauth/token")) return Response.json(authorization);
    return Response.json(tokens);
  }, async (auth) => {
    // When login is started and completed.
    const start = await auth.start(id);
    const result = await auth.finish(id);
    // Then only verification details are safe to return from start.
    expect(start).toMatchObject({ userCode: "ABCD-EFGH", expiresAt: epoch + 900_000, pollIntervalMs: 5_000 });
    expect(new URL(start.verificationUrl).pathname).toBe("/codex/device");
    expect(JSON.stringify(start)).not.toContain("device-secret");
    expect(result).toEqual({ status: "connected", credentials: {
      accessToken: tokens.access_token, refreshToken: "refresh-secret", idToken: tokens.id_token,
      accountId: "workspace-42", expiresAt: String(epoch + 3_600_000), refreshState: "ready",
    } });
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
    expect(JSON.parse(requests[1]?.body ?? "")).toEqual({ device_auth_id: "device-secret", user_code: "ABCD-EFGH" });
    const exchange = new URLSearchParams(requests[2]?.body);
    expect(requests[2]?.type).toContain("application/x-www-form-urlencoded");
    expect(Object.fromEntries(exchange)).toEqual({
      grant_type: "authorization_code", client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code: "code-secret", code_verifier: "verifier-secret",
      redirect_uri: new URL("/deviceauth/callback", start.verificationUrl).href,
    });
  });
});

for (const status of [403, 404]) {
  test(`device login remains pending on HTTP ${status} and enforces the server interval`, async () => {
    // Given the documented pending response and a controlled clock.
    let polls = 0;
    await fixture((request) => {
      if (request.url.endsWith("/usercode")) return Response.json(device);
      polls++;
      return new Response("pending", { status });
    }, async (auth, clock) => {
      await auth.start(id);
      // When repeated finish calls arrive before the next allowed poll.
      const first = await auth.finish(id);
      clock.now += 1_000;
      const second = await auth.finish(id);
      // Then only one wire poll occurred and no credentials escaped.
      expect(first).toEqual({ status: "pending", retryAfterMs: 5_000 });
      expect(second).toEqual({ status: "pending", retryAfterMs: 4_000 });
      expect(polls).toBe(1);
    });
  });
}

test("device expiry prevents another poll without timing sleeps", async () => {
  // Given a device session at its exact expiration.
  let requests = 0;
  await fixture(() => { requests++; return Response.json(device); }, async (auth, clock) => {
    await auth.start(id);
    clock.now += 900_000;
    // When completion is requested.
    await expect(auth.finish(id)).rejects.toMatchObject({ code: "dots_auth_expired" });
    // Then only the start request reached the network.
    expect(requests).toBe(1);
  });
});

test("concurrent completion shares one poll and one single-use exchange", async () => {
  // Given a poll held until all callers have subscribed.
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let polls = 0;
  let exchanges = 0;
  await fixture(async (request) => {
    if (request.url.endsWith("/usercode")) return Response.json(device);
    if (request.url.endsWith("/deviceauth/token")) {
      polls++; entered.resolve(); await release.promise; return Response.json(authorization);
    }
    exchanges++; return Response.json(tokens);
  }, async (auth) => {
    await auth.start(id);
    // When a second completion joins an in-flight first completion.
    const first = auth.finish(id);
    await entered.promise;
    const second = auth.finish(id);
    release.resolve();
    const result = await Promise.all([first, second]);
    // Then both observe the same credentials and there was only one grant exchange.
    expect(result[0]).toEqual(result[1]);
    expect(polls).toBe(1);
    expect(exchanges).toBe(1);
  });
});

test("clearing a device session cancels a held poll without token exchange", async () => {
  // Given a response held at an exact wire event.
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let exchanges = 0;
  await fixture(async (request) => {
    if (request.url.endsWith("/usercode")) return Response.json(device);
    if (request.url.endsWith("/deviceauth/token")) {
      entered.resolve(); await release.promise; return Response.json(authorization);
    }
    exchanges++; return Response.json(tokens);
  }, async (auth) => {
    await auth.start(id);
    const finish = auth.finish(id);
    const outcome = finish.catch((error: unknown) => error);
    await entered.promise;
    // When the account is deleted or login is cancelled.
    auth.clear(id);
    release.resolve();
    expect(await outcome).toMatchObject({ code: "dots_auth_cancelled" });
    // Then the authorization code is not exchanged.
    expect(exchanges).toBe(0);
  });
});

test("a failed code exchange cannot be replayed by another finish call", async () => {
  // Given a single-use exchange whose response is invalid.
  let exchanges = 0;
  await fixture((request) => {
    if (request.url.endsWith("/usercode")) return Response.json(device);
    if (request.url.endsWith("/deviceauth/token")) return Response.json(authorization);
    exchanges++; return Response.json({ access_token: "incomplete-secret" });
  }, async (auth) => {
    await auth.start(id);
    // When completion is retried after a protocol failure.
    await expect(auth.finish(id)).rejects.toMatchObject({ code: "dots_auth_account" });
    await expect(auth.finish(id)).rejects.toMatchObject({ code: "dots_auth_expired" });
    // Then no one-time grant was replayed.
    expect(exchanges).toBe(1);
  });
});

test("device login rejects mismatched access and identity token accounts", async () => {
  // Given a response that cannot identify a single account.
  await fixture((request) => {
    if (request.url.endsWith("/usercode")) return Response.json(device);
    if (request.url.endsWith("/deviceauth/token")) return Response.json(authorization);
    return Response.json({ ...tokens, id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "other" } }) });
  }, async (auth) => {
    await auth.start(id);
    // When the code is exchanged, no credentials are returned.
    await expect(auth.finish(id)).rejects.toMatchObject({ code: "dots_auth_account" });
  });
});
