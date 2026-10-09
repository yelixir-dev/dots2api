import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderAdapter } from "../src/contracts";
import { DotsAuth } from "../src/dots-auth";
import { Gateway } from "../src/gateway";
import { Store } from "../src/store";

test("gateway refreshes stored tokens before adapter validation and uses rotated credentials", async () => {
  // Given a ready account whose token expires inside the refresh window.
  const dir = mkdtempSync(join(tmpdir(), "dots2api-gateway-auth-"));
  const store = new Store(dir);
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    requests++;
    return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 });
  } });
  const auth = new DotsAuth({ issuer: server.url.origin });
  let used = "";
  const adapter: ProviderAdapter = {
    info: { id: "dots", name: "Dots", description: "", fields: [], setupUrl: "https://example.org",
      contextWindow: 272000, contextBasis: "configured",
      capabilities: { nativeTools: false, usage: "unknown", execution: "remote-agent", chat: true } },
    // A transport intentionally drops OAuth metadata, as the real Dots adapter does.
    validate: (value) => ({ accessToken: value["accessToken"] ?? "" }),
    check: async () => ({ detail: "ready" }),
    run: async (value) => { used = value["accessToken"] ?? ""; return { text: "done", remoteId: null }; },
  };
  const gateway = new Gateway(store, { dots: adapter, muse: { ...adapter, info: { ...adapter.info, id: "muse", capabilities: { ...adapter.info.capabilities, chat: false } } } }, auth);
  const account = gateway.create("dots", "Renewable", {
    accessToken: "old-access", refreshToken: "old-refresh", accountId: "workspace",
    threadId: "existing-dot", expiresAt: String(Date.now() + 30_000),
  });
  store.saveAccount({ ...account, status: "ready" });
  try {
    // When the gateway executes the job without a manual connection check.
    const result = await gateway.wait(gateway.submit({ accountId: account.id, prompt: "hello" }).id);
    // Then refresh precedes transport validation and rotated credentials survive it.
    expect(result.status).toBe("completed");
    expect(used).toBe("rotated-access");
    expect(store.credentials(account.id)["refreshToken"]).toBe("rotated-refresh");
    expect(store.credentials(account.id)["threadId"]).toBe("existing-dot");
    expect(requests).toBe(1);
    expect(gateway.account(account.id).busy).toBe(false);
  } finally {
    auth.close(); await server.stop(true); store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
