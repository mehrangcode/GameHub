import { expect, test } from '@playwright/test'

test('the welcome route renders', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome')
})

test('an unknown path renders the 404 page', async ({ page }) => {
  await page.goto('/definitely-not-a-route')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not found')
})
