// Filters must resolve against the runtime of the render that is CALLING them,
// not the one that registered them last.
//
// The engine is module-level and registerFilter is a global mutation, so when
// each render re-registered every runtime function as a filter, the last
// render to start owned the binding for every render still in flight. Renders
// are concurrent, and `{% render %}` / `{% include %}` reads a partial from
// disk — an await point that guarantees the overlap.
//
// The symptom in production was an `asset` url computed from a DIFFERENT
// page's entity: a relative prefix with the wrong number of `..` for the page
// it was emitted on. Well-formed, pointing at nothing, green build, and
// unstable between builds because it followed render order. `href` and
// `resource` compute from entity.destination too, so all of them were exposed.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { load, render } from '../index.js'

let layoutsFolder

// A runtime whose `mark` filter answers with this render's own identity —
// standing in for asset()/href(), which answer from this render's entity.
function makeRuntime(id) {
    const runtime = { mark: () => id }
    load({ runtime, options: { layoutsFolder }, config: {} })
    return runtime
}

const entityFor = (body) => ({
    id: `/documents/${body}.yml`,
    layout: { uri: 'page.liquid', content: body },
})

const renderWith = (runtime, body) =>
    render({ entity: entityFor(body), runtime, state: {}, track: {} })

describe('concurrent renders do not steal each other filters', () => {
    before(async () => {
        layoutsFolder = await mkdtemp(path.join(tmpdir(), 'liquid-concurrent-'))
        await mkdir(path.join(layoutsFolder, 'ui'), { recursive: true })
        // The partial is the point: reading it from disk is the await during
        // which another render can register over this one's filters.
        await writeFile(path.join(layoutsFolder, 'ui', 'mark.liquid'), "{{ '' | mark }}")
    })
    after(() => rm(layoutsFolder, { recursive: true, force: true }))

    it('each render sees its own runtime through a partial', async () => {
        const a = makeRuntime('A')
        const b = makeRuntime('B')

        // Both in flight at once. A registers, hits the partial read, and B
        // registers while A is suspended — the exact interleaving that was
        // silently producing another page's answer.
        const [outA, outB] = await Promise.all([
            renderWith(a, "{% render 'ui/mark' %}"),
            renderWith(b, "{% render 'ui/mark' %}"),
        ])

        assert.equal(outA, 'A', 'render A resolved a filter against another render\'s runtime')
        assert.equal(outB, 'B', 'render B resolved a filter against another render\'s runtime')
    })

    it('holds with many overlapping renders', async () => {
        const ids = Array.from({ length: 12 }, (_, i) => `R${i}`)
        const outputs = await Promise.all(
            ids.map(id => renderWith(makeRuntime(id), "{% render 'ui/mark' %}")),
        )
        assert.deepEqual(outputs, ids,
            'every render must answer with its own identity, whatever the interleaving')
    })

    it('still works with no partial, where nothing suspends', async () => {
        const a = makeRuntime('A')
        assert.equal(await renderWith(a, "{{ '' | mark }}"), 'A')
    })
})
