import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountIdSchema, GatewayError } from "../src/contracts";
import { createMuseAdapter } from "../src/providers/muse";

const accountA = accountIdSchema.parse("11111111-1111-4111-8111-111111111111");
const accountB = accountIdSchema.parse("22222222-2222-4222-8222-222222222222");
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"));
it("rejects reference inputs before launching a browser instead of silently dropping them", async () => {
  const adapter = createMuseAdapter();
  await expect(adapter.run({}, "edit", {
    accountId: accountA, dataDir: "/unused", signal: new AbortController().signal,
    referenceImages: [{ mime: "image/png", data: png }],
  })).rejects.toMatchObject({ code: "unsupported_parameter", status: 422, uncertain: false });
});
const html = `<!doctype html><html><body>
<div role="button" aria-label="Message Send" style="width:100%">
<textarea></textarea><button aria-label="Send" disabled>Send</button></div>
<main role="log" aria-label="Chat messages"></main>
<script>
  const input = document.querySelector("textarea");
  const button = document.querySelector("button");
  input.addEventListener("input", () => { button.disabled = !input.value; });
  button.addEventListener("click", () => {
    document.querySelector("main").innerHTML =
      '<div class="hatch-chat-groupable-bubble chat-user-bubble"></div>' +
      '<button aria-label="Stop">Stop</button>' +
      '<div class="hatch-chat-groupable-bubble hatch-agent-bubble-bg"></div>';
    document.querySelector(".chat-user-bubble").textContent = input.value;
    if (input.value === "disconnect") {
      location.href = "/gone";
      return;
    }
    if (input.value === "once") {
      if (!localStorage.getItem("dots2api-attempted")) {
        localStorage.setItem("dots2api-attempted", "1");
        location.href = "/gone";
        return;
      }
    }
    if (input.value === "partial") document.querySelector('[aria-label="Stop"]').remove();
    queueMicrotask(() => {
      const agent = document.querySelector(".hatch-agent-bubble-bg");
      if (input.value.startsWith("draw")) {
        agent.innerHTML = '<div data-testid="hatch-chat-attachment-presentation-1"><img src="/media/result.png"></div>';
      } else {
        agent.textContent = "A complete answer";
      }
      document.querySelector('[aria-label="Stop"]')?.remove();
      history.replaceState(null, "", "/thread/synthetic-123");
    });
  });
</script></body></html>`;

describe("Muse browser adapter", () => {
  let dataDir: string;
  let server: ReturnType<typeof Bun.serve>;
  let adapter: ReturnType<typeof createMuseAdapter>;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "dots2api-muse-"));
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/session") {
          return Response.json({ status: request.headers.get("cookie")?.includes("hatch_sess=valid") ? "assigned" : "anonymous" });
        }
        if (path === "/media/result.png") return new Response(png, { headers: { "content-type": "image/png" } });
        if (path === "/thread/new") return new Response(html, { headers: { "content-type": "text/html" } });
        return new Response("gone", { headers: { "content-type": "text/html" } });
      },
    });
    adapter = createMuseAdapter(`http://localhost:${server.port}`, 1_000);
  });

  afterAll(async () => {
    server.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  });

  it("confirms chat and assigned session when cookies are imported", async () => {
    // Given an account with explicitly supplied Muse cookies.
    const context = { accountId: accountA, dataDir, signal: new AbortController().signal };
    // When checking the account.
    await adapter.check({ cookieHeader: "hatch_sess=valid; hatch_gw=example" }, context);
    // Then a second authenticated check works from the saved profile alone.
    await expect(adapter.check({}, context)).resolves.toHaveProperty("detail");
  }, 60_000);

  it("does not treat a chat page with HTTP 200 as authenticated", async () => {
    // Given a separate account with no imported cookies or profile.
    const context = { accountId: accountB, dataDir, signal: new AbortController().signal };
    // When checking it.
    const result = adapter.check({}, context);
    // Then a visible chat field alone cannot make it ready.
    await expect(result).rejects.toMatchObject({ code: "muse_auth", status: 401 });
  }, 60_000);

  it("uses the account profile and waits for explicit generation completion", async () => {
    // Given account A's saved profile from an explicit cookie import.
    const context = { accountId: accountA, dataDir, signal: new AbortController().signal };
    await adapter.check({ cookieHeader: "hatch_sess=valid" }, context);
    // When running a fresh thread without re-importing credentials.
    const result = await adapter.run({}, "hello", context);
    // Then only the completed assistant message and thread ID are returned, with no image.
    expect(result).toEqual({ text: "A complete answer", remoteId: "synthetic-123" });
  }, 60_000);

  it("returns a generated image's bytes and size, not an uploaded or historical one", async () => {
    // Given a signed-in account whose turn produces a new attachment.
    const context = { accountId: accountA, dataDir, signal: new AbortController().signal };
    await adapter.check({ cookieHeader: "hatch_sess=valid" }, context);
    // When asking Muse to draw.
    const result = await adapter.run({}, "draw a red dot", context);
    // Then the attachment's real bytes come back as a PNG with its observed size.
    expect(result.remoteId).toBe("synthetic-123");
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.mime).toBe("image/png");
    expect(result.images?.[0]?.width).toBe(1);
    expect(result.images?.[0]?.height).toBe(1);
    expect(Buffer.from(result.images?.[0]?.data ?? []).equals(Buffer.from(png))).toBe(true);
  }, 60_000);

  it("marks a lost acknowledgement after submission uncertain", async () => {
    // Given a signed-in account whose page navigates away on send.
    const context = { accountId: accountA, dataDir, signal: new AbortController().signal };
    await adapter.check({ cookieHeader: "hatch_sess=valid" }, context);
    // When the submission loses its completion signal.
    const result = adapter.run({}, "disconnect", context);
    // Then it cannot report a successful partial answer, and it names the cause and the page it happened on.
    const failure = await result.then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ uncertain: true });
    expect((failure as Error).message).toContain("left the chat thread");
    expect((failure as Error).message).toContain("/gone");
  }, 90_000);

  it("re-verifies the session and retries once when an attempt is uncertain", async () => {
    // Given a signed-in account whose first submission loses its completion signal and whose page recovers afterwards.
    const context = { accountId: accountA, dataDir, signal: new AbortController().signal };
    await adapter.check({ cookieHeader: "hatch_sess=valid" }, context);
    // When the job is submitted.
    const result = await adapter.run({}, "once", context);
    // Then the retry delivers the answer and the record says a retry happened instead of hiding it.
    expect(result.remoteId).toBe("synthetic-123");
    expect(result.text).toContain("[dots2api]");
    expect(result.text).toContain("retried once");
  }, 90_000);

  it("never returns partial text without a confirmed completion transition", async () => {
    // Given an authenticated thread with text but no observed Stop transition.
    const context = { accountId: accountA, dataDir, signal: new AbortController().signal };
    const bounded = createMuseAdapter(`http://localhost:${server.port}`, 500);
    await bounded.check({ cookieHeader: "hatch_sess=valid" }, context);
    // When completion remains unconfirmed through the bounded wait.
    const result = bounded.run({}, "partial", context);
    // Then the reply is uncertain rather than successful.
    await expect(result).rejects.toMatchObject({ code: "muse_uncertain", uncertain: true });
  }, 60_000);

  it("rejects malformed cookie imports without exposing their contents", () => {
    // Given a malformed cookie JSON string.
    // When configuration is parsed.
    // Then a typed failure does not reflect the input.
    expect(() => adapter.validate({ cookieJson: "{private-value" })).toThrow(GatewayError);
  });
});

