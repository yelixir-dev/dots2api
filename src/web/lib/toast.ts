import { useSyncExternalStore } from "react";

export type ToastTone = "ok" | "info" | "warn" | "danger";

export interface Toast {
  readonly id: number;
  readonly tone: ToastTone;
  readonly title: string;
  readonly message: string | null;
}

const MAX_TOASTS = 4;
const listeners = new Set<() => void>();
let toasts: readonly Toast[] = [];
let nextId = 1;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notify(tone: ToastTone, title: string, message: string | null = null): void {
  toasts = [...toasts.slice(-(MAX_TOASTS - 1)), { id: nextId, tone, title, message }];
  nextId += 1;
  emit();
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(subscribe, () => toasts);
}
