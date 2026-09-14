import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * ★★ Journey J2, end to end — S43, and the product's central promise.
 *
 * *A friend clicks a link and is playing in under five seconds, with no
 * account. Their coins are held. When they sign up, they land back in the same
 * seat.*
 *
 * The guest runs in a **second browser context**, which is a genuinely separate
 * cookie jar — the equivalent of a private window, and the only honest way to
 * test "works with no session". Sharing a context would let the host's cookies
 * answer for the guest and the whole test would prove nothing.
 *
 * Requires a live API and a live Vite dev server (see `playwright.config.ts`).
 */

const PASSWORD = 'correct-horse-battery'

async function register(page: Page, email: string): Promise<void> {
  await page.goto('/register')
  await page.getByLabel('Display name').fill('Mehrang')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL('/')
}

/**
 * Mints a table and an invite through the API using the page's own cookies.
 * Table creation has no UI yet (it lands with matchmaking in M3), and driving
 * it through the API keeps this test about the *journey* rather than about a
 * form that does not exist.
 */
async function hostTable(context: BrowserContext): Promise<{ tableId: string; code: string }> {
  const csrf = (await context.cookies()).find((cookie) => cookie.name === 'csrf')?.value ?? ''
  const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf }

  const table = await context.request.post('/api/v1/tables', {
    headers,
    data: { gameSlug: 'fixture', seatCount: 4, options: {} },
  })
  expect(table.ok()).toBeTruthy()
  const tableId = (await table.json()).id as string

  const invite = await context.request.post(`/api/v1/tables/${tableId}/invites`, {
    headers,
    data: {},
  })
  expect(invite.ok()).toBeTruthy()

  return { tableId, code: (await invite.json()).code as string }
}

test('★★ link → seated with no account → signup → same seat, coins vested', async ({ browser }) => {
  const hostContext = await browser.newContext()
  const hostPage = await hostContext.newPage()
  const suffix = Date.now().toString(36)

  await register(hostPage, `host-${suffix}@test.dev`)
  const { tableId, code } = await hostTable(hostContext)

  // ── The friend, in a genuinely separate session ─────────────────────────
  const guestContext = await browser.newContext()
  const guestPage = await guestContext.newPage()

  const started = Date.now()
  await guestPage.goto(`/t/${code}`)

  // ★ The pre-join screen renders with an empty cookie jar.
  await expect(guestPage.getByText('No account needed.')).toBeVisible()
  await expect(guestPage.getByRole('textbox')).toHaveCount(1)

  await guestPage.getByLabel('Your name').fill('Sara')
  await guestPage.getByRole('button', { name: /Play now/ }).click()

  await expect(guestPage).toHaveURL(`/table/${tableId}`)
  const elapsed = Date.now() - started

  // 02 §12: click to seated under five seconds, measured locally.
  expect(elapsed).toBeLessThan(5_000)

  // ★ No account was created — the identity is a guest.
  const me = await guestContext.request.get('/api/v1/auth/me')
  expect((await me.json()).kind).toBe('guest')

  // ── A reload keeps the seat ─────────────────────────────────────────────
  await guestPage.reload()
  await expect(guestPage).toHaveURL(`/table/${tableId}`)

  // ── The nudge, and the claim ────────────────────────────────────────────
  await expect(guestPage.getByText(/coins waiting/)).toBeVisible()
  await guestPage.getByRole('button', { name: 'Keep my coins' }).click()

  await guestPage.getByLabel('Email').fill(`sara-${suffix}@test.dev`)
  await guestPage.getByLabel('Password').fill(PASSWORD)
  await guestPage.getByRole('button', { name: /Create account and keep playing/ }).click()

  // ★★ Back at the SAME table, from the server's own `redirectTo` — decided by
  // the transaction that preserved the seat, never reconstructed client-side.
  await expect(guestPage).toHaveURL(`/table/${tableId}`)

  const claimed = await guestContext.request.get('/api/v1/auth/me')
  expect((await claimed.json()).kind).toBe('user')

  // ★ And the coins are now vested rather than provisional.
  const wallet = await guestContext.request.get('/api/v1/wallet')
  const coin = (await wallet.json()).balances.find(
    (balance: { asset: string }) => balance.asset === 'COIN',
  )
  expect(coin.status).toBe('VESTED')

  await hostContext.close()
  await guestContext.close()
})

test('an expired and an unknown code are indistinguishable in the UI', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto('/t/NEVEREXISTED')
  await expect(page.getByRole('alert')).toBeVisible()
  const unknown = await page.getByRole('alert').textContent()

  await page.goto('/t/ALSOFAKE99')
  await expect(page.getByRole('alert')).toBeVisible()

  // 07 §5.2: any difference here turns the route into an oracle for
  // enumerating live invite codes.
  expect(await page.getByRole('alert').textContent()).toBe(unknown)

  await context.close()
})

test('★ the guest name is remembered, so a refresh does not re-prompt', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto('/t/SEEDDEMO')
  await page.getByLabel('Your name').fill('Sara')
  await page.reload()

  await expect(page.getByLabel('Your name')).toHaveValue('Sara')

  await context.close()
})
