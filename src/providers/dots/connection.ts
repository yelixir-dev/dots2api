import { z } from "zod";
import { GatewayError } from "../../contracts";

const responseSchema = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
const notificationSchema = z.object({
  method: z.string(),
  params: z.unknown(),
});

export type Notification = z.infer<typeof notificationSchema>;

/** One connection owns one job; notifications are buffered from before turn submission. */
export class DotConnection {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: GatewayError): void;
  }>();
  private readonly notifications: Notification[] = [];
  private waiting: {
    resolve(value: Notification): void;
    reject(error: GatewayError): void;
  } | undefined;
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
          pending.reject(new GatewayError("dots_rpc", "Dot rejected an RPC request.", 502, uncertain()));
        } else if (response.data.result === undefined) {
          pending.reject(new GatewayError("dots_protocol", "Dot RPC response has no result.", 502, uncertain()));
        } else {
          pending.resolve(response.data.result);
        }
        return;
      }
      const notification = notificationSchema.safeParse(parsed);
      if (notification.success) {
        const waiter = this.waiting;
        if (waiter) {
          this.waiting = undefined;
          waiter.resolve(notification.data);
        } else {
          this.notifications.push(notification.data);
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
    this.waiting?.reject(error);
    this.waiting = undefined;
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

  next(): Promise<Notification> {
    const notification = this.notifications.shift();
    if (notification) return Promise.resolve(notification);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise<Notification>((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  close(): void {
    this.socket.close();
  }
}
