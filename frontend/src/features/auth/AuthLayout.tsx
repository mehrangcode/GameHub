import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '@/components/Icon'
import styles from './AuthLayout.module.css'

/**
 * The frame both auth forms sit in. One glass card centred on the aurora —
 * deliberately the *only* thing on the page, because a sign-in screen with a
 * navigation bar invites you to go somewhere other than sign in.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle: string
  children: ReactNode
  footer: ReactNode
}) {
  const { t } = useTranslation()

  return (
    <main className={styles.wrap}>
      <div className={`glass ${styles.card}`}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <Icon name="spade" />
          </span>
          <span>{t('brand')}</span>
        </div>

        <div className={styles.head}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </div>

        {children}

        <p className={styles.foot}>{footer}</p>
      </div>
    </main>
  )
}
