import { z } from "zod";
import { GatewayError } from "../../contracts";

/** The app-server is only used for small RPCs (initialize, thread/read); no legitimate frame comes close. */
export const MAX_DOT_FRAME_BYTES = 1024 * 1024;

const responseSchema = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.object({ grpcStatusCode: z.number().optional() }).optional(),
  }).optional(),
});

/** One connection owns one job's RPCs. Notifications are not used by any caller, so none are retained. */
export class DotConnection {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: GatewayError): void;
  }>();
  private closed: GatewayError | undefined;
  readonly ready: Promise<void>;

  constructor(
    private readonly socket: WebSocket,
    signal: AbortSignal,
    private readonly uncertain: () => boolean,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(this.failure()), { once: true });
      socket.addEventListener("close", () => reject(this.failure()), { once: true });
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        this.fail(new GatewayError("dots_protocol", "Dot sent a non-text frame.", 502, uncertain()));
        return;
      }
      if (Buffer.byteLength(event.data) > MAX_DOT_FRAME_BYTES) {
        this.fail(new GatewayError("dots_resource_limit", "Dot sent a frame over the 1 MiB budget.", 502, uncertain()));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        this.fail(new GatewayError("dots_protocol", "Dot sent invalid JSON.", 502, uncertain()));
        return;
      }
      const response = responseSchema.safeParse(parsed);
      if (response.success) {
        const pending = this.pending.get(response.data.id);
        if (!pending) return;
        this.pending.delete(response.data.id);
        if (response.data.error) {
          const { code, message } = response.data.error;
          const missing = response.data.error.data?.grpcStatusCode === 5 || /thread not found/i.test(message);
          pending.reject(new GatewayError(
            missing ? "dots_thread_missing" : "dots_rpc",
            `Dot rejected an RPC request (${code}): ${message}`,
            502,
            uncertain(),
          ));
        } else if (response.data.result === undefined) {
          pending.reject(new GatewayError("dots_protocol", "Dot RPC response has no result.", 502, uncertain()));
        } else {
          pending.resolve(response.data.result);
        }
      }
    });
    socket.addEventListener("close", () => this.fail(this.failure()));
    socket.addEventListener("error", () => this.fail(this.failure()));
    signal.addEventListener("abort", () => {
      this.fail(new GatewayError("dots_timeout", "Dot connection ended before completion.", 504, uncertain()));
    }, { once: true });
    if (signal.aborted) this.fail(new GatewayError("dots_timeout", "Dot connection ended before completion.", 504, uncertain()));
  }

  private failure(): GatewayError {
    return this.closed ?? new GatewayError("dots_connection", "Dot connection closed before completion.", 502, this.uncertain());
  }

  private fail(error: GatewayError): void {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.socket.close();
  }

  request(method: string, params: object): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        this.pending.delete(id);
        reject(new GatewayError("dots_connection", "Dot request could not be sent.", 502, this.uncertain()));
      }
    });
  }

  notify(method: string, params: object): void {
    if (this.closed) throw this.closed;
    this.socket.send(JSON.stringify({ method, params }));
  }

  close(): void {
    this.socket.close();
  }
}
