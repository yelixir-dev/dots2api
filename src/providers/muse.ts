import { fileURLToPath } from "node:url";
import { z } from "zod";
import { GatewayError } from "../contracts";
import type { AdapterContext, Credentials, ProviderAdapter, RunImage } from "../contracts";
import { createMuseAdapter as createBrowserAdapter } from "./muse/engine";

const imageSchema = z.object({
  mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  dataB64: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  revisedPrompt: z.string().optional(),
});
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accepted"), remoteId: z.string().nullable() }),
  z.object({ type: z.literal("credentials"), credentials: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("checked"), detail: z.string() }),
  z.object({ type: z.literal("completed"), text: z.string(), remoteId: z.string().nullable(), images: z.array(imageSchema).default([]) }),
  z.object({ type: z.literal("failed"), code: z.string(), message: z.string(), status: z.number(), uncertain: z.boolean() }),
]);
type Terminal = Exclude<z.infer<typeof eventSchema>, { type: "accepted" } | { type: "credentials" }>;

// Compile our TypeScript worker once; the browser's officially supported Node
// runtime owns all Playwright subprocesses. Credentials travel over stdin only.
let program: Promise<string> | undefined;
function workerProgram(): Promise<string> {
  program ??= Bun.build({
    entrypoints: [fileURLToPath(new URL("./muse/worker.ts", import.meta.url))],
    target: "node", packages: "external",
  }).then(async (build) => {
    if (!build.success || !build.outputs[0]) throw new GatewayError("muse_worker", "Could not compile the Muse browser worker.", 503);
    return build.outputs[0].text();
  });
  return program;
}

// A service manager's PATH is not the interactive shell's PATH, so report a missing or too-old node
// as the runtime problem it is instead of blaming the user's Node.js installation.
let resolvedNode: string | undefined;
function nodeBinary(): string {
  if (resolvedNode) return resolvedNode;
  const node = Bun.which("node");
  if (!node) {
    throw new GatewayError("muse_runtime", "The Muse browser worker needs Node.js 22 or newer, but no \"node\" was found on the gateway service PATH.", 503);
  }
  const version = new TextDecoder().decode(Bun.spawnSync([node, "-v"], { stdout: "pipe" }).stdout).trim();
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? "");
  if (!Number.isInteger(major) || major < 22) {
    throw new GatewayError("muse_runtime", `The Muse browser worker needs Node.js 22 or newer, but the gateway service PATH provides Node.js ${version || node}.`, 503);
  }
  resolvedNode = node;
  return node;
}

async function callWorker(
  operation: "check" | "run",
  site: string,
  chatTimeout: number,
  credentials: Credentials,
  prompt: string,
  context: AdapterContext,
): Promise<Terminal> {
  const node = nodeBinary();
  if (context.signal.aborted) throw new GatewayError("muse_cancelled", "Muse operation cancelled.", 409);
  const child = Bun.spawn([node, "--input-type=module", "--eval", await workerProgram()], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stdin: new Blob([JSON.stringify({
      operation, site, chatTimeout, credentials, prompt, accountId: context.accountId, dataDir: context.dataDir,
    })]),
    stdout: "pipe", stderr: "pipe",
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  };
  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) abort();
  // Drain stderr privately: Chrome diagnostics must not leak paths or credentials to API clients.
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let terminal: Terminal | undefined;
  let buffer = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const event = eventSchema.parse(JSON.parse(line));
        switch (event.type) {
          case "accepted": context.onAccepted?.(event.remoteId); break;
          case "credentials": context.saveCredentials?.(event.credentials); break;
          case "checked":
          case "completed":
          case "failed": terminal = event; break;
        }
      }
    }
    const code = await child.exited;
    await stderr;
    if (code !== 0 || !terminal) throw new GatewayError("muse_worker", "Muse browser worker ended before confirming a result.", 502, operation === "run");
    if (terminal.type === "failed") throw new GatewayError(terminal.code, terminal.message, terminal.status, terminal.uncertain);
    return terminal;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError("muse_worker", "Muse worker response could not be verified.", 502, operation === "run");
  } finally {
    context.signal.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    await stderr;
    reader.releaseLock();
  }
}

export function createMuseAdapter(site = "https://muse.ai", chatTimeout = 300_000): ProviderAdapter {
  const definition = createBrowserAdapter(site, chatTimeout);
  return {
    info: definition.info,
    validate: definition.validate,
    async check(credentials, context) {
      definition.validate(credentials);
      const result = await callWorker("check", site, chatTimeout, credentials, "", context);
      if (result.type !== "checked") throw new GatewayError("muse_worker", "Unexpected Muse check result.", 502);
      return { detail: result.detail };
    },
    async run(credentials, prompt, context) {
      definition.validate(credentials);
      const result = await callWorker("run", site, chatTimeout, credentials, prompt, context);
      if (result.type !== "completed") throw new GatewayError("muse_worker", "Unexpected Muse job result.", 502, true);
      const images: RunImage[] = result.images.map((image) => ({
        mime: image.mime,
        data: new Uint8Array(Buffer.from(image.dataB64, "base64")),
        ...(image.width !== undefined ? { width: image.width } : {}),
        ...(image.height !== undefined ? { height: image.height } : {}),
        ...(image.revisedPrompt !== undefined ? { revisedPrompt: image.revisedPrompt } : {}),
      }));
      return { text: result.text, remoteId: result.remoteId, ...(images.length ? { images } : {}) };
    },
  };
}
export const museAdapter = createMuseAdapter();
