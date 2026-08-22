import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Liquid } from 'liquidjs'

// Why this file exists: every function on `runtime` is registered as a Liquid
// filter, so WHICH filters exist depends on which render plugins are loaded.
// With LiquidJS's default strictFilters:false, an unknown filter is a no-op
// that returns its input — making a missing plugin indistinguishable from a
// working helper. `{{ '/contacts' | href }}` renders "/contacts" either way.
describe('strictFilters', () => {
    // The engine options this plugin builds, mirrored so the behavioural
    // claims below are about LiquidJS itself, not about a mock.
    const engine = (over = {}) => new Liquid({ extname: '.liquid', strictFilters: true, ...over })

    it('an unknown filter throws instead of passing the input through', async () => {
        await assert.rejects(
            () => engine().parseAndRender("{{ '/contacts' | href }}"),
            /undefined filter/i,
        )
    })

    it('a registered filter still works', async () => {
        const e = engine()
        e.registerFilter('href', (input) => `../${String(input).replace(/^\//, '')}`)
        assert.equal(await e.parseAndRender("{{ '/contacts' | href }}"), '../contacts')
    })

    it('shows what the old default did — the reason for the change', async () => {
        // Silent pass-through: the string comes back unchanged and nothing
        // anywhere reports that `href` does not exist.
        const loose = new Liquid({ strictFilters: false })
        assert.equal(await loose.parseAndRender("{{ '/contacts' | href }}"), '/contacts')
    })

    it('strictVariables is NOT enabled — undefined variables stay empty', async () => {
        // Deliberate: templates legitimately rely on this, and turning it on
        // is a far larger change than the filter issue.
        assert.equal(await engine().parseAndRender('[{{ nope }}]'), '[]')
    })

    it('a project can put the old behaviour back', async () => {
        // `...config` is spread after the defaults in load(), so userland wins.
        const e = engine({ strictFilters: false })
        assert.equal(await e.parseAndRender("{{ '/x' | href }}"), '/x')
    })
})

describe('the plugin sets it', () => {
    it('index.js enables strictFilters, and spreads config afterwards', async () => {
        const src = await readFile(new URL('../index.js', import.meta.url), 'utf8')
        assert.match(src, /strictFilters: true/)
        // Order is load-bearing: config must come last to remain an override.
        assert.ok(src.indexOf('strictFilters: true') < src.indexOf('...config'),
                  'config must be spread AFTER the defaults')
    })

    it('does not enable strictVariables', async () => {
        const src = await readFile(new URL('../index.js', import.meta.url), 'utf8')
        assert.ok(!/strictVariables:\s*true/.test(src))
    })
})
