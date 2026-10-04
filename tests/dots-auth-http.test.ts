import { expect, test } from "bun:test";
import { accountIdSchema } from "../src/contracts";
import { DotsAuth } from "../src/dots-auth";

const id = accountIdSchema.parse("00000000-0000-4000-8000-000000000003");

async function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  action: (auth: DotsAuth) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const auth = new DotsAuth({ issuer: `http://127.0.0.1:${server.port}` });
  try { await action(auth); } finally { auth.close(); await server.stop(true); }
}

test("authentication refuses redirects without forwarding secret request bodies", async () => {
  // Given a redirect to a second endpoint on the fixture server.
  let redirected = 0;
  await fixture((request) => {
    if (request.url.endsWith("/leak")) { redirected++; return Response.json({}); }
    return new Response(null, { status: 307, headers: { location: "/leak" } });
  }, async (auth) => {
    // When the authentication server redirects a POST.
    await expect(auth.start(id)).rejects.toMatchObject({ code: "dots_auth_redirect" });
    // Then the follow-up endpoint never receives it.
    expect(redirected).toBe(0);
  });
});

test("authentication bounds a streaming response body without trusting Content-Length", async () => {
  // Given an unbounded-size response arriving as a stream.
  await fixture(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(" ".repeat(65_537)));
      controller.close();
    },
  })), async (auth) => {
    // When parsing would exceed the response limit.
    await expect(auth.start(id)).rejects.toMatchObject({ code: "dots_auth_protocol" });
  });
});

test("authentication deadline covers a response stalled after headers", async () => {
  // Given an incomplete JSON stream: timeout itself is the behavior under test.
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
    })),
  });
  const auth = new DotsAuth({ issuer: `http://127.0.0.1:${server.port}`, timeoutMs: 30 });
  try {
    // When the complete-body deadline elapses, the read is aborted.
    await expect(auth.start(id)).rejects.toMatchObject({ code: "dots_auth_timeout", status: 504 });
  } finally { auth.close(); await server.stop(true); }
});

test("caller cancellation aborts a request at its observed wire event", async () => {
  // Given a request held after the server observes it.
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await fixture(async () => {
    entered.resolve(); await release.promise; return Response.json({});
  }, async (auth) => {
    const controller = new AbortController();
    const started = auth.start(id, controller.signal);
    const outcome = started.catch((error: unknown) => error);
    await entered.promise;
    // When cancellation arrives.
    controller.abort(new Error("private-cancellation-secret"));
    release.resolve();
    // Then only the sanitized cancellation error escapes.
    expect(await outcome).toMatchObject({ code: "dots_auth_cancelled" });
  });
});

test("authentication never retries a rejected POST or leaks its response body", async () => {
  // Given an upstream failure containing values that must remain private.
  let requests = 0;
  await fixture(() => {
    requests++; return new Response("refresh-token-secret device-auth-secret", { status: 503 });
  }, async (auth) => {
    // When the operation fails.
    const result = await auth.start(id).catch((error: unknown) => error);
    // Then no retry happened and neither Error nor JSON output contains server text.
    expect(result).toMatchObject({ code: "dots_auth_start" });
    expect(String(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(requests).toBe(1);
  });
});

for (const issuer of ["https://example.com", "http://auth.openai.com", "https://auth.openai.com.evil.test",
  "https://user:password@auth.openai.com", "https://auth.openai.com/?token=secret"]) {
  test(`authentication rejects an unsafe configured issuer ${issuer}`, () => {
    // Given an untrusted issuer; when configured, reject before any request.
    expect(() => new DotsAuth({ issuer })).toThrow();
  });
}
