import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink } from 'react-router'
import type { AssetCode } from '@/contracts/enums'
import { formatNumber, initialsOf, resolveNumerals } from '@/lib/format'
import { useAuthStore } from '@/stores/authStore'
import { useThemeStore } from '@/stores/themeStore'
import { useWalletStore } from '@/stores/walletStore'
import { Button } from './Button'
import { Icon, type IconName } from './Icon'
import styles from './AppShell.module.css'

/**
 * What the header purse shows, in order.
 *
 * Deliberately **not** derived from `ASSET_CODES`: an asset needs an icon and a
 * label before it can be rendered, so a new code appearing in the contract
 * should leave the purse alone rather than render a blank chip. `HINT` is here
 * because a hint point is spendable and a player needs to know they have one
 * before they are mid-puzzle wondering why the button is dark.
 */
const PURSE: { asset: AssetCode; icon: IconName }[] = [
  { asset: 'COIN', icon: 'coin' },
  { asset: 'GEM', icon: 'gem' },
  { asset: 'TICKET', icon: 'ticket' },
  { asset: 'HINT', icon: 'hint' },
]

/**
 * The chrome every signed-in screen sits inside.
 *
 * Nothing here is conditional on *route*; it is conditional on **identity**,
 * which is what keeps a guest's header from advertising a wallet statement
 * they cannot open while still showing them the coins they are accruing.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const identity = useAuthStore((s) => s.identity)
  const status = useAuthStore((s) => s.status)
  const logout = useAuthStore((s) => s.logout)

  const balances = useWalletStore((s) => s.balances)
  const isProvisional = useWalletStore((s) => s.isProvisional)

  const locale = useThemeStore((s) => s.locale)
  const numeralSystem = useThemeStore((s) => s.numeralSystem)
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme)
  const setTheme = useThemeStore((s) => s.setTheme)
  const setLocale = useThemeStore((s) => s.setLocale)

  const numerals = resolveNumerals(numeralSystem, locale)
  const signedIn = status === 'authenticated' || status === 'guest'

  return (
    <>
      <a className={styles.skip} href="#main">
        {t('a11y.skipToContent')}
      </a>

      <header className={styles.topbar}>
        <div className={styles.inner}>
          <Link className={styles.brand} to="/">
            <span className={styles.brandMark}>
              <Icon name="spade" />
            </span>
            <span className={styles.brandName}>{t('brand')}</span>
          </Link>

          <nav className={styles.nav} aria-label={t('nav.primary')}>
            <NavLink to="/">{t('nav.play')}</NavLink>
            <NavLink to="/store">{t('nav.store')}</NavLink>
            <NavLink to="/customize">{t('nav.customize')}</NavLink>
            {/* A statement is an account feature — 10 §10. A guest sees their
                balance in the purse but has no ledger to paginate. */}
            {status === 'authenticated' && <NavLink to="/wallet">{t('nav.wallet')}</NavLink>}
          </nav>

          <div className={styles.end}>
            {signedIn && (
              <div
                className={`${styles.purse} ${isProvisional ? styles.provisional : ''}`}
                aria-label={t('wallet.label')}
                title={isProvisional ? t('wallet.provisional') : undefined}
              >
                {PURSE.filter(({ asset }) => balances[asset] !== undefined).map(
                  ({ asset, icon }) => (
                    <span key={asset} className={styles.purseItem} data-kind={asset}>
                      <Icon name={icon} size="sm" title={t(`wallet.${asset.toLowerCase()}`)} />
                      <span className="num">
                        {formatNumber(balances[asset]?.balance ?? 0, { locale, numerals })}
                      </span>
                    </span>
                  ),
                )}
              </div>
            )}

            <Button
              variant="ghost"
              small
              onClick={() => {
                setLocale(locale === 'fa' ? 'en' : 'fa')
              }}
              aria-label={t('language.switch')}
            >
              {t('language.other')}
            </Button>

            <Button
              variant="ghost"
              iconOnly
              onClick={() => {
                setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
              }}
              aria-label={t('theme.toggle')}
            >
              <Icon name={resolvedTheme === 'dark' ? 'sun' : 'moon'} />
            </Button>

            {signedIn ? (
              <>
                <span className={styles.avatar} aria-hidden="true">
                  {initialsOf(identity?.displayName ?? '?')}
                </span>
                <Button
                  variant="ghost"
                  iconOnly
                  onClick={() => {
                    void logout()
                  }}
                  aria-label={t('actions.signOut')}
                >
                  <Icon name="logout" />
                </Button>
              </>
            ) : (
              <Link to="/login">
                <Button variant="quiet" small>
                  {t('actions.signIn')}
                </Button>
              </Link>
            )}
          </div>
        </div>
      </header>

      <main id="main" className={styles.page}>
        {children}
      </main>
    </>
  )
}
