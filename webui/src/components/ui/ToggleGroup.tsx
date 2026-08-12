import type { ReactNode } from 'react';
import { clsx } from 'clsx';

export interface ToggleGroupOption<T extends string | number> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Secondary line of text; switches the option into the taller card layout. */
  description?: ReactNode;
  disabled?: boolean;
  /** Overrides the selected styling for this option only. */
  selectedClassName?: string;
}

export type ToggleGroupTone = 'brand' | 'blue' | 'pink';

export interface ToggleGroupProps<T extends string | number> {
  options: Array<ToggleGroupOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Renders a `.label` caption above the group. */
  label?: ReactNode;
  /** Grid columns for the option buttons (default 2). */
  columns?: number;
  /** Accent color of the selected option (default 'brand'). */
  tone?: ToggleGroupTone;
  /** Accessible group name; falls back to `label` when it is a string. */
  ariaLabel?: string;
  className?: string;
  /** Extra classes for the grid container (e.g. override the default `gap-1.5`). */
  groupClassName?: string;
  /** Gap utility between option buttons (default `gap-1.5`). */
  gapClassName?: string;
  /** Overrides the unselected option styling (default matches the dashboard groups). */
  inactiveClassName?: string;
  /** Overrides the selected option styling (default derived from `tone`). */
  activeClassName?: string;
  /** Replaces the base layout classes of options without a description. */
  optionClassName?: string;
  /** Lays options out in a wrapping flex row instead of a fixed-column grid. */
  wrap?: boolean;
}

const selectedClasses: Record<ToggleGroupTone, string> = {
  brand: 'bg-brand-500/25 text-white ring-1 ring-brand-500/40',
  blue: 'bg-accent-blue/25 text-white ring-1 ring-accent-blue/45',
  pink: 'bg-accent-pink/20 text-white ring-1 ring-accent-pink/45',
};

const unselectedClasses = 'bg-white/5 text-slate-300 ring-1 ring-white/5 hover:bg-white/10';

/**
 * Controlled single-select option group matching the inline toggle groups
 * used across the dashboard/settings pages.
 */
export function ToggleGroup<T extends string | number>({
  options,
  value,
  onChange,
  label,
  columns = 2,
  tone = 'brand',
  ariaLabel,
  className,
  groupClassName,
  gapClassName,
  inactiveClassName,
  activeClassName,
  optionClassName,
  wrap = false,
}: ToggleGroupProps<T>) {
  return (
    <div className={className}>
      {label && <div className="label">{label}</div>}
      <div
        role="group"
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        className={clsx(wrap ? 'flex flex-wrap' : 'grid', gapClassName ?? 'gap-1.5', groupClassName)}
        style={wrap ? undefined : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={String(option.value)}
              type="button"
              aria-pressed={selected}
              disabled={option.disabled}
              onClick={() => onChange(option.value)}
              className={clsx(
                option.description
                  ? 'min-h-12 rounded-md px-2.5 py-2 text-left transition'
                  : (optionClassName ?? 'flex items-center justify-center gap-2 rounded-md px-2 py-1.5 text-xs font-semibold transition'),
                selected
                  ? (option.selectedClassName ?? activeClassName ?? selectedClasses[tone])
                  : (inactiveClassName ?? unselectedClasses),
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {option.description ? (
                <>
                  <span className="flex items-center gap-1.5 text-xs font-bold">
                    {option.icon}
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-tight text-slate-500">{option.description}</span>
                </>
              ) : (
                <>
                  {option.icon}
                  {option.label}
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
