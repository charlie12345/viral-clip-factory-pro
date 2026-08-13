import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { Skeleton } from './Skeleton';

export interface StatCardProps {
  icon: ReactNode;
  label: string;
  value: string;
  /** Tailwind gradient classes for the icon tile, e.g. `from-pink-500 to-orange-500`. */
  accent: string;
  /** Show the pulsing activity dot next to the value. */
  pulse?: boolean;
  /** Render a placeholder in place of the value while the source data loads. */
  loading?: boolean;
}

/** Dashboard-style metric card wrapping the global `.stat-card` class. */
export function StatCard({ icon, label, value, accent, pulse, loading }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-slate-400">
        <span>{label}</span>
        <div className={clsx('grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br text-white', accent)}>
          {icon}
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2 text-2xl font-black text-white">
        {loading ? <Skeleton className="my-1.5 h-5 w-14" /> : value}
        {pulse && <span className="h-2 w-2 animate-pulse-soft rounded-full bg-accent-pink" />}
      </div>
    </div>
  );
}
