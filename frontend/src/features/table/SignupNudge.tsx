import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Button } from '@/components/Button'
import { Field } from '@/components/Field'
import { Icon } from '@/components/Icon'
import { GuestClaimRequestSchema, type GuestClaimRequest } from '@/contracts/dto/auth'
import { applyFieldErrors } from '@/lib/apiErrors'
import { formatNumber, resolveNumerals } from '@/lib/format'
import { localizedZodResolver } from '@/lib/zodResolver'
import { useAuthStore } from '@/stores/authStore'
import { useThemeStore } from '@/stores/themeStore'
import { useUiStore } from '@/stores/uiStore'
import { useWalletStore } from '@/stores/walletStore'
import styles from './Table.module.css'

const FIELDS = ['email', 'password'] as const

/**
 * ★ The signup nudge — journey J2, and P6's hardest constraint.
 *
 * It is a **suggestion, never a gate**: dismissible, dismissed permanently, and
 * it never blocks the table behind it. A guest who ignores this forever keeps
 * playing forever — that is the promise, and a modal here would break it.
 *
 * It leads with the number, because the number is the whole argument: "120
 * coins waiting" is concrete in a way "create an account" is not.
 *
 * On success it navigates to the server's `redirectTo`, decided by the
 * transaction that preserved the seat — so the player lands back in the *same
 * seat at the same table*, mid-match, with their coins vested. Reconstructing
 * that destination client-side is how somebody ends up on the welcome page
 * wondering where their game went.
 */
export function SignupNudge() {
  const { t } = useTranslation(['auth', 'common'])
  const navigate = useNavigate()

  const claimGuestAccount = useAuthStore((s) => s.claimGuestAccount)
  const balances = useWalletStore((s) => s.balances)
  const dismissed = useUiStore((s) => s.dismissedNudges.includes('guestClaim'))
  const dismiss = useUiStore((s) => s.dismissNudge)

  const locale = useThemeStore((s) => s.locale)
  const numeralSystem = useThemeStore((s) => s.numeralSystem)
  const numerals = resolveNumerals(numeralSystem, locale)

  const [open, setOpen] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<GuestClaimRequest>({
    resolver: localizedZodResolver(GuestClaimRequestSchema),
    mode: 'onBlur',
  })

  const coins = balances.COIN?.balance ?? 0
  if (dismissed) return null

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      const claimed = await claimGuestAccount({ ...values, locale })
      await navigate(claimed.redirectTo, { replace: true })
    } catch (error) {
      const { formMessage } = applyFieldErrors(error, setError, FIELDS)
      setFormError(formMessage)
    }
  })

  return (
    <section className={`glass ${styles.nudge}`} aria-labelledby="nudge-heading">
      <Button
        className={styles.nudgeClose}
        variant="ghost"
        iconOnly
        small
        aria-label={t('common:actions.dismiss')}
        onClick={() => {
          dismiss('guestClaim')
        }}
      >
        <Icon name="close" size="sm" />
      </Button>

      <h2 className={styles.nudgeTitle} id="nudge-heading">
        <Icon name="coin" size="sm" />
        {t('auth:claim.nudgeTitle', {
          coins: formatNumber(coins, { locale, numerals }),
        })}
      </h2>
      <p className={styles.nudgeBody}>{t('auth:claim.nudgeBody')}</p>

      {!open ? (
        <Button
          variant="primary"
          onClick={() => {
            setOpen(true)
          }}
        >
          {t('auth:claim.nudgeAction')}
        </Button>
      ) : (
        <form onSubmit={onSubmit} noValidate style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {formError !== null && (
            <p className={`${styles.banner} ${styles.bannerDanger}`} role="alert">
              <Icon name="alert" size="sm" />
              <span>{formError}</span>
            </p>
          )}

          <Field
            label={t('auth:fields.email')}
            type="email"
            autoComplete="email"
            latin
            error={errors.email?.message}
            {...register('email')}
          />
          <Field
            label={t('auth:fields.password')}
            type="password"
            autoComplete="new-password"
            latin
            hint={t('auth:fields.passwordHint')}
            error={errors.password?.message}
            {...register('password')}
          />

          <Button type="submit" variant="primary" block pending={isSubmitting}>
            {t('auth:claim.submit')}
          </Button>
        </form>
      )}
    </section>
  )
}
