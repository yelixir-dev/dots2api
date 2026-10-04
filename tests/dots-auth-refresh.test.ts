import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountIdSchema, type Credentials } from "../src/contracts";
import { DotsAuth } from "../src/dots-auth";
import { Store } from "../src/store";

const id = accountIdSchema.parse("00000000-0000-4000-8000-000000000002");
const now = 1_800_000_000_000;
const original: Credentials = {
  accessToken: "old-access", refreshToken: "old-refresh", accountId: "workspace-42",
  expiresAt: String(now + 30_000), threadId: "existing-dot", endpoint: "wss://codex-cloud-backend.chatgpt.com",
};
const rotated = { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3_600 };

async function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  action: (auth: DotsAuth, issuer: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const issuer = `http://127.0.0.1:${server.port}`;
  const auth = new DotsAuth({ issuer, now: () => now });
  try { await action(auth, issuer); } finally { auth.close(); await server.stop(true); }
}

test("refresh durably rotates encrypted credentials before returning", async () => {
  // Given the real encrypted store and a token inside the pre-expiry window.
  const dir = mkdtempSync(join(tmpdir(), "dots-auth-"));
  const store = new Store(dir);
  const account = store.createAccount("dots", "Fixture", original);
  let body: unknown;
  let marker: string | undefined;
  try {
    await fixture(async (request) => {
      body = await request.json();
      marker = store.credentials(account.id)["refreshState"];
      expect(new URL(request.url).pathname).toBe("/oauth/token");
      return Response.json(rotated);
    }, async (auth) => {
      // When the sole owner refreshes through persistence callbacks.
      const result = await auth.refresh(account.id, {
        read: () => store.credentials(account.id),
        save: (value) => { store.saveAccount(account, value); },
      });
      // Then the real store has rotated tokens, retained configuration, and no pending marker.
      expect(marker).toBe("refreshing");
      expect(body).toEqual({ grant_type: "refresh_token", client_id: "app_EMoamEEZ73f0CkXaXp7hrann", refresh_token: "old-refresh" });
      expect(store.credentials(account.id)).toEqual(result);
      expect(result).toEqual({
        ...original, accessToken: "new-access", refreshToken: "new-refresh",
        expiresAt: String(now + 3_600_000), refreshState: "ready",
      });
      const rows = store.db.query<{ credentials: string }, []>("SELECT credentials FROM accounts").all();
      expect(JSON.stringify(rows)).not.toContain("new-refresh");
      expect(store.accounts()[0]).not.toHaveProperty("refreshToken");
    });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent refresh waits for final persistence and sends one rotating grant", async () => {
  // Given a save callback paused exactly before publishing new credentials.
  let stored = original;
  let requests = 0;
  const saving = Promise.withResolvers<void>();
  const publish = Promise.withResolvers<void>();
  const persistence = {
    read: () => stored,
    save: async (value: Credentials) => {
      if (value["refreshState"] === "ready") { saving.resolve(); await publish.promise; }
      stored = value;
    },
  };
  await fixture(() => { requests++; return Response.json(rotated); }, async (auth) => {
    // When a second caller arrives while persistence remains unfinished.
    const first = auth.refresh(id, persistence);
    await saving.promise;
    const second = auth.refresh(id, persistence);
    expect(first).toBe(second);
    expect(stored["refreshState"]).toBe("refreshing");
    publish.resolve();
    const results = await Promise.all([first, second]);
    // Then both return only after the new refresh token is durable.
    expect(results).toEqual([stored, stored]);
    expect(stored["refreshToken"]).toBe("new-refresh");
    expect(requests).toBe(1);
  });
});

for (const error of ["invalid_grant", "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"]) {
  test(`refresh quarantines ${error} without exposing upstream secrets or replaying`, async () => {
    // Given an issuer-rejected rotating grant.
    let stored = original;
    let requests = 0;
    await fixture(() => {
      requests++;
      return Response.json({ error: { code: error, message: "old-refresh upstream-secret" } }, { status: 400 });
    }, async (auth) => {
      const persistence = { read: () => stored, save: (value: Credentials) => { stored = value; } };
      // When concurrent callers and a subsequent caller request the same rejected grant.
      const results = await Promise.allSettled([auth.refresh(id, persistence), auth.refresh(id, persistence)]);
      await expect(auth.refresh(id, persistence)).rejects.toMatchObject({ code: "dots_auth_revoked" });
      // Then revocation is durable and there is only one token POST.
      expect(stored["refreshState"]).toBe("revoked");
      expect(requests).toBe(1);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({ code: "dots_auth_revoked", status: 401 });
          expect(String(result.reason)).not.toContain("upstream-secret");
          expect(JSON.stringify(result.reason)).not.toContain("old-refresh");
        }
      }
    });
  });
}

