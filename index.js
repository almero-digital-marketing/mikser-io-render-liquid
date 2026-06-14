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

// Static reference scan for `mikser-io-layouts`'s inspect() primitive.
// Uses LiquidJS's own parser to walk the template AST. Returns the
// variables, partials, and iterations the source mentions — the
// authoring-time view of "what could this template reference."
// The runtime-precise answer ("what did each render actually touch")
// lives in mikser-io's manifest refClosure.
//
// AST nodes we care about:
//   - Output      → output expression, e.g. {{ post.title | filter }}
//   - IncludeTag  → {% include 'name' %} — partial reference
//   - RenderTag   → {% render 'name' %}  — partial reference
//   - LayoutTag   → {% layout 'name' %}  — partial reference (the
//                   parent the current template extends)
//   - ForTag      → {% for x in y %}     — iteration
//   - IfTag       → recurse into branches for variable refs
//   - UnlessTag   → same
//   - CaseTag     → same
//
// Other tag types are walked-through (their nested templates are
// scanned) but don't produce a top-level entry.
const LIQUID_IDENT_PATH = /([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)/
export function parseReferences(source) {
    if (typeof source !== 'string' || !source) {
        return { variables: [], partials: [], iterations: [] }
    }
    const probe = new Liquid({})
    let templates
    try {
        templates = probe.parse(source)
    } catch (err) {
        return { variables: [], partials: [], iterations: [], parseError: err.message }
    }

    const variables  = new Set()
    const partials   = new Set()
    const iterations = []

    function extractPath(expr) {
        const m = LIQUID_IDENT_PATH.exec(String(expr ?? '').trim())
        return m?.[1] ?? null
    }

    // Walk a LiquidJS Value (used in {% if %}, {% case %}, etc.) and
    // collect identifier paths. Value has `.initial.postfix[]`; each
    // postfix item with `props` represents one identifier path; props
    // are PropertyAccessToken[] whose `.content` joins to the path.
    function collectValuePaths(value, sink) {
        const postfix = value?.initial?.postfix
        if (!Array.isArray(postfix)) return
        for (const item of postfix) {
            if (!Array.isArray(item?.props) || !item.props.length) continue
            const segments = item.props
                .map(p => typeof p?.content === 'string' ? p.content : null)
                .filter(Boolean)
            if (segments.length) sink.add(segments.join('.'))
        }
    }

    function getText(maybeWrapped) {
        if (maybeWrapped == null) return null
        if (typeof maybeWrapped === 'string') return maybeWrapped
        if (typeof maybeWrapped.getText === 'function') {
            try { return maybeWrapped.getText() } catch { return null }
        }
        return null
    }

    function walk(nodes) {
        if (!Array.isArray(nodes)) return
        for (const node of nodes) {
            const kind = node?.constructor?.name
            switch (kind) {
                case 'Output': {
                    // Token content is everything between `{{` and `}}`,
                    // including filters. Leading identifier path is the
                    // variable ref.
                    const content = node.token?.content ?? ''
                    const path = extractPath(content)
                    if (path) variables.add(path)
                    break
                }
                case 'IncludeTag':
                case 'RenderTag':
                case 'LayoutTag': {
                    const file = getText(node.file)
                    if (file) partials.add(file)
                    // Render/include accept a body in some dialects; walk it.
                    if (Array.isArray(node.templates)) walk(node.templates)
                    break
                }
                case 'ForTag': {
                    const collection = getText(node.collection)
                    if (collection) {
                        const item = node.variable ?? '(for)'
                        iterations.push({ item, collection })
                        const path = extractPath(collection)
                        if (path) variables.add(path)
                    }
                    if (Array.isArray(node.templates))     walk(node.templates)
                    if (Array.isArray(node.elseTemplates)) walk(node.elseTemplates)
                    break
                }
                case 'IfTag':
                case 'UnlessTag':
                case 'CaseTag': {
                    // Branches live on .branches (each has .templates) and .elseTemplates.
                    // Branch condition is a LiquidJS Value whose `.initial.postfix[]`
                    // expresses identifier paths; walk them rather than relying on
                    // string forms that aren't reliably exposed.
                    if (Array.isArray(node.branches)) {
                        for (const branch of node.branches) {
                            collectValuePaths(branch.value, variables)
                            if (Array.isArray(branch.templates)) walk(branch.templates)
                        }
                    }
                    if (Array.isArray(node.elseTemplates)) walk(node.elseTemplates)
                    break
                }
                default: {
                    // Generic walk — many tags expose nested .templates.
                    if (Array.isArray(node?.templates))     walk(node.templates)
                    if (Array.isArray(node?.elseTemplates)) walk(node.elseTemplates)
                    break
                }
            }
        }
    }

    walk(templates)

    return {
        variables:  Array.from(variables).sort(),
        partials:   Array.from(partials).sort(),
        iterations,
    }
}

// v9 factory — ADR-0010.
export function renderLiquid(options = {}) {
    return { name: options.name ?? 'liquid', options, load, render, parseReferences }
}
