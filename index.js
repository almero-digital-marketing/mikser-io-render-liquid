import { Liquid } from 'liquidjs'
import { AsyncLocalStorage } from 'node:async_hooks'

let engine

// Per-render context propagated through LiquidJS's async chain via
// Node's AsyncLocalStorage. The render() function below sets the
// context; the wrapped _parsePartialFile / _parseLayoutFile (called
// by IncludeTag.render, RenderTag.render, LayoutTag.render for each
// include/render/layout invocation) read it back to report partial
// usage to the engine.
const renderContext = new AsyncLocalStorage()

function trackPartial(name) {
    const ctx = renderContext.getStore()
    if (!ctx?.track || !ctx.layouts || !name) return
    const layout = ctx.layouts[name]
    if (layout?.id) ctx.track.partial(layout.id)
}

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

        // Wrap LiquidJS's per-invocation partial/layout loaders.
        // IncludeTag.render and RenderTag.render call
        // engine._parsePartialFile(filepath, …) for each `{% include %}` /
        // `{% render %}`; LayoutTag.render calls
        // engine._parseLayoutFile(filepath, …) for `{% layout %}`.
        // These fire on every invocation — even when the partial's
        // parse is cache-hit — so they're the right granularity for
        // tracking per-render usage.
        const _parsePartialFile = engine._parsePartialFile.bind(engine)
        engine._parsePartialFile = function (file, sync, currentFile) {
            trackPartial(file)
            return _parsePartialFile(file, sync, currentFile)
        }
        const _parseLayoutFile = engine._parseLayoutFile.bind(engine)
        engine._parseLayoutFile = function (file, sync, currentFile) {
            trackPartial(file)
            return _parseLayoutFile(file, sync, currentFile)
        }
    }
    runtime.liquid = (source, data) => engine.parseAndRender(source, data)
}

export async function render({ entity, runtime, state, track }) {
    // Expose every function on runtime as a Liquid filter, so render-
    // helper plugins (markdown, href, ...) keep working without per-
    // plugin glue.
    for (let key in runtime) {
        if (typeof runtime[key] === 'function') {
            engine.registerFilter(key, (input, ...args) => runtime[key](input, ...args))
        }
    }
    const source = entity.layout.content ?? ''
    const layouts = state?.layouts?.layouts ?? {}
    try {
        // Establish the render context BEFORE parsing/rendering. Any
        // internal partial or layout resolution inherits it through
        // the async chain and reports the resolved name to the
        // engine's track via the wrapped methods above.
        return await renderContext.run(
            { track, layouts },
            () => runtime.liquid(source, runtime),
        )
    } catch (err) {
        // LiquidJS RenderError/ParseError carry a `token` with file/line/col.
        const token = err?.token
        err.layoutUri ??= token?.file || entity.layout.uri
        if (token?.line && err.line == null) err.line = token.line
        if (token?.col && err.column == null) err.column = token.col
        throw err
    }
}

// v9 factory — ADR-0010.
export function renderLiquid(options = {}) {
    return { name: options.name ?? 'liquid', options, load, render }
}
