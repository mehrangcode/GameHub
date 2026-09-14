import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router'
import { redeemInvite, resolveInvite } from '@/api/invites'
import { Button } from '@/components/Button'
import { Field } from '@/components/Field'
import { Icon } from '@/components/Icon'
import { gameIcon } from '@/components/icons'
import { DisplayNameSchema } from '@/contracts/dto/auth'
import { messageOf } from '@/lib/apiErrors'
import { formatNumber, resolveNumerals } from '@/lib/format'
import { useAsync } from '@/lib/useAsync'
import { messageForIssue } from '@/lib/zodResolver'
import { useAuthStore } from '@/stores/authStore'
import { useThemeStore } from '@/stores/themeStore'
import styles from './InviteLanding.module.css'

const NAME_KEY = 'guestName'

/**
 * ★ `/t/:inviteCode` — the screen that decides whether persona P2 plays or
 * leaves (06 §2.1). The highest-stakes surface in the product.
 *
 * Four rules, and all four are load-bearing:
 *
 *   1. **No auth guard.** This route resolves through an unauthenticated
 *      `GET /invites/:code`, so the link works in a private window with no
 *      cookies. A guard here would reintroduce the signup wall.
 *   2. **One field, one button.** No email, no password, no checkbox. The
 *      target is click-to-seated in under five seconds (02 §12).
 *   3. **Sign-in is a text link**, never a competing button.
 *   4. **Expired and unknown codes are indistinguishable** — the server
 *      deliberately answers both identically so the route cannot be used to
 *      enumerate live invites (07 §5.2), and the UI must not undo that by
 *      rendering two different messages.
 */
