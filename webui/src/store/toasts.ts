import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

/**
 * Ephemeral (non-persisted) toast queue. Auto-dismiss timing lives in the
 * Toaster component; this store only tracks what is currently visible.
 */
export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId++;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/** Convenience helper for firing a toast outside of React components/hooks. */
export function toast(kind: ToastKind, message: string, detail?: string) {
  return useToastStore.getState().push({ kind, message, detail });
}
