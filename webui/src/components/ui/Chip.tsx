import { forwardRef, type HTMLAttributes } from 'react';
import { clsx } from 'clsx';

export type ChipTone = 'neutral' | 'brand' | 'pink' | 'violet' | 'emerald' | 'sky' | 'amber' | 'red';

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
}

const toneClasses: Record<ChipTone, string> = {
  neutral: '',
  brand: 'bg-brand-500/15 text-brand-200 ring-brand-500/30',
  pink: 'bg-accent-pink/10 text-pink-300 ring-accent-pink/25',
  violet: 'bg-violet-500/10 text-violet-300 ring-violet-500/25',
  emerald: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/25',
  sky: 'bg-sky-500/10 text-sky-300 ring-sky-500/25',
  amber: 'bg-amber-500/10 text-amber-300 ring-amber-500/25',
  red: 'bg-red-500/10 text-red-300 ring-red-500/25',
};

/**
 * Shared badge wrapping the global `.chip` class. `neutral` (default) is the
 * bare `.chip` styling; tones recolor it while keeping the same shape.
 */
export const Chip = forwardRef<HTMLSpanElement, ChipProps>(function Chip(
  { tone = 'neutral', className, ...props },
  ref,
) {
  return <span ref={ref} className={clsx('chip', toneClasses[tone], className)} {...props} />;
});
