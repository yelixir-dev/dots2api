import { useEffect, useState } from "react";
import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";
import { cx } from "../lib/format";
import { dismissToast, useToasts } from "../lib/toast";
import type { Toast } from "../lib/toast";
import { IconButton } from "./ui";

const toastIcons = { ok: CircleCheck, info: Info, warn: TriangleAlert, danger: CircleX } as const;

function ToastItem({ toast }: { readonly toast: Toast }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => dismissToast(toast.id), toast.tone === "danger" ? 10_000 : 6_000);
    return () => window.clearTimeout(timer);
  }, [paused, toast.id, toast.tone]);
  const Icon = toastIcons[toast.tone];
  return (
    <div
      role="status"
      className={cx("toast", `toast--${toast.tone}`)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon className="toast__icon" aria-hidden="true" />
      <div className="toast__body">
        <p className="toast__title">{toast.title}</p>
        {toast.message ? <p className="toast__text">{toast.message}</p> : null}
      </div>
      <IconButton label="알림 닫기" icon={<X aria-hidden="true" />} onClick={() => dismissToast(toast.id)} />
    </div>
  );
}

export function ToastRegion() {
  const toasts = useToasts();
  return (
    <section className="toasts" aria-label="알림" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </section>
  );
}
