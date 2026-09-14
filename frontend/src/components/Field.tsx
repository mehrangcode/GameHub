import { forwardRef, useId, type InputHTMLAttributes } from 'react'
import { Icon } from './Icon'
import styles from './Field.module.css'

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  /** Already localized. Components never receive a raw `i18nKey`. */
  error?: string
  hint?: string
  /**
   * Forces LTR inside the input regardless of page direction — for emails,
   * invite codes and anything else that is Latin by nature. The *label* still
   * mirrors; only the value does not.
   */
  latin?: boolean
}

/**
 * A labelled input with its error and hint wired together for assistive tech.
 *
 * `aria-describedby` names whichever of hint/error exist, and `aria-invalid`
 * follows the error — so the message is announced when focus lands, rather
 * than being a red line only a sighted user notices.
 */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, hint, latin = false, className, ...rest },
  ref,
) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`

  const describedBy = [hint === undefined ? '' : hintId, error === undefined ? '' : errorId]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>

      <input
        {...rest}
        id={id}
        ref={ref}
        className={[styles.input, latin ? styles.ltrInput : '', className ?? '']
          .filter(Boolean)
          .join(' ')}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
      />

      {hint !== undefined && error === undefined && (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      )}

      {error !== undefined && (
        <p className={styles.error} id={errorId} role="alert">
          <Icon name="alert" size="sm" />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
})
