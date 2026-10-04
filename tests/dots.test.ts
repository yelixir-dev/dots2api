import { expect, test } from "bun:test";
import { z } from "zod";
import { type AdapterContext, accountIdSchema, type Credentials, GatewayError } from "../src/contracts";
import { dotsAdapter } from "../src/providers/dots";

const requestSchema = z.object({
  id: z.number().optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
});
type Request = z.infer<typeof requestSchema>;
type Peer = { send(message: string): void; close(): void };
const context: AdapterContext = {
  accountId: accountIdSchema.parse("00000000-0000-4000-8000-000000000001"),
  dataDir: "/unused",
  signal: new AbortController().signal,
};

async function withServer<T>(
  handler: (peer: Peer, request: Request) => void,
  action: (credentials: Credentials, headers: () => Headers | undefined) => Promise<T>,
): Promise<T> {
  let headers: Headers | undefined;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      headers = request.headers;
      if (!headers.get("user-agent")?.startsWith("codex/")) {
        return new Response("Codex client required", { status: 403 });
      }
      if (server.upgrade(request)) return;
      return new Response("WebSocket required", { status: 426 });
    },
    websocket: {
      message(peer, message) {
        handler(peer, requestSchema.parse(JSON.parse(String(message))));
      },
    },
  });
  const credentials = {
    accessToken: "test-token",
    accountId: "account-42",
    threadId: "dot-thread",
    endpoint: `ws://127.0.0.1:${server.port}`,
  };
  try {
    return await action(credentials, () => headers);
  } finally {
    await server.stop(true);
  }
}

function reply(peer: Peer, request: Request, result: unknown): void {
  peer.send(JSON.stringify({ id: request.id, result }));
}

function handshake(peer: Peer, request: Request): boolean {
  if (request.method === "initialize") {
    reply(peer, request, { userAgent: "test" });
    return true;
  }
  if (request.method === "initialized") return true;
  if (request.method === "thread/read" || request.method === "thread/resume") {
    reply(peer, request, { thread: { id: "dot-thread", threadSource: "aeon" } });
    return true;
  }
  return false;
}

test("check confirms an existing thread with explicit authorization", async () => {
  // Given a local app-server-style WebSocket endpoint.
  await withServer((peer, request) => { handshake(peer, request); }, async (credentials, headers) => {
    // When the account is checked.
    await dotsAdapter.check(credentials, context);
    // Then the selected thread was reachable with only supplied credentials.
    expect(headers()?.get("authorization")).toBe("Bearer test-token");
    expect(headers()?.get("chatgpt-account-id")).toBe("account-42");
  });
});

test("run resumes the selected thread and correlates early completion", async () => {
  const methods: string[] = [];
  // Given competing thread and turn notifications and a completion before the start reply.
  await withServer((peer, request) => {
    methods.push(request.method);
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") {
      expect(request.params.threadId).toBe("dot-thread");
      expect(request.params.input).toEqual([{ type: "text", text: "Hello Dot" }]);
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "other-thread", turn: { id: "turn-1", status: "completed", items: [{ id: "wrong", type: "agentMessage", text: "wrong thread" }] },
      } }));
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "dot-thread", turn: { id: "other-turn", status: "completed", items: [{ id: "wrong", type: "agentMessage", text: "wrong turn" }] },
      } }));
      peer.send(JSON.stringify({ method: "item/completed", params: {
        threadId: "dot-thread", turnId: "turn-1", item: { id: "answer", type: "agentMessage", text: "Actual answer" },
      } }));
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "dot-thread", turn: { id: "turn-1", status: "completed", items: [] },
      } }));
      reply(peer, request, { turn: { id: "turn-1", status: "inProgress" } });
    }
  }, async (credentials) => {
    // When a prompt is sent to the existing thread.
    const result = await dotsAdapter.run(credentials, "Hello Dot", context);
    // Then only its own completed turn is returned; no new thread is created.
    expect(result).toEqual({ text: "Actual answer", remoteId: "turn-1" });
  });
  expect(methods).toEqual(["initialize", "initialized", "thread/read", "thread/resume", "turn/start"]);
});

test("run prefers accepted same-turn ChatGPT delivery over internal completion", async () => {
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method !== "turn/start") return;
    const delivery = {
      id: "delivery", type: "mcpToolCall", tool: "user_message.send_message",
      status: "completed", arguments: { channel: "chatgpt", text: "Delivered answer" },
      error: null, result: { structuredContent: { status: "accepted" } },
    };
    for (const [threadId, turnId, item] of [
      ["other", "turn-1", { ...delivery, id: "wrong-thread" }],
      ["dot-thread", "other", { ...delivery, id: "wrong-turn" }],
      ["dot-thread", "turn-1", { ...delivery, id: "failed", error: "rejected" }],
      ["dot-thread", "turn-1", { ...delivery, id: "other-channel", arguments: { channel: "email", text: "wrong" } }],
      ["dot-thread", "turn-1", delivery],
    ]) {
      peer.send(JSON.stringify({ method: "item/completed", params: { threadId, turnId, item } }));
    }
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "dot-thread", turn: { id: "turn-1", status: "completed", items: [
        delivery, { id: "final", type: "agentMessage", text: "done" },
      ] },
    } }));
    reply(peer, request, { turn: { id: "turn-1" } });
  }, async (credentials) => {
    expect(await dotsAdapter.run(credentials, "Hello", context)).toEqual({
      text: "Delivered answer", remoteId: "turn-1",
    });
  });
});

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const generated = (extra: object = {}) => ({ id: "img-1", type: "imageGeneration", status: "completed", failure: null, ...extra });
const delivered = {
  id: "delivery", type: "mcpToolCall", tool: "user_message.send_message", status: "completed",
  arguments: { channel: "chatgpt", text: "Delivered as a PNG attachment.", library_file_ids: ["libfile_1"] },
  error: null, result: { structuredContent: { status: "accepted" } },
};