export function InviteLandingPage() {
  const { inviteCode = '' } = useParams()
  const { t } = useTranslation(['auth', 'common', 'games'])
  const navigate = useNavigate()

  const status = useAuthStore((s) => s.status)
  const identity = useAuthStore((s) => s.identity)
  const registerAsGuest = useAuthStore((s) => s.registerAsGuest)

  const locale = useThemeStore((s) => s.locale)
  const numeralSystem = useThemeStore((s) => s.numeralSystem)
  const numerals = resolveNumerals(numeralSystem, locale)

  const invite = useAsync(() => resolveInvite(inviteCode), [inviteCode])

  // Remembered so a refresh does not re-prompt for a name already typed.
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [nameError, setNameError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)

  /**
   * ★ The returning guest: a valid `guest` cookie for *this* table means they
   * are already seated, so send them straight in rather than asking for a name
   * they have already given. Reloading a table must not cost a second identity.
   */
  useEffect(() => {
    if (identity?.kind === 'guest' && identity.tableId !== '') {
      void navigate(`/table/${identity.tableId}`, { replace: true })
    }
  }, [identity, navigate])

  const num = (value: number) => formatNumber(value, { locale, numerals })

  /**
   * A signed-in user redeems the code for its table id and goes. They never
   * become a guest: that would strand their coins in a provisional wallet and
   * sign them out of the account they already have.
   */
  async function joinAsUser(): Promise<void> {
    setFormError(null)
    setJoining(true)
    try {
      const { redirectTo } = await redeemInvite(inviteCode)
      await navigate(redirectTo, { replace: true })
    } catch (error) {
      setFormError(messageOf(error))
    } finally {
      setJoining(false)
    }
  }

  async function join(): Promise<void> {
    const parsed = DisplayNameSchema.safeParse(name)
    if (!parsed.success) {
      setNameError(messageForIssue(parsed.error.issues[0]!))
      return
    }

    setNameError(null)
    setFormError(null)
    setJoining(true)

    try {
      try {
        localStorage.setItem(NAME_KEY, parsed.data)
      } catch {
        // A reader with storage disabled re-types their name next time. Not a
        // reason to refuse the join.
      }

      const redirectTo = await registerAsGuest(inviteCode, parsed.data)
      // ★ The destination comes from the server, decided by the same request
      // that created the session. The public invite payload deliberately
      // carries no `tableId` — a leaked code should not also leak the table's
      // identifier — so this is the only honest way to know where to go.
      await navigate(redirectTo ?? '/', { replace: true })
    } catch (error) {
      setFormError(messageOf(error))
    } finally {
      setJoining(false)
    }
  }

  // ── States ────────────────────────────────────────────────────────────────

  if (invite.loading) {
    return (
      <Frame>
        <p className={styles.notice} role="status">
          {t('auth:invite.loading')}
        </p>
      </Frame>
    )
  }

  if (invite.error !== null || invite.data === null) {
    // One message for expired, revoked and never-existed. The server answers
    // all three identically and so must this page.
    return (
      <Frame>
        <div className={styles.notice} role="alert">
          <Icon name="alert" className={styles.noticeIcon} />
          <h1 className={styles.title}>{t('auth:invite.expired.title')}</h1>
          <p>{t('auth:invite.expired.bodyNoHost')}</p>
          <Link to="/">
            <Button variant="quiet">{t('common:actions.backHome')}</Button>
          </Link>
        </div>
      </Frame>
    )
  }

  const data = invite.data
  const gameName = t(data.gameNameKey.replace(/^games\./, ''), {
    ns: 'games',
    defaultValue: data.gameSlug,
  })

  const full = data.seatsFree === 0
  const blocked = full || data.inProgress

  return (
    <Frame>
      <span className={styles.art} aria-hidden="true">
        <Icon name={gameIcon(data.gameSlug)} />
      </span>

      <div className={styles.head}>
        <h1 className={styles.title}>
          {data.hostDisplayName === null
            ? t('auth:invite.titleNoHost', { game: gameName })
            : t('auth:guest.title', { host: data.hostDisplayName, game: gameName })}
        </h1>

        <p className={styles.meta}>
          <span className={styles.metaItem}>
            <Icon name="users" size="sm" />
            {t('auth:guest.seatsFree', {
              count: data.seatsFree,
              replace: { count: num(data.seatsFree), total: num(data.seatCount) },
            })}
          </span>
        </p>
      </div>

      {data.inProgress && (
        <div className={styles.notice}>
          <Icon name="info" className={styles.noticeIcon} />
          <strong>{t('auth:invite.inProgress.title')}</strong>
          <p>{t('auth:invite.inProgress.body')}</p>
        </div>
      )}

      {full && !data.inProgress && (
        <div className={styles.notice}>
          <Icon name="info" className={styles.noticeIcon} />
          <strong>{t('auth:invite.full.title')}</strong>
          <p>{t('auth:invite.full.body')}</p>
        </div>
      )}

      {data.requireApproval && !blocked && (
        <p className={styles.reassure}>
          {t('auth:invite.approval.body', { host: data.hostDisplayName ?? '' })}
        </p>
      )}

      {/* A signed-in user does not need a name: they have one. */}
      {status === 'authenticated' ? (
        <>
          {formError !== null && (
            <p className={styles.formError} role="alert">
              <Icon name="alert" size="sm" />
              <span>{formError}</span>
            </p>
          )}
          <Button
            variant="primary"
            block
            onClick={() => {
              void joinAsUser()
            }}
            pending={joining}
            disabled={blocked && !data.allowSpectators}
          >
            <Icon name="play" size="sm" />
            {t('auth:guest.submit')}
          </Button>
        </>
      ) : (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault()
            void join()
          }}
          noValidate
        >
          {formError !== null && (
            <p className={styles.formError} role="alert">
              <Icon name="alert" size="sm" />
              <span>{formError}</span>
            </p>
          )}

          <Field
            label={t('auth:guest.nameLabel')}
            placeholder={t('auth:guest.namePlaceholder')}
            autoComplete="nickname"
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value)
            }}
            error={nameError ?? undefined}
          />

          <Button
            type="submit"
            variant="primary"
            block
            pending={joining}
            disabled={blocked && !data.allowSpectators}
          >
            <Icon name="play" size="sm" />
            {blocked && data.allowSpectators
              ? t('auth:invite.full.spectate')
              : t('auth:guest.submit')}
          </Button>

          <p className={styles.reassure}>{t('auth:guest.noAccountNeeded')}</p>
        </form>
      )}

      {status !== 'authenticated' && (
        <p className={styles.foot}>
          {t('auth:guest.haveAccount')}
          <Link to={`/login?next=${encodeURIComponent(`/t/${inviteCode}`)}`}>
            {t('auth:guest.signInLink')}
          </Link>
        </p>
      )}
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className={styles.wrap}>
      <div className={`glass ${styles.card}`}>{children}</div>
    </main>
  )
}
