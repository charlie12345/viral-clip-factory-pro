import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { clsx } from 'clsx';

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> {
  label: ReactNode;
  value: number;
  onChange: (value: number) => void;
  /** Formats the current value shown next to the label (default: raw number). */
  formatValue?: (value: number) => string;
  /**
   * Content rendered on the right of a two-column header row, replacing the
   * inline `label: value` caption (matches the editor's icon-header sliders).
   */
  trailing?: ReactNode;
  /** Extra classes for the two-column header row (only used with `trailing`). */
  headerClassName?: string;
  /** Extra classes for the wrapping container. */
  containerClassName?: string;
}

/**
 * Labeled range input with the current value displayed next to the label,
 * matching the filter sliders already used in the app (`accent-pink-500`).
 */
export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { label, value, onChange, formatValue, trailing, headerClassName, containerClassName, className, id, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={containerClassName}>
      {trailing ? (
        <div className={clsx('flex items-center justify-between', headerClassName)}>
          <label className="flex items-center gap-1.5" htmlFor={inputId}>{label}</label>
          {trailing}
        </div>
      ) : (
        <label className="label" htmlFor={inputId}>
          {label}: {formatValue ? formatValue(value) : value}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        type="range"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className={clsx('w-full accent-pink-500', className)}
        {...props}
      />
    </div>
  );
});
