import { expect, test } from '@playwright/test'

/**
 * Smoke — runs against a **live backend**, so it proves the Vite proxy, the
 * cookie session and the registry are all actually wired, which no jsdom test
 * can.
 */

test('the welcome page renders its cards from the real registry', async ({ page }) => {
  await page.goto('/')

  // Registry-driven: the count comes from `GET /api/v1/games`, not from a
  // constant in the frontend.
  await expect(page.getByRole('heading', { name: 'Start a table' }).first()).toBeVisible()
  await expect(page.getByText('Coming soon').first()).toBeVisible()
})

test('an unknown path renders the 404 page', async ({ page }) => {
  await page.goto('/definitely-not-a-route')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found')
})

test('★ switching to Persian flips dir and lang on <html>', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: 'Switch language' }).click()

  // The whole RTL layout rests on these two attributes.
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect(page.locator('html')).toHaveAttribute('lang', 'fa')

  await page.reload()
  // Persisted by i18next's localStorage cache — the choice survives a reload.
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
})

test('the theme toggle stamps data-theme', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: 'Toggle theme' }).click()

  await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/)
})
