import { forwardRef, useId, type SelectHTMLAttributes } from 'react';
import { clsx } from 'clsx';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Renders a `.label` caption above the select. */
  label?: string;
  /** Extra classes for the wrapping container. */
  containerClassName?: string;
}

/** Styled native `<select>` matching the global `.input` class. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, containerClassName, className, id, children, ...props },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const select = (
    <select ref={ref} id={selectId} className={clsx('input', className)} {...props}>
      {children}
    </select>
  );
  if (!label) return select;
  return (
    <div className={containerClassName}>
      <label className="label" htmlFor={selectId}>{label}</label>
      {select}
    </div>
  );
});
