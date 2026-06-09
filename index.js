import { Liquid } from 'liquidjs'

let engine

// Match LiquidJS's include/render/layout tags in source. The first
// quoted argument is the partial name relative to `root` (the layouts
// folder), without extension. Matches the layouts plugin's map key.
const LIQUID_INCLUDE_RE = /\{%-?\s*(?:include|render|layout)\s+['"]([^'"]+)['"]/g

export function load({ runtime, options, config }) {
    if (!engine) {
        // `root` still points at the layouts folder so LiquidJS's own
        // `{% include 'partial' %}` / `{% layout 'wrapper' %}`
        // directives can resolve from disk. The top-level layout body
        // is rendered from `entity.layout.content` (populated by the
        // layouts plugin and stripped of YAML by front-matter) —
        // single source of truth for layout bodies.
        engine = new Liquid({
            root: options.layoutsFolder,
            extname: '.liquid',
            cache: !options.watch,
            ...config,
        })
    }
    runtime.liquid = (source, data) => engine.parseAndRender(source, data)
}

export async function render({ entity, runtime, state, track }) {
    // Expose every function on runtime as a Liquid filter,
    // so render-helper plugins (markdown, href, ...) keep working without per-plugin glue.
    for (let key in runtime) {
        if (typeof runtime[key] === 'function') {
            engine.registerFilter(key, (input, ...args) => runtime[key](input, ...args))
        }
    }
    const source = entity.layout.content ?? ''
    // Report partial-edge deps to the engine. Names captured from
    // `{% include 'X' %}` etc. resolve to entity ids via the layouts
    // plugin's name map exposed at state.layouts.layouts.
    if (track && state?.layouts?.layouts) {
        const layouts = state.layouts.layouts
        const seen = new Set()
        for (const match of source.matchAll(LIQUID_INCLUDE_RE)) {
            const name = match[1]
            if (seen.has(name)) continue
            seen.add(name)
            const layout = layouts[name]
            if (layout?.id) track.partial(layout.id)
        }
    }
    try {
        return await runtime.liquid(source, runtime)
    } catch (err) {
        // LiquidJS RenderError/ParseError carry a `token` with file/line/col.
        const token = err?.token
        err.layoutUri ??= token?.file || entity.layout.uri
        if (token?.line && err.line == null) err.line = token.line
        if (token?.col && err.column == null) err.column = token.col
        throw err
    }
}
