import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";
import type { Account } from "../../contracts";
import { Drawer } from "../components/dialog";
import { Button, Field, Notice } from "../components/ui";
import { cancelMuseLogin, completeMuseLogin, createAccount, getMuseLogin, startMuseLogin, toApiError } from "../lib/api";
import type { MuseSession } from "../lib/api";
import { gateway } from "../lib/store";
import { notify } from "../lib/toast";

const DEFAULT_SIZE = { width: 1280, height: 800 };
const LABEL_MAX = 80;
const NAMED_KEYS = new Set(["Enter", "Tab", "Backspace", "Escape", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

function drawFrame(canvas: HTMLCanvasElement | null, data: string): void {
  if (!canvas) return;
  const image = new Image();
  image.onload = () => {
    if (canvas.width !== image.width) canvas.width = image.width;
    if (canvas.height !== image.height) canvas.height = image.height;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
  };
  image.src = `data:image/jpeg;base64,${data}`;
}

export function MuseLoginPanel({ account, autostart = false, onConnected, onClose }: {
  readonly account: Account;
  readonly autostart?: boolean;
  readonly onConnected?: () => void;
  readonly onClose: () => void;
}) {
  const [session, setSession] = useState<MuseSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!autostart);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef(DEFAULT_SIZE);
  const started = useRef(false);

  const start = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setSession(await startMuseLogin(account.id));
      await gateway.refresh();
      requestAnimationFrame(() => canvasRef.current?.focus());
    } catch (failure) {
      setError((await toApiError(failure)).message);
    } finally {
      setBusy(false);
    }
  }, [account.id]);

  useEffect(() => {
    if (autostart) {
      if (!started.current) { started.current = true; void start(); }
      return;
    }
    let active = true;
    void getMuseLogin(account.id)
      .then((current) => { if (active) setSession(current); })
      .catch(async (failure: unknown) => { if (active) setError((await toApiError(failure)).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [account.id, autostart, start]);

  useEffect(() => {
    if (!session) return;
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/api/accounts/${encodeURIComponent(account.id)}/muse-login/stream`);
    socketRef.current = socket;
    // Keepalive: a static login page emits no frames, and an idle socket is closed by the server's idleTimeout.
    const keepalive = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "ping" })); }, 20_000);
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { t: string; d?: string; w?: number; h?: number };
      if (message.t === "ready") sizeRef.current = { width: message.w ?? DEFAULT_SIZE.width, height: message.h ?? DEFAULT_SIZE.height };
      else if (message.t === "frame" && message.d) drawFrame(canvasRef.current, message.d);
    };
    socket.onerror = () => setError("뷰어 연결이 끊겼습니다. 세션을 취소하고 다시 시작하세요.");
    return () => { clearInterval(keepalive); socket.close(); socketRef.current = null; };
  }, [session, account.id]);

  function send(event: unknown): void {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }

  function point(event: ReactMouseEvent<HTMLCanvasElement> | ReactWheelEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * sizeRef.current.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * sizeRef.current.height),
    };
  }

  function key(event: ReactKeyboardEvent<HTMLCanvasElement>): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (NAMED_KEYS.has(event.key)) {
      event.preventDefault();
      send({ t: "key", key: event.key, code: event.code, ...(event.key === "Enter" ? { text: "\r" } : {}) });
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      send({ t: "text", text: event.key });
    }
  }

  async function complete(): Promise<void> {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const connected = await completeMuseLogin(account.id, session.id);
      setSession(null);
      await gateway.refresh();
      if (connected.status === "ready") {
        onConnected?.();
        notify("ok", `‘${connected.label}’ 계정을 연결했습니다`, connected.detail || null);
        onClose();
      } else {
        setError(connected.detail || "연결을 확인하지 못했습니다. 원격 브라우저에서 로그인을 마쳤는지 확인하세요.");
      }
    } catch (failure) {
      setError((await toApiError(failure)).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (!session) return;
    setBusy(true);
    try { await cancelMuseLogin(account.id, session.id); }
    catch { notify("warn", "로그인 세션을 정리하지 못했습니다", "잠시 뒤 계정 상태를 다시 확인하세요."); }
    finally { setBusy(false); }
  }

  const running = session !== null;
  return (
    <div className="form">
      <Notice title="원격 브라우저로 로그인">
        서버가 브라우저를 열고 이 창에 그대로 보여 줍니다. 아래 화면에서 Google 로그인을 마친 뒤 ‘로그인 완료 및 연결 확인’을 누르세요.
        로그인하는 동안에는 이 계정의 작업이 잠깁니다.
      </Notice>
      {session ? (
        <Notice title={`세션: ${session.state}`}>
          만료: {new Date(session.expiresAt).toLocaleString()}
          {session.error ? <p>{session.error.message}</p> : null}
        </Notice>
      ) : null}
      {running ? (
        <canvas
          ref={canvasRef}
          className="muse-viewer"
          tabIndex={0}
          aria-label="원격 로그인 화면"
          width={DEFAULT_SIZE.width}
          height={DEFAULT_SIZE.height}
          onMouseDown={(event) => { canvasRef.current?.focus(); const p = point(event); send({ t: "mouse", type: "down", ...p, button: "left", clickCount: 1, buttons: 1 }); }}
          onMouseUp={(event) => { const p = point(event); send({ t: "mouse", type: "up", ...p, button: "left", clickCount: 1, buttons: 0 }); }}
          onMouseMove={(event) => { const p = point(event); send({ t: "mouse", type: "move", ...p, buttons: event.buttons }); }}
          onWheel={(event) => { const p = point(event); send({ t: "wheel", ...p, dx: event.deltaX, dy: event.deltaY }); }}
          onKeyDown={key}
        />
      ) : (
        <p className="section-note">화면을 클릭하면 키보드 입력이 원격 브라우저로 전달됩니다. 뷰어는 이 콘솔과 같은 포트를 쓰므로 추가 SSH 터널이 필요 없습니다.</p>
      )}
      <div className="attention__actions">
        {running ? (
          <>
            <Button disabled={busy} onClick={() => void cancel()}>
              세션 취소
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void complete()}>
              로그인 완료 및 연결 확인
            </Button>
          </>
        ) : (
          <Button variant="primary" loading={busy} disabled={loading} onClick={() => void start()}>
            원격 브라우저 시작
          </Button>
        )}
      </div>
      <div role="alert">{error ? <Notice tone="danger">{error}</Notice> : null}</div>
    </div>
  );
}

export function MuseLoginDrawer({ account, onClose }: { readonly account: Account; readonly onClose: () => void }) {
  return (
    <Drawer title="Muse 원격 로그인" subtitle={account.label} onClose={onClose} footer={<Button onClick={onClose}>닫기</Button>}>
      <MuseLoginPanel account={account} onClose={onClose} />
    </Drawer>
  );
}

export function MuseConnectDrawer({ onClose }: { readonly onClose: () => void }) {
  const formId = useId();
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = useRef(false);

  async function start(): Promise<void> {
    const trimmed = label.trim();
    const nextError = !trimmed ? "라벨을 입력하세요." : trimmed.length > LABEL_MAX ? `${LABEL_MAX}자 이하로 입력하세요.` : null;
    setLabelError(nextError);
    if (nextError) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createAccount({ provider: "muse", label: trimmed, credentials: {} });
      await gateway.refresh();
      setAccount(created);
    } catch (failure) {
      setError((await toApiError(failure)).message);
    } finally {
      setBusy(false);
    }
  }

  async function close(): Promise<void> {
    if (account && !connected.current) {
      try { await gateway.deleteAccount(account.id); }
      catch { notify("warn", "연결하지 못한 계정이 남아 있습니다", "계정 목록에서 삭제하거나 로그인을 다시 진행하세요."); }
    }
    onClose();
  }

  return (
    <Drawer
      title="Muse 계정 추가"
      subtitle={account ? account.label : "라벨을 입력하면 원격 브라우저가 열립니다."}
      busy={busy}
      onClose={() => void close()}
      footer={<Button disabled={busy} onClick={() => void close()}>{account ? "닫기" : "취소"}</Button>}
    >
      {account ? (
        <MuseLoginPanel
          account={account}
          autostart
          onConnected={() => { connected.current = true; }}
          onClose={() => void close()}
        />
      ) : (
        <form id={formId} className="form" noValidate autoComplete="off" onSubmit={(event) => { event.preventDefault(); if (!busy) void start(); }}>
          <Notice title="내 muse.ai 계정으로 로그인">
            라벨을 입력하고 ‘시작’을 누르면 서버가 브라우저를 열어 이 창에 보여 줍니다. 그 화면에서 Google 로그인을 마치면 계정이 연결됩니다.
            별도 쿠키 복사나 SSH 터널이 필요 없습니다.
          </Notice>
          <Field label="라벨" mark="required" error={labelError} hint="목록과 작업 기록에서 이 계정을 구분하는 이름입니다.">
            {(control) => (
              <input
                {...control}
                className="input"
                type="text"
                value={label}
                maxLength={LABEL_MAX}
                placeholder="예: 내 Muse"
                data-autofocus=""
                onChange={(event) => setLabel(event.target.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" loading={busy}>시작</Button>
          <div role="alert">{error ? <Notice tone="danger">{error}</Notice> : null}</div>
        </form>
      )}
    </Drawer>
  );
}