test("run returns a generated image carried by the completed turn", async () => {
  // Given a turn whose completed items include the generated image bytes.
  await withServer((peer, request) => {
    if (handshake(peer, request) || request.method !== "turn/start") return;
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "dot-thread", turn: { id: "turn-1", status: "completed", items: [generated({ result: PNG_BASE64 }), delivered] },
    } }));
    reply(peer, request, { turn: { id: "turn-1" } });
  }, async (credentials) => {
    // When the prompt completes.
    const result = await dotsAdapter.run(credentials, "draw", context);
    // Then the text and one real PNG are returned, with no extra download request.
    expect(result.text).toBe("Delivered as a PNG attachment.");
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.mime).toBe("image/png");
  });
});

test("run downloads the image from the turn list when the completed turn omits its bytes", async () => {
  const methods: string[] = [];
  // Given a turn that only reports a delivered attachment, while the full turn list holds the image.
  await withServer((peer, request) => {
    methods.push(request.method);
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") {
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "dot-thread", turn: { id: "turn-1", status: "completed", items: [delivered] },
      } }));
      reply(peer, request, { turn: { id: "turn-1" } });
    }
    if (request.method === "thread/turns/list") {
      expect(request.params).toMatchObject({ threadId: "dot-thread", itemsView: "full" });
      reply(peer, request, { data: [
        { id: "older", items: [generated({ id: "old", result: PNG_BASE64 })] },
        { id: "turn-1", items: [generated({ result: PNG_BASE64 }), generated({ id: "failed", status: "failed", result: PNG_BASE64 })] },
      ] });
    }
  }, async (credentials) => {
    // When the prompt completes.
    const result = await dotsAdapter.run(credentials, "draw", context);
    // Then only this turn's successful image is returned.
    expect(result.images).toHaveLength(1);
  });
  expect(methods).toContain("thread/turns/list");
});

test("run keeps the text and says so when the image cannot be downloaded", async () => {
  // Given a delivered attachment whose image bytes are unavailable from the turn list.
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") {
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "dot-thread", turn: { id: "turn-1", status: "completed", items: [delivered] },
      } }));
      reply(peer, request, { turn: { id: "turn-1" } });
    }
    if (request.method === "thread/turns/list") reply(peer, request, { data: [{ id: "turn-1", items: [] }] });
  }, async (credentials) => {
    // When the prompt completes, then the job is not failed and the loss is visible in the text.
    const result = await dotsAdapter.run(credentials, "draw", context);
    expect(result.text).toContain("Delivered as a PNG attachment.");
    expect(result.text).toContain("could not be downloaded");
    expect(result.images).toBeUndefined();
  });
});

test("run reports uncertain when the connection closes after turn submission", async () => {
  // Given a peer that accepts the turn request but loses the connection before its reply.
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") peer.close();
  }, async (credentials) => {
    // When the turn is submitted.
    const result = dotsAdapter.run(credentials, "Hello", context);
    // Then no successful response is fabricated and repeating the prompt is unsafe.
    await expect(result).rejects.toMatchObject({ uncertain: true, code: "dots_connection" });
  });
});

test("missing credentials and a non-Dot thread fail without submission", async () => {
  // Given no connected account.
  expect(() => dotsAdapter.validate({})).toThrow(GatewayError);
  // When checked or used without explicit credentials, it cannot claim success.
  await expect(dotsAdapter.check({}, context)).rejects.toMatchObject({ code: "dots_unconnected" });
  await expect(dotsAdapter.run({}, "Hello", context)).rejects.toMatchObject({ code: "dots_unconnected" });

  await withServer((peer, request) => {
    if (request.method === "thread/read") {
      reply(peer, request, { thread: { id: "dot-thread", threadSource: "cli" } });
    } else if (request.method === "initialize") {
      reply(peer, request, {});
    } else if (request.method === "turn/start") {
      throw new Error("Unexpected submission");
    }
  }, async (credentials) => {
    await expect(dotsAdapter.run(credentials, "Hello", context)).rejects.toMatchObject({
      code: "dots_thread", uncertain: false,
    });
  });
});

test("check remains unverified when thread source is absent", async () => {
  // Given a reachable thread/read response without an observed Dot identity.
  const methods: string[] = [];
  await withServer((peer, request) => {
    methods.push(request.method);
    if (request.method === "initialize") reply(peer, request, {});
    if (request.method === "thread/read") reply(peer, request, { thread: { id: "dot-thread" } });
  }, async (credentials) => {
    // When the account connection is checked.
    await expect(dotsAdapter.check(credentials, context)).rejects.toMatchObject({
      code: "dots_thread_unverified", uncertain: false,
    });
  });
  // Then a matching thread ID alone cannot mark this account ready.
  expect(methods).toEqual(["initialize", "initialized", "thread/read"]);
});

test("run refuses to submit when thread source is absent", async () => {
  // Given a reachable ordinary thread without the Aeon source marker.
  const methods: string[] = [];
  await withServer((peer, request) => {
    methods.push(request.method);
    if (request.method === "initialize") reply(peer, request, {});
    if (request.method === "thread/read") reply(peer, request, { thread: { id: "dot-thread" } });
  }, async (credentials) => {
    // When a prompt targets that thread.
    await expect(dotsAdapter.run(credentials, "Hello", context)).rejects.toMatchObject({
      code: "dots_thread_unverified", uncertain: false,
    });
  });
  // Then no resume or turn submission occurs.
  expect(methods).toEqual(["initialize", "initialized", "thread/read"]);
});
