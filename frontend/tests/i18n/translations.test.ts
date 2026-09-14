import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import i18n, { NAMESPACES, resources, translateServerKey } from '../../src/i18n'

/**
 * S40 — the translation bundle.
 *
 * ★ The parity test is the one that earns its keep. Persian rots **silently**:
 * a developer adds an English string, ships it, and a Persian reader sees an
 * English sentence — or worse, a raw dotted key — in a UI that was fully
 * translated last month. Nobody notices, because nobody on the team reads the
 * Persian build. A failing test is the only thing that does.
 *
 * The second suite is stronger still: it walks the **backend source** for every
 * `i18nKey` the server can actually emit and asserts this bundle answers it. A
 * key the server sends and the client cannot render is an untranslatable error
 * in front of a user, and that is exactly what the `code` + `i18nKey` contract
 * exists to prevent.
 */

/** Every leaf path in a nested translation object, dot-joined. */
function leafKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix === '' ? key : `${prefix}.${key}`),
  )
}

describe('en ↔ fa parity', () => {
  it.each([...NAMESPACES])('★ every en key in "%s" has a fa counterpart', (namespace) => {
    const en = leafKeys(resources.en[namespace]).sort()
    const fa = leafKeys(resources.fa[namespace]).sort()

    // Reported as a diff rather than a count, so the failure names the key.
    expect(en.filter((key) => !fa.includes(key))).toEqual([])
  })

  it.each([...NAMESPACES])('and no orphan fa key in "%s" that en has dropped', (namespace) => {
    const en = leafKeys(resources.en[namespace]).sort()
    const fa = leafKeys(resources.fa[namespace]).sort()

    // The other direction matters too: a key removed from en and left in fa is
    // dead weight that looks like coverage.
    expect(fa.filter((key) => !en.includes(key))).toEqual([])
  })

  it('★ no fa value is left as its English original', () => {
    const untranslated: string[] = []

    for (const namespace of NAMESPACES) {
      const en = resources.en[namespace] as Record<string, unknown>
      const fa = resources.fa[namespace] as Record<string, unknown>

      for (const key of leafKeys(en)) {
        const enValue = key.split('.').reduce<unknown>((node, part) => (node as never)?.[part], en)
        const faValue = key.split('.').reduce<unknown>((node, part) => (node as never)?.[part], fa)

        // A copy-pasted English string is the commonest way a "translated"
        // bundle is not. Interpolation-only values are legitimately identical.
        if (
          typeof enValue === 'string' &&
          enValue === faValue &&
          !/^\{\{[^}]+\}\}$/.test(enValue) &&
          enValue.length > 3
        ) {
          untranslated.push(`${namespace}:${key}`)
        }
      }
    }

    // `language.other` is deliberately the *other* language's own name.
    expect(untranslated.filter((key) => !key.endsWith('language.other'))).toEqual([])
  })
})

describe('server-emitted keys', () => {
  /**
   * Greps the backend for every string literal that looks like an i18n key.
   * Reading the real source rather than a checked-in list is the point: a key
   * added on the server and forgotten here fails *this* build, which is the
   * only moment anyone would notice before a user does.
   */
  function backendKeys(): string[] {
    const output = execFileSync(
      'rg',
      ['-o', "'(errors|table|games)\\.[a-zA-Z0-9.]+'", '--no-filename', '../backend/src'],
      { encoding: 'utf8' },
    )

    return [...new Set(output.split('\n').map((line) => line.trim().replaceAll("'", '')))]
      .filter((key) => key !== '')
      // Prefixes and patterns, not keys: the server builds these by
      // concatenation, and the parts are covered by the keys they produce.
      .filter((key) => !key.endsWith('.'))
      .filter((key) => !['errors.field', 'games.event', 'games.reward'].includes(key))
  }

  it('★ every i18nKey the backend can emit renders in en', () => {
    const missing = backendKeys().filter((key) => {
      const rendered = translateServerKey(key)
      // `translateServerKey` falls back to the generic internal message, so an
      // unknown key is detectable by that exact value coming back.
      return rendered === i18n.t('errors:internal') && key !== 'errors.internal'
    })

    expect(missing).toEqual([])
  })

  it('★ …and in fa', async () => {
    await i18n.changeLanguage('fa')
    try {
      const missing = backendKeys().filter((key) => {
        const rendered = translateServerKey(key)
        return rendered === i18n.t('errors:internal') && key !== 'errors.internal'
      })

      expect(missing).toEqual([])
    } finally {
      await i18n.changeLanguage('en')
    }
  })
})

describe('translateServerKey', () => {
  it('splits the first segment as the namespace — that is the whole contract', () => {
    expect(translateServerKey('errors.seatTaken')).toBe(resources.en.errors.seatTaken)
    expect(translateServerKey('table.system.gameStarted')).toBe(
      resources.en.table.system.gameStarted,
    )
  })

  it('interpolates params from the payload', () => {
    expect(translateServerKey('table.system.seatTaken', { name: 'Sara', seat: 2 })).toContain('Sara')
  })

  it('★ an unknown key degrades to a generic message, never to raw debug output', () => {
    // A user seeing `errors.somethingShippedYesterday` learns nothing and
    // reports a broken page.
    expect(translateServerKey('errors.aKeyFromTheFuture')).toBe(resources.en.errors.internal)
    expect(translateServerKey('nonsense.namespace.key')).toBe(resources.en.errors.internal)
  })

  it('renders Persian after a language change', async () => {
    await i18n.changeLanguage('fa')
    try {
      expect(translateServerKey('errors.seatTaken')).toBe(resources.fa.errors.seatTaken)
    } finally {
      await i18n.changeLanguage('en')
    }
  })
})
