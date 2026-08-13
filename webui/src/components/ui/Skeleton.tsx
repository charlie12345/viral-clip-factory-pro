import type { HTMLAttributes } from 'react';
import { clsx } from 'clsx';

export type SkeletonProps = HTMLAttributes<HTMLDivElement>;

/**
 * Shimmering placeholder block. Size it with utility classes, e.g.
 * `<Skeleton className="h-3 w-24" />`. Decorative by default — put the
 * accessible loading label on the container that groups them.
 */
export function Skeleton({ className, ...rest }: SkeletonProps) {
  return <div aria-hidden="true" className={clsx('skeleton', className)} {...rest} />;
}
