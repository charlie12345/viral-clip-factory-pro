import type { ReactNode } from 'react';
import { clsx } from 'clsx';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  /** Optional action slot rendered below the text (buttons, links). */
  action?: ReactNode;
  /** Use the `.panel-elev` surface (default true). */
  elevated?: boolean;
  className?: string;
}

/** Icon + title + body + optional action, on a panel surface. */
export function EmptyState({ icon, title, body, action, elevated = true, className }: EmptyStateProps) {
  return (
    <div className={clsx(elevated ? 'panel-elev' : 'panel', 'grid place-items-center gap-3 py-16 text-center text-slate-500', className)}>
      {icon && (
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-white/5">
          {icon}
        </div>
      )}
      <p>{title}</p>
      {body && <p className="-mt-1 max-w-md text-xs leading-relaxed text-slate-600">{body}</p>}
      {action}
    </div>
  );
}
