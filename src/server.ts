import { resolve } from "node:path";
import { createApi } from "./api";
import { Gateway } from "./gateway";
import { Store } from "./store";
import { dotsAdapter } from "./providers/dots";
import index from "./web/index.html";
import { DotsAuth } from "./dots-auth";

const store = new Store(resolve(process.env["DOTS2API_DATA_DIR"] ?? "data"));
store.recoverInterruptedJobs();
const dotsAuth = new DotsAuth();
const gateway = new Gateway(store, { dots: dotsAdapter }, dotsAuth);
const api = createApi(gateway, dotsAuth);
let stopping = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env["PORT"] ?? 3010),
  idleTimeout: 255,
  // Context budgets include multilingual text and tool schemas; bytes are not tokens.
  maxRequestBodySize: 16 * 1024 * 1024,
  development: process.env["NODE_ENV"] !== "production",
  routes: { "/": index },
  fetch(request, server) {
    if (stopping) return new Response("Server is shutting down.", { status: 503 });
    // Provider operations have their own bounded deadlines; do not kill a valid login at 255s.
    server.timeout(request, 0);
    return api.fetch(request);
  },
});
console.log(`dots2api ready at ${server.url}`);
console.log("Open the local console to connect accounts. Credentials are stored encrypted in data/.");

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  gateway.stop();
  dotsAuth.close();
  try { await gateway.drain(); }
  finally {
    await server.stop(true);
    store.close();
  }
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
