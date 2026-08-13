import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { clsx } from 'clsx';

export interface PanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Use the `.panel-elev` (raised) surface instead of `.panel`. */
  elevated?: boolean;
  /** Renders a bold white heading inside a header row. */
  title?: ReactNode;
  /** Extra content placed on the right side of the header row. */
  header?: ReactNode;
}

/** Shared surface wrapping the global `.panel` / `.panel-elev` classes. */
export const Panel = forwardRef<HTMLDivElement, PanelProps>(function Panel(
  { elevated = false, title, header, className, children, ...props },
  ref,
) {
  return (
    <div ref={ref} className={clsx(elevated ? 'panel-elev' : 'panel', className)} {...props}>
      {(title || header) && (
        <header className="flex items-center justify-between">
          {title && <h2 className="text-base font-bold text-white">{title}</h2>}
          {header}
        </header>
      )}
      {children}
    </div>
  );
});
