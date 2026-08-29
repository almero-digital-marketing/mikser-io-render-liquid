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
        // `inherits` records that liquid's include shares the caller's scope,
        // and `scope` carries what was in view at the call site.
        assert.deepEqual(r.partials,
            [{ name: 'chrome/nav', args: {}, aliases: [], inherits: true, scope: {} }])
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

// Aliases nested more than one level deep.
//
// A read is only useful as provenance if it names the SOURCE path. Each of
// these rebinds a value to a new name, twice, and the recorded path has to
// survive both hops — a contract naming `field.label` describes nothing a
// document author can act on.
describe('liquid parseReferences: aliases through nesting', () => {
    it('follows a loop binding inside a loop', () => {
        const r = parseReferences(
            '{% for case in data.meta.results.cases %}'
            + '{% for spec in case.specs %}{{ spec.name }}{% endfor %}'
            + '{% endfor %}')
        assert.ok(r.variables.includes('data.meta.results.cases[].specs[].name'),
            `got: ${r.variables.join(', ')}`)
        assert.ok(!r.variables.some(v => v.startsWith('spec.')), 'the local name must not survive')
    })

    it('follows a loop binding through an assign and back into a loop', () => {
        const r = parseReferences(
            '{% assign block = data.meta.enquiry %}'
            + '{% for field in block.fields %}{{ field.label }}{{ field.type }}{% endfor %}')
        assert.ok(r.variables.includes('data.meta.enquiry.fields[].label'),
            `got: ${r.variables.join(', ')}`)
        assert.ok(r.variables.includes('data.meta.enquiry.fields[].type'))
    })

    it('resolves a render argument written inside two loops', () => {
        const r = parseReferences(
            '{% for group in data.meta.groups %}'
            + '{% for item in group.items %}'
            + "{% render 'ui/tag', label: item.title %}"
            + '{% endfor %}{% endfor %}')
        const args = r.partials.find(p => p.name === 'ui/tag')?.args ?? {}
        assert.deepEqual(args, { label: 'data.meta.groups[].items[].title' })
    })

    it('resolves an argument whose value is itself an alias', () => {
        const r = parseReferences(
            '{% assign hero = data.meta.hero %}'
            + "{% render 'ui/tags', tags: hero.tags, rows: hero.tagRows %}")
        const args = r.partials.find(p => p.name === 'ui/tags')?.args ?? {}
        assert.deepEqual(args, { tags: 'data.meta.hero.tags', rows: 'data.meta.hero.tagRows' })
        assert.ok(r.variables.includes('data.meta.hero.tags'))
        assert.ok(r.variables.includes('data.meta.hero.tagRows'))
    })
})

// A fallback filter is a guard.
//
// `{{ hero.title | default: meta.title }}` renders correctly for a document
// that omits hero.title — the layout was written to work without it, exactly as
// with `{% if %}`. Calling it required reports a working page as wrong, and
// `missing` is the one list that must only ever mean "probably wrong".
describe('liquid parseReferences: default: as a guard', () => {
    it('marks a defaulted output as optional', () => {
        const r = parseReferences('{{ data.meta.hero.title | default: data.meta.title }}')
        assert.ok(r.optional.includes('data.meta.hero.title'),
            `optional: ${r.optional.join(', ')}`)
    })

    it('still records it as consumed — optional is not unread', () => {
        const r = parseReferences('{{ data.meta.hero.title | default: data.meta.title }}')
        assert.ok(r.variables.includes('data.meta.hero.title'))
        // The fallback's own source is read too, and unconditionally.
        assert.ok(r.variables.includes('data.meta.title'))
        assert.ok(!r.optional.includes('data.meta.title'))
    })

    it('leaves an undefaulted sibling required', () => {
        const r = parseReferences(
            '{{ data.meta.hero.title | default: data.meta.title }}{{ data.meta.hero.subtitle }}')
        assert.ok(r.optional.includes('data.meta.hero.title'))
        assert.ok(!r.optional.includes('data.meta.hero.subtitle'))
    })

    it('does not treat an ordinary filter as a guard', () => {
        const r = parseReferences('{{ data.meta.hero.title | upcase }}')
        assert.deepEqual(r.optional, [])
    })

    it('marks a defaulted PARTIAL ARGUMENT as optional', () => {
        // liquidjs parses a hash value down to a bare path token and drops the
        // filter, so this is read from the raw tag text — the only place it
        // survives.
        const r = parseReferences(
            "{% render 'ui/tag', label: data.meta.after | default: 'x', other: data.meta.plain %}")
        assert.ok(r.optional.includes('data.meta.after'), `optional: ${r.optional.join(', ')}`)
        assert.ok(!r.optional.includes('data.meta.plain'), 'an undefaulted argument stays required')
    })

    it('resolves the defaulted argument through scope, like any other', () => {
        const r = parseReferences(
            '{% assign r = data.meta.results %}'
            + "{% render 'ui/tag', label: r.afterLabel | default: 'x' %}")
        assert.ok(r.optional.includes('data.meta.results.afterLabel'),
            `optional: ${r.optional.join(', ')}`)
    })
})

// A filtered value is DERIVED, not an alias.
//
// `{% assign rows = c.specs | split: '|' %}` turns a string into a list, so a
// read of `rows[0]` says nothing about `specs` having members. Treating it as an
// alias reports `specs[]` as a required key of a document whose `specs` IS the
// string being split — a key no document can ever satisfy, on a page that
// renders correctly.
describe('liquid parseReferences: derived values are not aliases', () => {
    it('records the source but does not extend paths under it', () => {
        const r = parseReferences(
            "{% assign rows = data.meta.specs | split: '|' %}"
            + '{% for row in rows %}{{ row.name }}{% endfor %}')
        assert.ok(r.variables.includes('data.meta.specs'), 'the real dependency is still recorded')
        assert.ok(!r.variables.some(v => v.startsWith('data.meta.specs[')),
            `fabricated a member of a string: ${r.variables.join(', ')}`)
    })

    it('marks the assign derived so a closure walker knows too', () => {
        // The walker applies these as bindings as well, and has no other way to
        // know the value went through a filter.
        const r = parseReferences("{% assign rows = data.meta.specs | split: '|' %}")
        assert.equal(r.assigns.find(a => a.key === 'rows')?.derived, true)
    })

    it('leaves an UNFILTERED alias working', () => {
        const r = parseReferences('{% assign hero = data.meta.hero %}{{ hero.title }}')
        assert.ok(r.variables.includes('data.meta.hero.title'))
        assert.ok(!r.assigns.find(a => a.key === 'hero')?.derived)
    })

    it('handles the real shape: split, loop, split again', () => {
        // Verbatim from the project that surfaced this.
        const r = parseReferences(
            "{% assign rows = data.meta.results.cases | split: '|' %}"
            + '{% for row in rows %}'
            + "{% assign kv = row | split: ':' %}"
            + '<dt>{{ kv[0] }}</dt>'
            + '{% endfor %}')
        assert.ok(r.variables.includes('data.meta.results.cases'))
        assert.ok(!r.variables.some(v => /results\.cases\[/.test(v)),
            `fabricated: ${r.variables.filter(v => v.includes('cases')).join(', ')}`)
    })
})
