import { useEffect, useId, useRef } from "react";
import type { MouseEvent, PointerEvent, ReactNode, RefObject, SyntheticEvent } from "react";
import { X } from "lucide-react";
import { Button, IconButton } from "./ui";

function useModalDialog(ref: RefObject<HTMLDialogElement | null>): void {
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [ref]);
}

function useDismiss(busy: boolean, onClose: () => void) {
  const pressedBackdrop = useRef(false);
  return {
    onCancel(event: SyntheticEvent<HTMLDialogElement>) {
      event.preventDefault();
      if (!busy) onClose();
    },
    // Fires when the browser force-closes the dialog; an effect-driven close is ignored because it
    // is followed by showModal() before the queued event runs.
    onClose(event: SyntheticEvent<HTMLDialogElement>) {
      if (!event.currentTarget.open) onClose();
    },
    onPointerDown(event: PointerEvent<HTMLDialogElement>) {
      pressedBackdrop.current = event.target === event.currentTarget;
    },
    onClick(event: MouseEvent<HTMLDialogElement>) {
      const fromBackdrop = pressedBackdrop.current && event.target === event.currentTarget;
      pressedBackdrop.current = false;
      if (fromBackdrop && !busy) onClose();
    },
  };
}

interface DrawerProps {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly busy?: boolean | undefined;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

export function Drawer({ title, subtitle, busy = false, onClose, children, footer }: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useModalDialog(ref);
  const dismiss = useDismiss(busy, onClose);
  return (
    <dialog ref={ref} className="drawer" aria-labelledby={titleId} {...dismiss}>
      <div className="drawer__panel">
        <header className="drawer__head">
          <div className="drawer__heading">
            <h2 className="drawer__title" id={titleId}>
              {title}
            </h2>
            {subtitle ? <div className="drawer__subtitle">{subtitle}</div> : null}
          </div>
          <IconButton label="닫기" icon={<X aria-hidden="true" />} onClick={onClose} disabled={busy} />
        </header>
        <div className="drawer__body">{children}</div>
        {footer ? <footer className="drawer__foot">{footer}</footer> : null}
      </div>
    </dialog>
  );
}

interface ConfirmDialogProps {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly busy: boolean;
  readonly confirmDisabled?: boolean | undefined;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

export function ConfirmDialog({ title, children, confirmLabel, busy, confirmDisabled = false, onConfirm, onClose }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useModalDialog(ref);
  const dismiss = useDismiss(busy, onClose);
  return (
    <dialog ref={ref} className="confirm" aria-labelledby={titleId} aria-describedby={bodyId} {...dismiss}>
      <h2 className="confirm__title" id={titleId}>
        {title}
      </h2>
      <div className="confirm__body" id={bodyId}>
        {children}
      </div>
      <div className="confirm__actions">
        <Button data-autofocus="" onClick={onClose} disabled={busy}>
          취소
        </Button>
        <Button variant="danger" loading={busy} disabled={confirmDisabled} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