test("a lost rotation response stays quarantined after service restart", async () => {
  // Given a malformed success response after the issuer may have consumed the grant.
  let stored = original;
  let requests = 0;
  await fixture(() => { requests++; return Response.json({ broken: "response" }); }, async (auth, issuer) => {
    const persistence = { read: () => stored, save: (value: Credentials) => { stored = value; } };
    await expect(auth.refresh(id, persistence)).rejects.toMatchObject({ code: "dots_auth_refresh_uncertain", status: 401 });
    auth.close();
    const restarted = new DotsAuth({ issuer, now: () => now });
    try {
      // When a new service reads the persisted in-flight marker.
      await expect(restarted.refresh(id, persistence)).rejects.toMatchObject({ code: "dots_auth_refresh_uncertain" });
      // Then it never replays the possibly consumed token.
      expect(stored["refreshState"]).toBe("refreshing");
      expect(requests).toBe(1);
    } finally { restarted.close(); }
  });
});

test("failed final persistence never causes a consumed token to be retried", async () => {
  // Given storage that accepts the preflight marker but fails to publish new tokens.
  let stored = original;
  let requests = 0;
  const persistence = {
    read: () => stored,
    save: (value: Credentials) => {
      if (value["refreshState"] === "ready") throw new Error("new-refresh storage-secret");
      stored = value;
    },
  };
  await fixture(() => { requests++; return Response.json(rotated); }, async (auth) => {
    // When refresh is retried after storage failure.
    await expect(auth.refresh(id, persistence)).rejects.toMatchObject({ code: "dots_auth_refresh_uncertain", status: 401 });
    await expect(auth.refresh(id, persistence)).rejects.toMatchObject({ code: "dots_auth_refresh_uncertain" });
    // Then the prior grant is not reused.
    expect(requests).toBe(1);
  });
});

for (const credentials of [
  { accessToken: "manual-token", accountId: "workspace-42", threadId: "legacy" },
  { ...original, expiresAt: String(now + 61_000) },
]) {
  test(`refresh passes through ${credentials["accessToken"]} when no refresh is needed`, async () => {
    // Given a manual legacy account or a still-current renewable account.
    let requests = 0;
    let saves = 0;
    await fixture(() => { requests++; return Response.json(rotated); }, async (auth) => {
      // When credentials are requested.
      const result = await auth.refresh(id, { read: () => credentials, save: () => { saves++; } });
      // Then no network or persistence action occurs.
      expect(result).toEqual(credentials);
      expect(requests).toBe(0);
      expect(saves).toBe(0);
    });
  });
}

test("refresh retains an unrotated refresh token when the issuer omits its replacement", async () => {
  // Given a valid access token response with no rotated refresh field.
  let stored = original;
  await fixture(() => Response.json({ access_token: "next-access", expires_in: 3_600 }), async (auth) => {
    // When the new access token is saved.
    const result = await auth.refresh(id, { read: () => stored, save: (value) => { stored = value; } });
    // Then the still-valid refresh token and selected Dot configuration are preserved.
    expect(result).toMatchObject({ accessToken: "next-access", refreshToken: "old-refresh", threadId: "existing-dot" });
  });
});
