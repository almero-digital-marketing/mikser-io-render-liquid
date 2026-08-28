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
            // LiquidJS defaults strictFilters to false, which makes an
            // unknown filter a no-op that returns its input unchanged.
            // That is a bad default HERE specifically, because which
            // filters exist depends on which render plugins are loaded:
            // every function on `runtime` is registered as one below. So
            // `{{ '/contacts' | href }}` with hrefUrlHelpers() missing from the
            // plugin list renders the string back, and a missing plugin is
            // indistinguishable from a working helper.
            //
            // strictVariables is deliberately NOT set. It would throw on
            // any undefined variable, which templates legitimately rely on
            // being empty — a far larger change than this issue is about.
            strictFilters: true,
            // Spread last, so a project can put either back.
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
        return { variables: [], partials: [], iterations: [], assigns: [] }
    }
    const probe = new Liquid({})
    let templates
    try {
        templates = probe.parse(source)
    } catch (err) {
        return { variables: [], partials: [], iterations: [], assigns: [], parseError: err.message }
    }

    const variables  = new Set()
    // Keyed by partial name and MERGED across call sites: `ui/btn` rendered
    // eight times with different labels is one partial with the union of what
    // it is ever passed, which is the question a contract answers.
    const partials   = new Map()
    const iterations = []
    const assigns    = []

    // The path a tag ARGUMENT refers to, or null if it is a literal.
    //
    // Type, not text: LIQUID_IDENT_PATH is unanchored, so run over the source
    // of `variant: 'secondary'` it happily returns `secondary` — a variable
    // that does not exist, reported as a dependency. A QuotedToken is a value
    // the template supplied and depends on nothing.
    function pathOfToken(token) {
        const kind = token?.constructor?.name
        if (kind === 'PropertyAccessToken') return token.getText?.() ?? null
        // A filtered or otherwise compound argument arrives as a Value, whose
        // identifier paths the branch walker already knows how to read.
        if (token?.initial) {
            const found = new Set()
            collectValuePaths(token, found)
            return found.size ? [...found][0] : null
        }
        return null
    }

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

    // An alias resolved through the scopes in view. Only the first segment can
    // be one: `c.specs` where `c` is the item of `for c in r.cases` is
    // `r.cases[].specs`, and the tail is property access on whatever that was.
    function deref(path, scope) {
        if (!path) return path
        const [head, ...rest] = String(path).split('.')
        const base = scope[head]
        return base ? [base, ...rest].join('.') : path
    }

    const record = (path, scope) => {
        const resolved = deref(path, scope)
        if (resolved) variables.add(resolved)
        return resolved
    }

    function walk(nodes, scope = {}) {
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
                    if (path) record(path, scope)
                    break
                }
                case 'IncludeTag':
                case 'RenderTag':
                case 'LayoutTag': {
                    const file = getText(node.file)
                    if (file) {
                        const entry = partials.get(file) ?? { name: file, args: {}, aliases: [] }
                        // The arguments a partial is called WITH. Dropping
                        // these was the hole: `{% render 'ui/btn', label:
                        // r.more %}` makes this template depend on `r.more`,
                        // and nothing recorded that — so a contract built from
                        // one file could not see a key consumed one file down.
                        for (const [name, token] of Object.entries(node.hash?.hash ?? {})) {
                            const path = pathOfToken(token)
                            if (!path) continue
                            // Resolved HERE, in the scope the call sits in,
                            // before the partial ever runs — so a partial
                            // rendered inside a loop reports what the loop
                            // hands it, not the loop variable's local name.
                            entry.args[name] = record(path, scope)
                        }
                        // `{% render 'x' with item as t %}` — the same binding
                        // written positionally.
                        const withPath = node.with ? pathOfToken(node.with.value) : null
                        if (withPath) {
                            entry.aliases.push({ from: record(withPath, scope), to: node.with.alias ?? null })
                        }
                        partials.set(file, entry)
                    }
                    // Render/include accept a body in some dialects; walk it.
                    if (Array.isArray(node.templates)) walk(node.templates, scope)
                    break
                }
                case 'AssignTag': {
                    // `{% assign hero = data.meta.hero %}` renames a path. A
                    // contract that reports `hero.tags` names a variable local
                    // to one file; resolving the alias reports
                    // `data.meta.hero.tags`, which is what the AUTHOR writes.
                    const found = new Set()
                    collectValuePaths(node.value, found)
                    const raw = [...found][0] ?? null
                    const from = raw ? record(raw, scope) : null
                    if (node.key) {
                        assigns.push({ key: node.key, from })
                        // Bound for the REST of this template, which is what
                        // `assign` means — everything after it sees the alias.
                        if (from) scope[node.key] = from
                    }
                    break
                }
                case 'ForTag': {
                    const collection = getText(node.collection)
                    // `[]` marks an element rather than the collection itself.
                    // Without it `for c in r.cases` reports `r.cases.specs`,
                    // which is not a key anyone can write — the specs are on
                    // each case, not on the list.
                    const inner = { ...scope }
                    if (collection) {
                        const item = node.variable ?? '(for)'
                        iterations.push({ item, collection })
                        const path = extractPath(collection)
                        const resolved = path ? record(path, scope) : null
                        if (resolved && node.variable) inner[node.variable] = `${resolved}[]`
                    }
                    if (Array.isArray(node.templates))     walk(node.templates, inner)
                    if (Array.isArray(node.elseTemplates)) walk(node.elseTemplates, inner)
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
                            const found = new Set()
                            collectValuePaths(branch.value, found)
                            for (const f of found) record(f, scope)
                            if (Array.isArray(branch.templates)) walk(branch.templates, scope)
                        }
                    }
                    if (Array.isArray(node.elseTemplates)) walk(node.elseTemplates, scope)
                    break
                }
                default: {
                    // Generic walk — many tags expose nested .templates.
                    if (Array.isArray(node?.templates))     walk(node.templates, scope)
                    if (Array.isArray(node?.elseTemplates)) walk(node.elseTemplates, scope)
                    break
                }
            }
        }
    }

    walk(templates)

    return {
        variables:  Array.from(variables).sort(),
        partials:   Array.from(partials.values()).sort((a, b) => a.name.localeCompare(b.name)),
        iterations,
        assigns,
    }
}

// v9 factory — ADR-0010.
export function renderLiquid(options = {}) {
    return { name: options.name ?? 'liquid', options, load, render, parseReferences }
}