// A thread page whose side-chat list holds the open thread plus another; deleting removes exactly the confirmed row.
const threadsHtml = `<!doctype html><html><body>
<nav>
  <div data-testid="hatch-thread-row" role="button" data-title="Older chat">Older chat
    <button aria-label="More thread actions">⋯</button></div>
  <div data-testid="hatch-thread-row" role="button" data-title="Current">Current
    <button aria-label="More thread actions">⋯</button></div>
</nav>
<div role="button" aria-label="Message Send"><textarea></textarea><button aria-label="Send" disabled>Send</button></div>
<main role="log" aria-label="Chat messages"></main>
<script>
  const input = document.querySelector("textarea");
  const send = document.querySelector('[aria-label="Send"]');
  input.addEventListener("input", () => { send.disabled = !input.value; });
  send.addEventListener("click", () => {
    document.querySelector("main").innerHTML =
      '<div class="hatch-chat-groupable-bubble chat-user-bubble">u</div><button aria-label="Stop">Stop</button>' +
      '<div class="hatch-chat-groupable-bubble hatch-agent-bubble-bg"></div>';
    queueMicrotask(() => {
      document.querySelector(".hatch-agent-bubble-bg").textContent = "Done";
      document.querySelector('[aria-label="Stop"]').remove();
      history.replaceState(null, "", "/thread/side-1");
      if (!input.value.includes("unmarked")) document.querySelector('[data-title="Current"]').setAttribute("aria-current", "page");
    });
  });
  let target = null;
  document.querySelectorAll('[aria-label="More thread actions"]').forEach((more) => more.addEventListener("click", () => {
    target = more.closest('[data-testid="hatch-thread-row"]');
    document.body.insertAdjacentHTML("beforeend", '<div role="menu"><div role="menuitem">Pin</div><div role="menuitem" id="del">Delete</div></div>');
    document.getElementById("del").addEventListener("click", () => {
      document.querySelector('[role="menu"]').remove();
      document.body.insertAdjacentHTML("beforeend", '<div role="dialog"><p>Delete side chat?</p><button>Cancel</button><button id="ok">Delete</button></div>');
      document.getElementById("ok").addEventListener("click", () => {
        // Synchronous, so the server has recorded the deletion before the dialog closes and the browser can shut down.
        const record = new XMLHttpRequest();
        record.open("POST", "/deleted/" + encodeURIComponent(target.dataset.title), false);
        record.send();
        target.remove();
        document.querySelector('[role="dialog"]').remove();
      });
    });
  }));
</script></body></html>`;

