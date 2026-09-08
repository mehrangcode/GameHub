import { describe, expect, it } from 'vitest'
import stylelint from 'stylelint'
import config from '../.stylelintrc.json'

/**
 * Full RTL is correctness, not polish (02-technical-prd.md §8.2). This proves
 * the logical-CSS plugin is enabled *and* that it actually rejects a physical
 * property — asserting the config shape alone would pass with the plugin
 * silently disabled.
 */
describe('logical-CSS enforcement', () => {
  it('enables the logical-css plugin', () => {
    expect(config.plugins).toContain('stylelint-plugin-logical-css')
    expect(config.rules['plugin/use-logical-properties-and-values']).toBeTruthy()
  })

  it('rejects margin-left in a stylesheet', async () => {
    const result = await stylelint.lint({
      code: '.a { margin-left: 1rem; }',
      codeFilename: 'src/probe.module.css',
      config,
    })
    expect(result.errored).toBe(true)
    const rules = result.results.flatMap((r) => r.warnings.map((w) => w.rule))
    expect(rules).toContain('plugin/use-logical-properties-and-values')
  })

  it('accepts the logical equivalent', async () => {
    const result = await stylelint.lint({
      code: '.a { margin-inline-start: 1rem; }',
      codeFilename: 'src/probe.module.css',
      config,
    })
    expect(result.errored).toBeFalsy()
  })
})
