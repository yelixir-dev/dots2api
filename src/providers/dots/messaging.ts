import { z } from "zod";
import { type AdapterContext, GatewayError, type RunImage, type RunResult } from "../../contracts";
import { MAX_IMAGE_BYTES, MAX_IMAGES, sniffImage } from "../../images";

/**
 * Post-cutover Dots no longer accept `turn/start` on the codex-cloud app-server
 * (the legacy thread reads fine but reports `canAcceptDirectInput: false`).
 * The ChatGPT web client talks to the same Dot through the messaging rooms API,
 * which accepts the device-login token with Codex client headers.
 */
const BASE = "https://chatgpt.com/backend-api/messaging";
const POLL_MS = 3_000;
const TIMEOUT_MS = 300_000;

const roomsSchema = z.object({
  items: z.array(z.object({ id: z.string(), type: z.string().optional(), aeon_id: z.string().nullish() })),
});
const attachmentSchema = z.object({
  file: z.object({ download_url: z.string().url().optional(), mime_type: z.string().optional() }).nullish(),
}).nullish();
const messageSchema = z.object({
  id: z.string(),
  account_user_id: z.string().nullish(),
  request_id: z.string().nullish(),
  content: z.object({ text: z.string().nullish(), attachments: z.array(attachmentSchema).nullish() }).nullish(),
});
const messagesSchema = z.object({ items: z.array(messageSchema) });

export interface MessagingSettings {
  readonly accessToken: string;
  readonly accountId: string;
  readonly roomId?: string | undefined;
}

function headers(settings: MessagingSettings): Record<string, string> {
  return {
    authorization: `Bearer ${settings.accessToken}`,
    "chatgpt-account-id": settings.accountId,
    originator: "codex_cli_rs",
    "User-Agent": "codex/0.159.2 (Mac OS 26.0.0; arm64)",
    "content-type": "application/json",
  };
}

async function call<T>(settings: MessagingSettings, path: string, schema: z.ZodType<T>, signal: AbortSignal, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { ...init, headers: headers(settings), redirect: "error", signal });
  } catch {
    throw new GatewayError("dots_messaging", "Dot messaging request failed.", 502, true);
  }
  if (!response.ok) throw new GatewayError("dots_messaging", `Dot messaging returned HTTP ${response.status}.`, 502, true);
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new GatewayError("dots_protocol", "Dot messaging response was invalid.", 502, true);
  return parsed.data;
}

async function resolveRoom(settings: MessagingSettings, signal: AbortSignal): Promise<string> {
  if (settings.roomId) return settings.roomId;
  const rooms = (await call(settings, "/rooms", roomsSchema, signal)).items.filter((room) => room.aeon_id);
  if (rooms.length !== 1) {
    throw new GatewayError("dots_room", "Could not choose a single Dot room; set roomId on the account.", 409);
  }
  return rooms[0]!.id;
}

async function download(settings: MessagingSettings, url: string, signal: AbortSignal): Promise<RunImage | null> {
  if (new URL(url).origin !== "https://chatgpt.com") return null;
  const response = await fetch(url, { headers: headers(settings), redirect: "error", signal }).catch(() => null);
  if (!response?.ok) return null;
  const data = new Uint8Array(await response.arrayBuffer());
  const mime = sniffImage(data);
  return mime && data.byteLength <= MAX_IMAGE_BYTES ? { mime, data } : null;
}

export async function runViaMessaging(settings: MessagingSettings, prompt: string, context: AdapterContext): Promise<RunResult> {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const room = await resolveRoom(settings, signal);
  const requestId = crypto.randomUUID();
  const sent = await call(settings, `/rooms/${room}/messages`, messageSchema, signal, {
    method: "POST",
    body: JSON.stringify({
      content: { text: prompt },
      request_id: requestId,
      page_context: { page_id: null },
      idempotency_token: crypto.randomUUID(),
      timezone_offset_min: new Date().getTimezoneOffset(),
    }),
  });
  context.onAccepted?.(sent.id);
  const self = sent.account_user_id;
  while (true) {
    if (signal.aborted) throw new GatewayError("dots_timeout", "Dot did not reply in time.", 504, true);
    await Bun.sleep(POLL_MS);
    const { items } = await call(settings, `/rooms/${room}/messages?limit=10`, messagesSchema, signal);
    const index = items.findIndex((item) => item.request_id === requestId || item.id === sent.id);
    if (index < 0) continue;
    const reply = items.slice(index + 1).find((item) => item.account_user_id !== self);
    if (!reply) continue;
    const images: RunImage[] = [];
    for (const attachment of reply.content?.attachments ?? []) {
      const url = attachment?.file?.download_url;
      if (!url || images.length >= MAX_IMAGES) continue;
      const image = await download(settings, url, signal);
      if (image) images.push(image);
    }
    const text = (reply.content?.text ?? "").trim();
    if (!text && images.length === 0) throw new GatewayError("dots_result", "Dot replied without text or images.", 502, true);
    return { text, remoteId: reply.id, ...(images.length ? { images } : {}) };
  }
}
