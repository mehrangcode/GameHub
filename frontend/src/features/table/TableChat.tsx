import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'
import { CHAT_BODY_MAX, type ChatMessageView } from '@/contracts/dto/chat'
import { translateServerKey } from '@/i18n'
import { useChatStore } from '@/stores/chatStore'
import styles from './Table.module.css'

/**
 * Table chat — S26 on the wire, S44 on screen.
 *
 * ★ A `SYSTEM` message carries an **i18n key** in `body` and its arguments in
 * `params`, never a rendered sentence. That is what makes a transcript written
 * while an English speaker was at the table readable in Persian a month later —
 * and it is why this component calls {@link translateServerKey} rather than
 * printing `message.body`.
 */
export function TableChat({ onSend }: { onSend: (body: string) => Promise<void> }) {
  const { t } = useTranslation(['table', 'common'])
  const messages = useChatStore((s) => s.messages)
  const pending = useChatStore((s) => s.pending)
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Jump to the newest line. `scrollTop = scrollHeight` rather than
    // `scrollIntoView`, which would also scroll the page on a phone.
    const log = logRef.current
    if (log !== null) log.scrollTop = log.scrollHeight
  }, [messages.length, pending.length])

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    const body = draft.trim()
    if (body === '') return

    setDraft('')
    try {
      await onSend(body)
    } catch {
      // The pending line is marked failed by the store; nothing to add here.
    }
  }

  return (
    <section className={`glass ${styles.panel} ${styles.chat}`} aria-labelledby="chat-heading">
      <h2 className={styles.panelTitle} id="chat-heading">
        {t('table:chat.title')}
      </h2>

      <div className={styles.chatLog} ref={logRef} role="log" aria-live="polite">
        {messages.length === 0 && pending.length === 0 && (
          <p className={styles.chatSystem}>{t('table:chat.empty')}</p>
        )}

        {messages.map((message) => (
          <ChatLine key={message.id} message={message} />
        ))}

        {pending.map((line) => (
          <p
            key={line.localId}
            className={`${styles.chatLine} ${line.failed ? styles.chatFailed : styles.chatPending}`}
          >
            {line.body}
          </p>
        ))}
      </div>

      <form className={styles.chatForm} onSubmit={(event) => void submit(event)}>
        <input
          className={styles.chatInput}
          value={draft}
          maxLength={CHAT_BODY_MAX}
          placeholder={t('table:chat.placeholder')}
          aria-label={t('table:chat.placeholder')}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
        />
        <Button type="submit" variant="primary" small iconOnly aria-label={t('table:chat.send')}>
          <Icon name="send" size="sm" />
        </Button>
      </form>
    </section>
  )
}

function ChatLine({ message }: { message: ChatMessageView }) {
  if (message.kind === 'SYSTEM') {
    return (
      <p className={styles.chatSystem}>
        {/* body is a key like `table.system.seatTaken`; params fill it in. */}
        {message.body === null
          ? ''
          : translateServerKey(message.body, message.params ?? undefined)}
      </p>
    )
  }

  return (
    <p className={styles.chatLine}>
      <span className={styles.chatAuthor}>{message.author.displayName ?? ''}</span>
      <span>{message.body}</span>
    </p>
  )
}
