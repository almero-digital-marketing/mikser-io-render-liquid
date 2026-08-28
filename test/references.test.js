// What a liquid template DEPENDS ON — the raw material for the layout contract
// that mikser_layouts_inspect reports.
//
// Two things used to be dropped, and both broke the contract exactly where it
// becomes useful, at the boundary between one file and the next:
//
//   - the ARGUMENTS a partial is called with. `{% render 'ui/tags', tags:
//     hero.tags %}` makes this template depend on `hero.tags`; recording only
//     the partial's NAME left a key consumed one file down invisible.
//   - aliases. A section that opens `{% assign hero = data.meta.hero %}` and
//     then says `hero.tags` names a key that appears in no document.
//
// Aliases are resolved HERE because this is the only place their scope is
// known: the closure walker downstream sees paths, not tags.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseReferences } from '../index.js'

const argsOf = (r, name) => r.partials.find(p => p.name === name)?.args ?? null

describe('liquid parseReferences: partial arguments', () => {
    it('records the arguments a partial is called with', () => {
        const r = parseReferences("{% render 'ui/tags', tags: data.meta.hero.tags, rows: data.meta.hero.tagRows %}")
        assert.deepEqual(argsOf(r, 'ui/tags'), {
            tags: 'data.meta.hero.tags',
            rows: 'data.meta.hero.tagRows',
        })
    })

    it('counts them as references of the CALLING template', () => {
        const r = parseReferences("{% render 'ui/btn', label: data.meta.cta %}")
        assert.ok(r.variables.includes('data.meta.cta'))
    })

    it('ignores literal arguments, which depend on nothing', () => {
        // The path regex is unanchored, so a naive reading of `variant:
        // 'secondary'` yields `secondary` — a variable that does not exist,
        // reported as a dependency.
        const r = parseReferences("{% render 'ui/btn', variant: 'secondary', label: data.meta.cta %}")
        assert.deepEqual(argsOf(r, 'ui/btn'), { label: 'data.meta.cta' })
        assert.ok(!r.variables.includes('secondary'))
    })

    it('merges call sites, so one partial is one entry', () => {
        const r = parseReferences("{% render 'ui/btn', label: a.one %}{% render 'ui/btn', href: a.two %}")
        assert.equal(r.partials.length, 1)
        assert.deepEqual(argsOf(r, 'ui/btn'), { label: 'a.one', href: 'a.two' })
    })

    it('records `with ... as` as an alias', () => {
        const r = parseReferences("{% render 'ui/card' with data.meta.hero as card %}")
        assert.deepEqual(r.partials.find(p => p.name === 'ui/card').aliases,
            [{ from: 'data.meta.hero', to: 'card' }])
    })

    it('reports a plain include with no arguments', () => {
        const r = parseReferences("{% include 'chrome/nav' %}")
        assert.deepEqual(r.partials, [{ name: 'chrome/nav', args: {}, aliases: [] }])
    })
})

describe('liquid parseReferences: aliases', () => {
    it('resolves an assign back to the path it renames', () => {
        const r = parseReferences('{% assign hero = data.meta.hero %}{{ hero.title }}')
        assert.ok(r.variables.includes('data.meta.hero.title'),
            `expected the resolved path, got: ${r.variables.join(', ')}`)
        assert.ok(!r.variables.includes('hero.title'), 'the local name must not survive')
    })

    it('reports the assign itself, so a caller can see the renaming', () => {
        const r = parseReferences('{% assign hero = data.meta.hero %}')
        assert.deepEqual(r.assigns, [{ key: 'hero', from: 'data.meta.hero' }])
    })

    it('resolves an assign written in terms of another assign', () => {
        const r = parseReferences(
            '{% assign hero = data.meta.hero %}{% assign o = hero.origin %}{{ o.label }}')
        assert.ok(r.variables.includes('data.meta.hero.origin.label'))
    })

    it('marks a for-item as an ELEMENT, not as the collection', () => {
        // `cases.specs` would be a key that exists on no document — the specs
        // are on each case, not on the list of them.
        const r = parseReferences('{% for c in data.meta.cases %}{{ c.specs }}{% endfor %}')
        assert.ok(r.variables.includes('data.meta.cases[].specs'))
        assert.ok(!r.variables.includes('data.meta.cases.specs'))
    })

    it('resolves arguments through the loop they are written in', () => {
        const r = parseReferences(
            "{% for c in data.meta.cases %}{% render 'ui/tag', label: c.title %}{% endfor %}")
        assert.deepEqual(argsOf(r, 'ui/tag'), { label: 'data.meta.cases[].title' })
    })

    it('does NOT leak a loop item past the end of its loop', () => {
        const r = parseReferences('{% for c in data.meta.cases %}{{ c.a }}{% endfor %}{{ c.b }}')
        assert.ok(r.variables.includes('data.meta.cases[].a'))
        assert.ok(r.variables.includes('c.b'), 'outside the loop it is a different, unresolved name')
        assert.ok(!r.variables.includes('data.meta.cases[].b'))
    })
})

describe('liquid parseReferences: shape', () => {
    it('returns the same keys as every other engine, so no caller branches', () => {
        for (const source of ['', '{{ a }}', '{% if %}']) {
            const r = parseReferences(source)
            for (const key of ['variables', 'partials', 'iterations', 'assigns']) {
                assert.ok(key in r, `${JSON.stringify(source)} is missing ${key}`)
            }
        }
    })
})
