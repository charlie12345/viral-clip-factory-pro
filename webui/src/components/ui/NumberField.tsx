import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import { clsx } from 'clsx';
import { clamp } from '@/lib/math';

export interface NumberFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> {
  label: string;
  value: number;
  onChange: (value: number) => void;
  /** Extra classes for the wrapping label element. */
  containerClassName?: string;
}

/**
 * Labeled numeric input on top of the global `.input` class. Values are
 * clamped to `min`/`max` when those are provided; non-numeric edits are
 * ignored (the previous value is kept).
 */
export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(function NumberField(
  { label, value, onChange, min, max, containerClassName, className, id, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label className={clsx('block min-w-0', containerClassName)} htmlFor={inputId}>
      <span className="label">{label}</span>
      <input
        ref={ref}
        id={inputId}
        type="number"
        className={clsx('input', className)}
        value={value}
        min={min}
        max={max}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (!Number.isFinite(parsed)) return;
          const minNum = min === undefined ? Number.NEGATIVE_INFINITY : Number(min);
          const maxNum = max === undefined ? Number.POSITIVE_INFINITY : Number(max);
          onChange(clamp(parsed, minNum, maxNum));
        }}
        {...props}
      />
    </label>
  );
});
