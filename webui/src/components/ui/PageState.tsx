import type { ReactNode } from 'react';
import { CircleAlert, Clock3, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';

export type PageStateKind = 'loading' | 'error' | 'empty';

export interface PageStateProps {
  state: PageStateKind;
  title: string;
  detail?: string;
  /** Overrides the default per-state icon. */
  icon?: ReactNode;
  /** Optional action slot rendered below the detail text. */
  action?: ReactNode;
  /**
   * `plain` (default) matches the ShortsReviewPage full-page block;
   * `panel` matches the LongformEditorPage `.panel-elev` card variant.
   */
  variant?: 'plain' | 'panel';
}

function defaultIcon(state: PageStateKind): ReactNode {
  if (state === 'loading') return <Loader2 className="h-5 w-5 animate-spin" />;
  if (state === 'error') return <CircleAlert className="h-5 w-5" />;
  return <Clock3 className="h-5 w-5" />;
}

/**
 * Full-page loading/error/empty wrapper centralizing the PageState blocks
 * previously duplicated in ShortsReviewPage and LongformEditorPage.
 */
export function PageState({ state, title, detail, icon, action, variant = 'plain' }: PageStateProps) {
  if (variant === 'panel') {
    return (
      <div className="grid min-h-[70vh] place-items-center px-5">
        <div className="panel-elev grid max-w-md place-items-center gap-3 p-8 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-white/5 text-slate-400">
            {icon ?? defaultIcon(state)}
          </div>
          <div className="text-lg font-bold text-white">{title}</div>
          {detail && <p className="text-sm leading-relaxed text-slate-500">{detail}</p>}
          {action}
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto grid min-h-[65dvh] max-w-3xl place-items-center px-4 py-12 text-center">
      <div>
        <div
          className={clsx(
            'mx-auto grid h-12 w-12 place-items-center rounded-2xl border',
            state === 'error'
              ? 'border-red-500/20 bg-red-500/10 text-red-300'
              : 'border-white/10 bg-white/5 text-slate-300',
          )}
        >
          {icon ?? defaultIcon(state)}
        </div>
        <h1 className="mt-4 text-xl font-black tracking-tight text-white">{title}</h1>
        {detail && <p className="mt-2 text-sm leading-relaxed text-slate-500">{detail}</p>}
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}
