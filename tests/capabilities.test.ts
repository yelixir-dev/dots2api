import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api";
import { GatewayError } from "../src/contracts";
import type { ProviderAdapter } from "../src/contracts";
import { Gateway } from "../src/gateway";
import { Store } from "../src/store";

const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dots2api-capability-"));
  const store = new Store(dir);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const adapter: ProviderAdapter = {
    info: { id: "dots", name: "dots", description: "Test transport", setupUrl: "https://example.org", fields: [],
      contextWindow: 123456, contextBasis: "configured",
      capabilities: { nativeTools: false, usage: "unknown", execution: "remote-agent" } },
    validate: (credentials) => credentials,
    check: async () => ({ detail: "Connected to fixture." }),
    run: async (_credentials, _prompt, context) => ({
      text: JSON.stringify({ protocol: "dots2api.chat.v1", content: `ran on ${context.accountId}`, tool_calls: [] }),
      remoteId: "r", images: [{ mime: "image/png", data: png }],
    }),
  };
  const gateway = new Gateway(store, { dots: adapter });
  return { dir, store, gateway, app: createApi(gateway) };
}

describe("per-capability account enabling", () => {
  test("routes chat and image work only to accounts with that capability enabled", async () => {
    // Given one chat-only account and one image-only account, both ready.
    const { gateway } = fixture();
    const chatOnly = gateway.create("dots", "Chat", {});
    const imageOnly = gateway.create("dots", "Image", {});
    await gateway.check(chatOnly.id); await gateway.check(imageOnly.id);
    gateway.update(chatOnly.id, { imageEnabled: false });
    gateway.update(imageOnly.id, { chatEnabled: false });
    // When submitting each kind of work by provider.
    const chatJob = gateway.submit({ provider: "dots", capability: "chat", prompt: "hi" });
    const imageJob = gateway.submit({ provider: "dots", capability: "image", prompt: "draw" });
    await gateway.wait(chatJob.id); await gateway.wait(imageJob.id);
    // Then each lands on the matching account, and omitting the capability means chat.
    expect(chatJob.accountId).toBe(chatOnly.id);
    expect(imageJob.accountId).toBe(imageOnly.id);
    expect(gateway.submit({ provider: "dots", prompt: "default" }).accountId).toBe(chatOnly.id);
  });

  test("answers 503 when no account has the requested capability and 409 for an explicit account", async () => {
    // Given a ready account with image generation turned off.
    const { gateway } = fixture();
    const account = gateway.create("dots", "NoImages", {});
    await gateway.check(account.id);
    gateway.update(account.id, { imageEnabled: false });
    // When image work is requested by provider or by that account.
    // Then provider routing finds nothing and the explicit account is refused.
    expect(() => gateway.submit({ provider: "dots", capability: "image", prompt: "x" })).toThrow(GatewayError);
    try { gateway.submit({ provider: "dots", capability: "image", prompt: "x" }); } catch (error) {
      expect((error as GatewayError).code).toBe("no_account");
      expect((error as GatewayError).status).toBe(503);
    }
    try { gateway.submit({ accountId: account.id, capability: "image", prompt: "x" }); } catch (error) {
      expect((error as GatewayError).code).toBe("account_not_ready");
    }
  });

  test("the image endpoint skips chat-only accounts and the chat endpoint skips image-only accounts", async () => {
    // Given only an image-only account.
    const { app, store, gateway } = fixture();
    const account = gateway.create("dots", "ImageOnly", {});
    await gateway.check(account.id);
    gateway.update(account.id, { chatEnabled: false });
    const headers = { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" };
    // When calling both endpoints.
    const chat = await app.request("http://localhost/v1/chat/completions", {
      method: "POST", headers, body: JSON.stringify({ model: "dots-agent", messages: [{ role: "user", content: "hi" }] }),
    });
    const image = await app.request("http://localhost/v1/images/generations", {
      method: "POST", headers, body: JSON.stringify({ prompt: "a dot" }),
    });
    // Then chat is unavailable while image generation succeeds.
    expect(chat.status).toBe(503);
    expect(image.status).toBe(200);
  });

  test("PATCH sets each flag separately and the legacy enabled flag sets both", async () => {
    // Given a fresh account with both capabilities on.
    const { app, store, gateway } = fixture();
    const account = gateway.create("dots", "Patch", {});
    const headers = { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json", origin: "http://localhost", host: "localhost" };
    const patch = async (body: unknown) => {
      const response = await app.request(`http://localhost/api/accounts/${account.id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return (await response.json()).account as { chatEnabled: boolean; imageEnabled: boolean };
    };
    // When patching one flag, then the legacy flag.
    const imageOff = await patch({ imageEnabled: false });
    const bothOff = await patch({ enabled: false });
    const bothOn = await patch({ enabled: true });
    // Then only the named flag changes, and the legacy flag changes both.
    expect(imageOff).toMatchObject({ chatEnabled: true, imageEnabled: false });
    expect(bothOff).toMatchObject({ chatEnabled: false, imageEnabled: false });
    expect(bothOn).toMatchObject({ chatEnabled: true, imageEnabled: true });
  });

  test("reads accounts stored with the old single enabled flag into both capabilities", () => {
    // Given a database whose account body predates chatEnabled and imageEnabled.
    const dir = mkdtempSync(join(tmpdir(), "dots2api-capability-legacy-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const seed = new Store(dir);
    const id = seed.createAccount("dots", "Old", {}).id;
    const db: Database = seed.db;
    const body = db.query<{ body: string }, [string]>("SELECT body FROM accounts WHERE id=?").get(id);
    const { chatEnabled: _chat, imageEnabled: _image, ...legacy } = JSON.parse(body?.body ?? "{}");
    db.query("UPDATE accounts SET body=? WHERE id=?").run(JSON.stringify({ ...legacy, enabled: false }), id);
    seed.close();
    // When the store is reopened.
    const reopened = new Store(dir);
    cleanups.push(() => reopened.close());
    // Then the old flag carries over to both capabilities.
    expect(reopened.account(id)).toMatchObject({ chatEnabled: false, imageEnabled: false });
  });
});
