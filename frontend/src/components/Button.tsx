import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styles from './Button.module.css'

type Variant = 'primary' | 'quiet' | 'ghost' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  block?: boolean
  small?: boolean
  iconOnly?: boolean
  /**
   * Shows a spinner and disables the control. Separate from `disabled` so a
   * submitting form reads as "working" rather than "you may not do this" —
   * different states, and a screen reader is told which via `aria-busy`.
   */
  pending?: boolean
  children?: ReactNode
}

export function Button({
  variant = 'quiet',
  block = false,
  small = false,
  iconOnly = false,
  pending = false,
  disabled = false,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    styles.btn,
    styles[variant],
    block ? styles.block : '',
    small ? styles.small : '',
    iconOnly ? styles.iconOnly : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || pending}
      aria-busy={pending}
      {...rest}
    >
      {pending && <span className={styles.spinner} aria-hidden="true" />}
      {children}
    </button>
  )
}
