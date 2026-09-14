import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Button } from '@/components/Button'
import { Field } from '@/components/Field'
import { Icon } from '@/components/Icon'
import { LoginRequestSchema, type LoginRequest } from '@/contracts/dto/auth'
import { applyFieldErrors } from '@/lib/apiErrors'
import { localizedZodResolver } from '@/lib/zodResolver'
import { useAuthStore } from '@/stores/authStore'
import { AuthLayout } from './AuthLayout'
import styles from './AuthLayout.module.css'

const FIELDS = ['email', 'password'] as const

export function LoginPage() {
  const { t } = useTranslation(['auth', 'common'])
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const login = useAuthStore((s) => s.login)
  const [formError, setFormError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginRequest>({
    // ★ The *same* schema the backend validates with, imported from the
    // generated `contracts/` mirror. A rule tightened on the server tightens
    // in this form on the next `contracts:sync` — the client cannot invent its
    // own idea of a valid credential.
    resolver: localizedZodResolver(LoginRequestSchema),
    mode: 'onBlur',
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      await login(values)
      // `next` lets a guard send someone here and get them back where they
      // were. Relative paths only — an absolute URL here would be an open
      // redirect a phishing link could point at.
      const next = params.get('next')
      await navigate(next !== null && next.startsWith('/') ? next : '/', { replace: true })
    } catch (error) {
      const { formMessage } = applyFieldErrors(error, setError, FIELDS)
      setFormError(formMessage)
    }
  })

  return (
    <AuthLayout
      title={t('auth:login.title')}
      subtitle={t('auth:login.subtitle')}
      footer={
        <>
          {t('auth:login.noAccount')}
          <Link to="/register">{t('auth:login.registerLink')}</Link>
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
          autoComplete="current-password"
          latin
          error={errors.password?.message}
          {...register('password')}
        />

        <Button type="submit" variant="primary" block pending={isSubmitting}>
          {t('auth:login.submit')}
        </Button>
      </form>
    </AuthLayout>
  )
}
