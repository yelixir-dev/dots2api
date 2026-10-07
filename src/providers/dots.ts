import { z } from "zod";
import { type AdapterContext, type Credentials, GatewayError, type ProviderAdapter, type RunImage } from "../contracts";
import { decodeImage, MAX_IMAGES } from "../images";
import { DotConnection } from "./dots/connection";
import { runViaMessaging } from "./dots/messaging";

const DEFAULT_ENDPOINT = "wss://codex-cloud-backend.chatgpt.com";
const TIMEOUT_MS = 300_000;
const configurationSchema = z.object({
  accessToken: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  endpoint: z.url().optional(),
});
const threadSchema = z.object({
  thread: z.object({ id: z.string(), threadSource: z.string().optional(), canAcceptDirectInput: z.boolean().optional() }),
});
const turnSchema = z.object({
  turn: z.object({ id: z.string().min(1) }),
});
const completedSchema = z.object({
  threadId: z.string(),
  turn: z.object({
    id: z.string(),
    status: z.string(),
    items: z.array(z.unknown()).optional(),
  }),
});
const messageSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.object({
    id: z.string(),
    type: z.literal("agentMessage"),
    text: z.string(),
  }),
});
const agentItemSchema = z.object({
  id: z.string(),
  type: z.literal("agentMessage"),
  text: z.string(),
});
const deliveredMessageSchema = z.object({
  id: z.string(),
  type: z.literal("mcpToolCall"),
  tool: z.literal("user_message.send_message"),
  status: z.literal("completed"),
  arguments: z.object({ channel: z.literal("chatgpt"), text: z.string(), library_file_ids: z.array(z.string()).optional() }),
  error: z.null(),
  result: z.object({
    structuredContent: z.object({ status: z.literal("accepted") }),
  }),
});
const imageItemSchema = z.object({
  type: z.literal("imageGeneration"),
  id: z.string(),
  status: z.string(),
  result: z.string().nullish(),
  revisedPrompt: z.string().nullish(),
});
const turnListSchema = z.object({
  data: z.array(z.object({ id: z.string(), items: z.array(z.unknown()).optional() })),
});
const completedItemSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.unknown(),
});

function config(credentials: Credentials): z.infer<typeof configurationSchema> {
  const result = configurationSchema.safeParse(credentials);
  if (!result.success) {
    throw new GatewayError("dots_unconnected", "Supply a Dot accessToken, accountId and existing threadId.", 401);
  }
  const endpoint = new URL(result.data.endpoint ?? DEFAULT_ENDPOINT);
  if ((endpoint.protocol !== "wss:" && !(endpoint.protocol === "ws:" &&
    (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname === "[::1]"))) ||
    endpoint.username || endpoint.password || endpoint.hash) {
    throw new GatewayError("dots_config", "Use a secure WebSocket endpoint (or loopback for local tests).");
  }
  return result.data;
}

async function withConnection<T>(
  credentials: z.infer<typeof configurationSchema>,
  context: AdapterContext,
  action: (connection: DotConnection, submitted: () => void) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  if (signal.aborted) throw new GatewayError("dots_timeout", "Dot connection ended before submission.", 504);
  let sent = false;
  // DOM's constructor typing masks Bun's custom-header overload; Reflect preserves the runtime overload.
  const socket: WebSocket = Reflect.construct(WebSocket, [credentials.endpoint ?? DEFAULT_ENDPOINT, {
    headers: {
      authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
      originator: "codex_cli_rs",
      "User-Agent": "codex/0.159.2 (Mac OS 26.0.0; arm64)",
    },
  }]);
  const connection = new DotConnection(socket, signal, () => sent);
  try {
    await connection.ready;
    const initialized = await connection.request("initialize", {
      clientInfo: { name: "dots2api", title: "dots2api", version: "0.1.0" },
    });
    if (!z.object({}).safeParse(initialized).success) {
      throw new GatewayError("dots_protocol", "Dot initialization response was invalid.", 502);
    }
    connection.notify("initialized", {});
    return await action(connection, () => { sent = true; });
  } finally {
    connection.close();
  }
}

/** The completed-turn payload may omit the (very large) image bytes; the turn list returns them in full. */
async function turnImages(connection: DotConnection, threadId: string, turnId: string): Promise<RunImage[]> {
  const listed = turnListSchema.safeParse(await connection.request("thread/turns/list", { threadId, limit: 5, itemsView: "full" }));
  if (!listed.success) throw new GatewayError("dots_protocol", "Dot turn list response was invalid.", 502);
  const items = listed.data.data.find((turn) => turn.id === turnId)?.items ?? [];
  return items.flatMap((raw) => {
    const item = imageItemSchema.safeParse(raw);
    const image = item.success && item.data.status === "completed" && item.data.result ? decodeImage(item.data.result) : null;
    return image ? [{ ...image, ...(item.success && item.data.revisedPrompt ? { revisedPrompt: item.data.revisedPrompt } : {}) }] : [];
  });
}

async function existingThread(connection: DotConnection, threadId: string): Promise<boolean> {
  const read = threadSchema.safeParse(await connection.request("thread/read", { threadId }));
  if (!read.success || read.data.thread.id !== threadId) {
    throw new GatewayError("dots_thread", "Existing Dot thread could not be verified.", 404);
  }
  if (!read.data.thread.threadSource) {
    throw new GatewayError("dots_thread_unverified", "Thread response does not identify an Aeon Dot; connection remains unverified.", 502);
  }
  if (read.data.thread.threadSource !== "aeon") {
    throw new GatewayError("dots_thread", "Selected thread is not an Aeon Dot thread.", 400);
  }
  return read.data.thread.canAcceptDirectInput !== false;
}

