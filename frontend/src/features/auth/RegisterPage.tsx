import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Button } from '@/components/Button'
import { Field } from '@/components/Field'
import { Icon } from '@/components/Icon'
import { RegisterRequestSchema, type RegisterRequest } from '@/contracts/dto/auth'
import { applyFieldErrors } from '@/lib/apiErrors'
import { localizedZodResolver } from '@/lib/zodResolver'
import { useAuthStore } from '@/stores/authStore'
import { useThemeStore } from '@/stores/themeStore'
import { AuthLayout } from './AuthLayout'
import styles from './AuthLayout.module.css'

const FIELDS = ['email', 'password', 'displayName'] as const

export function RegisterPage() {
  const { t } = useTranslation(['auth', 'common'])
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const registerAccount = useAuthStore((s) => s.registerAccount)
  const locale = useThemeStore((s) => s.locale)
  const [formError, setFormError] = useState<string | null>(null)

  const inviteCode = params.get('invite')

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterRequest>({
    resolver: localizedZodResolver(RegisterRequestSchema),
    mode: 'onBlur',
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      // The locale the form was filled in is the best guess at the account's
      // language, and sending it means the first email we ever send is in the
      // right one.
      const redirectTo = await registerAccount({
        ...values,
        locale,
        ...(inviteCode === null ? {} : { inviteCode }),
      })

      // ★ `redirectTo` comes from the server, decided by the same request that
      // created the account. Reconstructing it client-side is how someone who
      // signed up from an invite link ends up on the welcome page instead.
      await navigate(redirectTo ?? '/', { replace: true })
    } catch (error) {
      const { formMessage } = applyFieldErrors(error, setError, FIELDS)
      setFormError(formMessage)
    }
  })

  return (
    <AuthLayout
      title={t('auth:register.title')}
      subtitle={t('auth:register.subtitle')}
      footer={
        <>
          {t('auth:register.haveAccount')}
          <Link to="/login">{t('auth:register.loginLink')}</Link>
        </>
      }
    >
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {formError !== null && (
          <p className={styles.formError} role="alert">
            <Icon name="alert" size="sm" />
            <span>{formError}</span>
          </p>
        )}

        <Field
          label={t('auth:fields.displayName')}
          autoComplete="nickname"
          hint={t('auth:fields.displayNameHint')}
          error={errors.displayName?.message}
          {...register('displayName')}
        />

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
          {t('auth:register.submit')}
        </Button>
      </form>
    </AuthLayout>
  )
}
