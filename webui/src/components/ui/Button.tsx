import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { clsx } from 'clsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
};

/**
 * Shared button wrapping the global `.btn-*` component classes.
 * `size="md"` (default) is the bare `.btn-*` styling; `size="sm"` tightens
 * padding/type for dense toolbars. Icon-only usage: pass a single icon child
 * plus an `aria-label`.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', type = 'button', className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(variantClasses[variant], size === 'sm' && 'px-2.5 py-1.5 text-xs', className)}
      {...props}
    />
  );
});
