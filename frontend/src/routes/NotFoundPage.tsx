import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'

export function NotFoundPage() {
  const { t } = useTranslation()

  return (
    <section
      className="glass"
      style={{
        padding: 'var(--space-8)',
        borderRadius: 'var(--radius-lg)',
        display: 'grid',
        gap: 'var(--space-4)',
        justifyItems: 'center',
        textAlign: 'center',
      }}
    >
      <Icon name="info" />
      <h1>{t('notFound.title')}</h1>
      <p style={{ color: 'var(--color-text-muted)' }}>{t('notFound.body')}</p>
      <Link to="/">
        <Button variant="primary">{t('actions.backHome')}</Button>
      </Link>
    </section>
  )
}
