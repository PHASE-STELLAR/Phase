/** Run against a local server with public flags 174/175 enabled.
 * Install Playwright outside the repo and set PHASE_PLAYWRIGHT_MODULE to its index.mjs,
 * or install it in the caller's environment. No wallet credentials or signing is used.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
const { chromium } = await import(process.env.PHASE_PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.PHASE_SMOKE_BASE_URL || 'http://127.0.0.1:3100'
const output = process.env.PHASE_SMOKE_OUTPUT || '/tmp/phase-mobile-validation'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.PHASE_CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
const results = []
try {
  for (const width of [360, 390, 768, 1024]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 768, hasTouch: width < 768, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    for (const route of ['/forge', '/chamber']) {
      await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await page.locator('[data-mobile-layout]').waitFor()
      await page.waitForTimeout(500)
      const state = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
      if (state.width < state.scroll) throw new Error(`${route} overflows at ${width}`)
      await page.screenshot({ path: path.join(output, `${route.slice(1)}-${width}.png`), fullPage: true })
      if (errors.length) throw new Error(errors.join('\n'))
      results.push({ route, width, horizontalOverflow: false, pageErrors: 0 })
    }
    await context.close()
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base + '/chamber', { waitUntil: 'domcontentloaded' })
  const opener = page.getByRole('button', { name: 'Chamber controls', exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  if (!await dialog.evaluate(el => el.contains(document.activeElement))) throw new Error('Sheet focus escaped')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.activeElement?.textContent === 'Chamber controls')
  if (!await opener.evaluate(el => el === document.activeElement)) throw new Error('Opener focus was not restored')
  await page.goto(base + '/link/quest/quest_connect_wallet', { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Review incoming link' }).waitFor()
  if (!await page.evaluate(() => !!sessionStorage.getItem('phase:inbound-intent:v1'))) throw new Error('Intent was not persisted')
  await page.goto(base + '/forge', { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Review incoming link' }).waitFor()
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()
  const prompt = page.locator('textarea').first()
  await prompt.fill('Preserve this draft')
  await page.getByRole('button', { name: 'How it works', exact: true }).click()
  await page.keyboard.press('Escape')
  if (await prompt.inputValue() !== 'Preserve this draft') throw new Error('Draft was lost')
  await page.setViewportSize({ width: 390, height: 500 })
  await page.waitForTimeout(200)
  if (!await page.locator('[data-mobile-layout]').evaluate(el => Math.abs(el.getBoundingClientRect().height - visualViewport.height) < 2)) throw new Error('Viewport height is stale')
  if (errors.length) throw new Error(errors.join('\n'))
  results.push({ sheetFocus: true, escape: true, restoredOpener: true, persistedIntent: true, strippedQueryRecovery: true, promptPreserved: true, resizedViewport: true, pageErrors: 0 })
  await context.close()
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
} finally { await browser.close() }