export const dotsAdapter: ProviderAdapter = {
  info: {
    id: "dots",
    name: "Dots",
    contextWindow: 272_000,
    contextBasis: "configured",
    description: "Continues an explicitly selected existing Dot thread; quota and live compatibility are unverified.",
    fields: [
      { key: "accessToken", label: "Access token", help: "Supply a current account bearer token explicitly; no local auth file is read.", secret: true, required: true },
      { key: "accountId", label: "ChatGPT account ID", help: "Account ID associated with this Dot thread.", secret: false, required: true },
      { key: "threadId", label: "Existing Dot thread ID", help: "Use an existing consumer Dot thread ID; this adapter never creates an Astra thread.", secret: false, required: true },
      { key: "endpoint", label: "WebSocket endpoint", help: "Optional endpoint override; default is the hosted Codex cloud backend.", secret: false, required: false },
    ],
    capabilities: { nativeTools: false, usage: "unknown", execution: "remote-agent" },
    setupUrl: "https://developers.openai.com/codex/app-server/",
  },
  validate(credentials) {
    const settings = config(credentials);
    return { ...settings, endpoint: settings.endpoint ?? DEFAULT_ENDPOINT };
  },
  async check(credentials, context) {
    const settings = config(credentials);
    return withConnection(settings, context, async (connection) => {
      await existingThread(connection, settings.threadId);
      return { detail: "Existing thread reports Aeon Dot identity; live compatibility and quota remain unverified." };
    });
  },
  async run(credentials, prompt, context) {
    const settings = config(credentials);
    if (!prompt.trim()) throw new GatewayError("dots_prompt", "Prompt must not be empty.");
    const legacy = await withConnection(settings, context, async (connection, submitted) => {
      if (!await existingThread(connection, settings.threadId)) return null;
      const resumed = threadSchema.safeParse(await connection.request("thread/resume", { threadId: settings.threadId }));
      if (!resumed.success || resumed.data.thread.id !== settings.threadId) {
        throw new GatewayError("dots_thread", "Dot did not resume the selected thread.", 502);
      }
      // The socket buffers notifications before submission; completion may beat the RPC reply.
      submitted();
      const started = turnSchema.safeParse(await connection.request("turn/start", {
        threadId: settings.threadId,
        input: [{ type: "text", text: prompt }],
      }));
      if (!started.success) throw new GatewayError("dots_protocol", "Dot did not return a turn ID.", 502, true);
      const turnId = started.data.turn.id;
      context.onAccepted?.(turnId);
      const messages = new Map<string, string>();
      const delivered = new Map<string, string>();
      const images = new Map<string, RunImage>();
      let imageMissing = false;
      const noteImage = (raw: unknown): void => {
        const item = imageItemSchema.safeParse(raw);
        if (!item.success || item.data.status !== "completed") return;
        const image = item.data.result ? decodeImage(item.data.result) : null;
        if (image) images.set(item.data.id, { ...image, ...(item.data.revisedPrompt ? { revisedPrompt: item.data.revisedPrompt } : {}) });
        else imageMissing = true;
      };
      while (true) {
        const event = await connection.next();
        if (event.method === "item/completed") {
          const completedItem = completedItemSchema.safeParse(event.params);
          if (completedItem.success && completedItem.data.threadId === settings.threadId && completedItem.data.turnId === turnId) {
            const delivery = deliveredMessageSchema.safeParse(completedItem.data.item);
            if (delivery.success) delivered.set(delivery.data.id, delivery.data.arguments.text);
            noteImage(completedItem.data.item);
          }
          const item = messageSchema.safeParse(event.params);
          if (item.success && item.data.threadId === settings.threadId && item.data.turnId === turnId) {
            messages.set(item.data.item.id, item.data.item.text);
          }
        }
        if (event.method !== "turn/completed") continue;
        const completed = completedSchema.safeParse(event.params);
        if (!completed.success || completed.data.threadId !== settings.threadId || completed.data.turn.id !== turnId) continue;
        if (completed.data.turn.status !== "completed") {
          throw new GatewayError("dots_turn", "Dot turn finished without successful completion.", 502);
        }
        for (const raw of completed.data.turn.items ?? []) {
          const delivery = deliveredMessageSchema.safeParse(raw);
          if (delivery.success) {
            delivered.set(delivery.data.id, delivery.data.arguments.text);
            if (delivery.data.arguments.library_file_ids?.length && images.size === 0) imageMissing = true;
          }
          noteImage(raw);
          const item = agentItemSchema.safeParse(raw);
          if (item.success) messages.set(item.data.id, item.data.text);
        }
        let text = [...(delivered.size ? delivered : messages).values()].join("\n\n").trim();
        if (!text && images.size === 0 && !imageMissing) throw new GatewayError("dots_result", "Dot completed without an agent text response.", 502, true);
        if (imageMissing && images.size === 0) {
          try {
            for (const image of await turnImages(connection, settings.threadId, turnId)) images.set(`list-${images.size}`, image);
          } catch (error) {
            if (!(error instanceof GatewayError)) throw error;
          }
          if (images.size === 0) text += "\n\n[dots2api] The Dot generated an image, but it could not be downloaded; open the Dot thread in ChatGPT.";
        }
        return { text, remoteId: turnId, ...(images.size ? { images: [...images.values()].slice(0, MAX_IMAGES) } : {}) };
      }
    });
    return legacy ?? runViaMessaging(settings, prompt, context);
  },
};
