import { useEffect } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useToastStore, type Toast, type ToastKind } from '@/store/toasts';

const KIND_STYLE: Record<ToastKind, { icon: typeof Info; iconClass: string; barClass: string }> = {
  success: { icon: CheckCircle2, iconClass: 'text-emerald-400', barClass: 'bg-emerald-400/60' },
  error: { icon: AlertCircle, iconClass: 'text-accent-red', barClass: 'bg-accent-red/60' },
  info: { icon: Info, iconClass: 'text-accent-blue', barClass: 'bg-accent-blue/60' },
};

const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  success: 5000,
  info: 5000,
  error: 8000,
};

function ToastCard({ toast: item }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(item.id), AUTO_DISMISS_MS[item.kind]);
    return () => window.clearTimeout(timer);
  }, [item.id, item.kind, dismiss]);

  const { icon: Icon, iconClass, barClass } = KIND_STYLE[item.kind];
  return (
    <div className="panel-elev pointer-events-auto relative flex animate-slide-up items-start gap-3 overflow-hidden p-3.5 pr-9">
      <span className={clsx('absolute inset-y-0 left-0 w-0.5', barClass)} aria-hidden="true" />
      <Icon className={clsx('mt-0.5 h-4 w-4 shrink-0', iconClass)} />
      <div className="min-w-0 flex-1">
        <div className="break-words text-xs font-semibold text-white [overflow-wrap:anywhere]">{item.message}</div>
        {item.detail && (
          <div className="mt-0.5 break-words text-[11px] leading-relaxed text-slate-400 [overflow-wrap:anywhere]">{item.detail}</div>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismiss(item.id)}
        aria-label="Dismiss notification"
        className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-md text-slate-500 transition hover:bg-white/10 hover:text-white"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Fixed bottom-right toast stack. Mount once near the app root. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      role="status"
      className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-full max-w-sm flex-col gap-2 px-4 sm:px-0"
    >
      {toasts.map((item) => <ToastCard key={item.id} toast={item} />)}
    </div>
  );
}
