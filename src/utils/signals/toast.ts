import { signal } from "@preact/signals-react";

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info";
}

export const toasts = signal<Toast[]>([]);

export function showToast(
  message: string,
  type: "success" | "error" | "info" = "info",
) {
  const id = Math.random().toString(36).slice(2, 11);
  const toast: Toast = { id, message, type };

  toasts.value = [...toasts.value, toast];

  // Auto-dismiss after 3 seconds
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 3000);
}

export function dismissToast(id: string) {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