describe("Muse side-chat pruning", () => {
  let dataDir: string;
  let server: ReturnType<typeof Bun.serve>;
  let site: string;
  const deleted: string[] = [];
  const account = accountIdSchema.parse("44444444-4444-4444-8444-444444444444");
  const context = () => ({ accountId: account, dataDir, signal: new AbortController().signal });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "dots2api-muse-prune-"));
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/session") return Response.json({ status: "assigned" });
        if (path.startsWith("/deleted/")) { deleted.push(decodeURIComponent(path.slice("/deleted/".length))); return new Response("ok"); }
        if (path === "/thread/new") return new Response(threadsHtml, { headers: { "content-type": "text/html" } });
        return new Response("gone", { headers: { "content-type": "text/html" } });
      },
    });
    site = `http://localhost:${server.port}`;
    await createMuseAdapter(site, 2_000, false).check({ cookieHeader: "hatch_sess=valid" }, context());
  });

  afterAll(async () => {
    server.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  });

  it("leaves every side chat in place when pruning is off", async () => {
    // Given pruning switched off.
    deleted.length = 0;
    // When a job completes.
    const result = await createMuseAdapter(site, 2_000, false).run({}, "hello", context());
    // Then the job succeeds and nothing is deleted.
    expect(result).toEqual({ text: "Done", remoteId: "side-1" });
    expect(deleted).toEqual([]);
  }, 60_000);

  it("deletes only the side chat this job opened when pruning is on", async () => {
    // Given pruning switched on.
    deleted.length = 0;
    // When a job completes.
    const result = await createMuseAdapter(site, 2_000, true).run({}, "hello", context());
    // Then the result is unchanged and only the open thread's row was deleted, never the other chat.
    expect(result).toEqual({ text: "Done", remoteId: "side-1" });
    expect(deleted).toEqual(["Current"]);
  }, 60_000);

  it("deletes nothing when no row is marked as the open thread", async () => {
    // Given pruning on but Muse never marking which row is the open thread.
    deleted.length = 0;
    // When a job completes.
    const result = await createMuseAdapter(site, 2_000, true).run({}, "hello unmarked", context());
    // Then the job still succeeds and no row is guessed at.
    expect(result).toEqual({ text: "Done", remoteId: "side-1" });
    expect(deleted).toEqual([]);
  }, 60_000);
});

describe("Muse session self-heal", () => {
  let dataDir: string;
  let server: ReturnType<typeof Bun.serve>;
  let wakes = 0;
  let assigned = false;
  const account = accountIdSchema.parse("33333333-3333-4333-8333-333333333333");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "dots2api-muse-heal-"));
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        const authed = request.headers.get("cookie")?.includes("hatch_sess=valid") ?? false;
        if (path === "/api/session") {
          if (!authed) return Response.json({ status: "anonymous" });
          return Response.json(
            assigned ? { status: "assigned", vm_id: "vm-1", vm_state: "RUNNING" } : { status: "sleeping", vm_id: "vm-1", vm_state: "SLEEPING" },
            { headers: { "set-cookie": "hatch_vml=renewed; Path=/; HttpOnly" } },
          );
        }
        if (path === "/api/hatch/vm/wake" && request.method === "POST") { wakes++; assigned = true; return Response.json({ ok: true }); }
        if (path === "/thread/new") return new Response(html, { headers: { "content-type": "text/html" } });
        return new Response("gone", { headers: { "content-type": "text/html" } });
      },
    });
  });

  afterAll(async () => {
    server.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  });

  it("wakes a slept workspace VM and persists the renewed session cookies", async () => {
    // Given an account whose session is unassigned because the workspace VM slept.
    assigned = false; wakes = 0;
    const heal = createMuseAdapter(`http://localhost:${server.port}`, 1_000);
    const captured: { credentials: Record<string, string> | null } = { credentials: null };
    const context = { accountId: account, dataDir, signal: new AbortController().signal, saveCredentials: (value: Record<string, string>) => { captured.credentials = value; } };
    // When checking the account.
    const result = await heal.check({ cookieHeader: "hatch_sess=valid" }, context);
    // Then the VM was woken, the session became assigned, and the renewed cookie is stored back.
    expect(result.detail).toContain("assigned");
    expect(wakes).toBe(1);
    expect(captured.credentials?.cookieHeader).toContain("hatch_vml=renewed");
  }, 60_000);

  it("requires a reconnect when the workspace can never be assigned", async () => {
    // Given an account whose workspace is permanently disabled.
    const disabled = Bun.serve({ port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/session") return Response.json({ status: "sleeping", vm_id: "vm-1", vm_state: "DISABLED" });
      if (path === "/thread/new") return new Response(html, { headers: { "content-type": "text/html" } });
      return new Response("gone");
    } });
    const heal = createMuseAdapter(`http://localhost:${disabled.port}`, 1_000);
    const context = { accountId: account, dataDir, signal: new AbortController().signal };
    try {
      // When checking it, then it cannot report ready.
      await expect(heal.check({ cookieHeader: "hatch_sess=valid" }, context)).rejects.toMatchObject({ code: "muse_auth", status: 401 });
    } finally { disabled.stop(true); }
  }, 60_000);
});
