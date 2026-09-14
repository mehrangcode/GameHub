import MockAdapter from 'axios-mock-adapter'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api } from '../../src/api/client'
import { WelcomePage } from '../../src/features/welcome/WelcomePage'
import i18n from '../../src/i18n'
import { gameFixture, renderRouted } from '../helpers/render'

/**
 * S41 — the welcome page, and one of M0's exit criteria.
 *
 * ★ The headline test is "**a sixth game appears with no component change**".
 * It is the client half of P5 — *game #6 must not touch games #1–5* — and it is
 * checked the only way that means anything: by adding a game the frontend has
 * never heard of to the mocked payload and asserting a card renders for it.
 * A hard-coded list would pass every other test in this file.
 */

let mock: MockAdapter

const FIVE = [
  gameFixture({ slug: 'shelem' }),
  gameFixture({
    slug: 'poker',
    preview: { ...gameFixture().preview, nameKey: 'games.poker.name', taglineKey: 'games.poker.tagline' },
  }),
  gameFixture({
    slug: 'blackjack',
    preview: {
      ...gameFixture().preview,
      nameKey: 'games.blackjack.name',
      taglineKey: 'games.blackjack.tagline',
    },
  }),
  gameFixture({
    slug: 'chess',
    preview: { ...gameFixture().preview, nameKey: 'games.chess.name', taglineKey: 'games.chess.tagline' },
  }),
  gameFixture({
    slug: 'sudoku',
    minPlayers: 1,
    maxPlayers: 1,
    playableCounts: [1],
    preview: {
      ...gameFixture().preview,
      nameKey: 'games.sudoku.name',
      taglineKey: 'games.sudoku.tagline',
    },
  }),
]

beforeEach(async () => {
  await i18n.changeLanguage('en')
  mock = new MockAdapter(api)
  mock.onGet('/rewards/rules').reply(200, {
    rules: [{ id: 'shelem', gameSlug: 'shelem', base: 80 }],
    caps: {},
    premiumMultiplier: 1.5,
    integrityFactors: {},
  })
})

afterEach(() => {
  mock.restore()
})

describe('the game grid', () => {
  it('renders a card per game from the API', async () => {
    mock.onGet('/games').reply(200, FIVE)

    renderRouted(<WelcomePage />)

    await waitFor(() => {
      expect(screen.getByText('Shelem')).toBeInTheDocument()
    })
    expect(screen.getByText("Texas Hold'em")).toBeInTheDocument()
    expect(screen.getByText('Blackjack')).toBeInTheDocument()
    expect(screen.getByText('Chess')).toBeInTheDocument()
    expect(screen.getByText('Sudoku')).toBeInTheDocument()
  })

  it('★ a SIXTH game the frontend has never heard of appears — P5 on the client', async () => {
    mock.onGet('/games').reply(200, [
      ...FIVE,
      gameFixture({
        slug: 'hokm',
        comingSoon: false,
        preview: {
          ...gameFixture().preview,
          // A key with no entry in the bundle, exactly as a brand-new game
          // would arrive before anyone writes its strings.
          nameKey: 'games.hokm.name',
          taglineKey: 'games.hokm.tagline',
        },
      }),
    ])

    renderRouted(<WelcomePage />)

    // ★ No component was changed, no registry edited, no icon added. The card
    // renders — falling back to the slug for its name rather than printing a
    // raw i18n key at somebody.
    await waitFor(() => {
      expect(screen.getByText('hokm')).toBeInTheDocument()
    })
    expect(screen.getAllByRole('link').length + screen.getAllByRole('group').length).toBe(6)
  })

  it('marks a coming-soon game and does NOT make it a link', async () => {
    mock.onGet('/games').reply(200, [gameFixture({ slug: 'shelem', comingSoon: true })])

    renderRouted(<WelcomePage />)

    await waitFor(() => {
      expect(screen.getByText('Coming soon')).toBeInTheDocument()
    })
    // Focusable and announced as disabled, so it advertises the game without
    // leading to a page that cannot do anything yet.
    const card = screen.getByRole('group')
    expect(card).toHaveAttribute('aria-disabled', 'true')
    expect(card).toHaveAttribute('tabindex', '0')
  })

  it('a playable game IS a link, and is keyboard reachable', async () => {
    mock.onGet('/games').reply(200, [gameFixture({ slug: 'shelem', comingSoon: false })])

    renderRouted(<WelcomePage />)

    await waitFor(() => {
      expect(screen.getByRole('link')).toHaveAttribute('href', '/games/shelem')
    })
  })

  it('shows the published coin rate from the public rate card', async () => {
    mock.onGet('/games').reply(200, [gameFixture({ slug: 'shelem', comingSoon: false })])

    renderRouted(<WelcomePage />)

    // 10 §11: the rate is public, so the page can say what a game pays before
    // anybody signs up.
    await waitFor(() => {
      expect(screen.getByText('80')).toBeInTheDocument()
    })
  })

  it('★ a failed rate card costs the rates, never the games', async () => {
    mock.onGet('/games').reply(200, [gameFixture({ slug: 'shelem', comingSoon: false })])
    mock.onGet('/rewards/rules').reply(500)

    renderRouted(<WelcomePage />)

    await waitFor(() => {
      expect(screen.getByText('Shelem')).toBeInTheDocument()
    })
    expect(screen.queryByText('80')).not.toBeInTheDocument()
  })
})

describe('states', () => {
  it('shows skeletons while loading, not a bare spinner', async () => {
    mock.onGet('/games').reply(() => new Promise(() => {}))

    renderRouted(<WelcomePage />)

    // Skeletons keep the layout from jumping when the cards land.
    await waitFor(() => {
      expect(screen.getByLabelText('Loading…')).toBeInTheDocument()
    })
  })

  it('shows an error with a retry that actually refetches', async () => {
    mock.onGet('/games').replyOnce(500)
    mock.onGet('/games').reply(200, FIVE)

    renderRouted(<WelcomePage />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => {
      expect(screen.getByText('Shelem')).toBeInTheDocument()
    })
  })

  it('shows an empty state rather than a blank page', async () => {
    mock.onGet('/games').reply(200, [])

    renderRouted(<WelcomePage />)

    await waitFor(() => {
      expect(screen.getByText('No games are available yet.')).toBeInTheDocument()
    })
  })
})

describe('localization', () => {
  it('★ renders Persian names — the payload carries keys, never "Shelem"', async () => {
    mock.onGet('/games').reply(200, FIVE)
    // Wrapped because a language change re-renders every subscriber.
    await act(async () => {
      await i18n.changeLanguage('fa')
    })

    try {
      renderRouted(<WelcomePage />)

      // The API answer is byte-identical in both languages; only the client
      // differs. That is 02 §8.1 working.
      await waitFor(() => {
        expect(screen.getByText('شلم')).toBeInTheDocument()
      })
      expect(screen.queryByText('Shelem')).not.toBeInTheDocument()
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en')
      })
    }
  })

  it('★ no hard-coded English game name appears in the component source', async () => {
    // The names above come from the bundle. If a component ever inlines one,
    // the Persian build silently keeps an English word in it.
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const source = readFileSync(path.resolve('src/features/welcome/GameCard.tsx'), 'utf8')

    for (const name of ['Shelem', 'Blackjack', 'Sudoku', 'Texas']) {
      expect(source).not.toContain(name)
    }
  })
})
