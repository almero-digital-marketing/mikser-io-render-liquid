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
        return { variables: [], partials: [], iterations: [], assigns: [], optional: [] }
    }
    const probe = new Liquid({})
    let templates
    try {
        templates = probe.parse(source)
    } catch (err) {
        return { variables: [], partials: [], iterations: [], assigns: [], optional: [], parseError: err.message }
    }

    const variables  = new Set()
    // Paths a template only reads behind a guard. `{% if meta.backdrop %}` and
    // everything inside that branch is OPTIONAL by construction — the layout
    // was written to work without it — so reporting such a key as missing from
    // a document says "probably wrong" about something that is fine.
    const optional   = new Set()
    // Liquid resolves these on any array or string rather than looking them up
    // on the data: `{% if tags.size > 0 %}` asks how many, not for a key called
    // `size`. Recording them puts engine machinery into a document's contract.
    const LIQUID_PSEUDO = new Set(['size', 'first', 'last'])
    // A filter that supplies a fallback is a guard, exactly as `{% if %}` is:
    // `{{ hero.title | default: meta.title }}` renders correctly for a document
    // that omits hero.title, so calling it required would report a working page
    // as wrong.
    const FALLBACK_FILTERS = new Set(['default'])
    const hasFallback = (value) => (value?.filters ?? []).some(f => FALLBACK_FILTERS.has(f.name))
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

    const record = (path, scope, guarded = false) => {
        let resolved = deref(path, scope)
        if (!resolved) return resolved
        // Trim a trailing pseudo-property: `hero.tags.size` is a question about
        // `hero.tags`, not a key of its own.
        const parts = resolved.split('.')
        if (parts.length > 1 && LIQUID_PSEUDO.has(parts[parts.length - 1])) {
            parts.pop()
            resolved = parts.join('.')
        }
        variables.add(resolved)
        if (guarded) optional.add(resolved)
        return resolved
    }

    function walk(nodes, scope = {}, guarded = false) {
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
                    if (path) record(path, scope, guarded || hasFallback(node.value))
                    // A filter's ARGUMENTS are read too. `{{ a | default: b }}`
                    // reads b, and unconditionally — it is the fallback, so it
                    // is what renders when a is absent. Leaving it unrecorded
                    // made it look like a key nothing consumes.
                    for (const filter of node.value?.filters ?? []) {
                        for (const arg of filter.args ?? []) {
                            const argPath = pathOfToken(arg)
                            if (argPath) record(argPath, scope, guarded)
                        }
                    }
                    break
                }
                case 'IncludeTag':
                case 'RenderTag':
                case 'LayoutTag': {
                    const file = getText(node.file)
                    if (file) {
                        // `include` shares the CALLER's scope; `render` does
                        // not. Liquid draws that line deliberately, and a
                        // contract that ignores it resolves nothing inside an
                        // included partial: the section registry reads
                        // `section`, which only means anything because the
                        // `for` loop that included it is still in view.
                        const inherits = kind !== 'RenderTag'
                        const entry = partials.get(file) ?? { name: file, args: {}, aliases: [], inherits, scope: {} }
                        // The scope an inherited partial was included IN, which
                        // only the parser can see. `{% include 'sections/_registry' %}`
                        // inside `{% for section in meta.sections %}` reads
                        // `section`, and that name means nothing without the
                        // loop it came from. Merged across call sites, because a
                        // partial included twice is one contract.
                        if (inherits) Object.assign(entry.scope, scope)
                        // The arguments a partial is called WITH. Dropping
                        // these was the hole: `{% render 'ui/btn', label:
                        // r.more %}` makes this template depend on `r.more`,
                        // and nothing recorded that — so a contract built from
                        // one file could not see a key consumed one file down.
                        // Whether a given argument carries a fallback filter,
                        // read from the RAW tag text: liquidjs parses a hash
                        // value down to a bare path token and drops the filter
                        // from the structured form, so there is nothing else to
                        // look at. Best-effort by necessity, and wrong only in
                        // the direction of calling something optional.
                        const rawArgs = String(node.token?.args ?? node.token?.content ?? '')
                        const argHasFallback = (name) => new RegExp(
                            `\\b${name}\\s*:\\s*[A-Za-z_$][\\w$.]*\\s*\\|\\s*(?:${[...FALLBACK_FILTERS].join('|')})\\b`,
                        ).test(rawArgs)
                        for (const [name, token] of Object.entries(node.hash?.hash ?? {})) {
                            const path = pathOfToken(token)
                            if (!path) continue
                            // Resolved HERE, in the scope the call sits in,
                            // before the partial ever runs — so a partial
                            // rendered inside a loop reports what the loop
                            // hands it, not the loop variable's local name.
                            entry.args[name] = record(path, scope, guarded || argHasFallback(name))
                        }
                        // `{% render 'x' with item as t %}` — the same binding
                        // written positionally.
                        const withPath = node.with ? pathOfToken(node.with.value) : null
                        if (withPath) {
                            entry.aliases.push({ from: record(withPath, scope, guarded), to: node.with.alias ?? null })
                        }
                        partials.set(file, entry)
                    }
                    // Render/include accept a body in some dialects; walk it.
                    if (Array.isArray(node.templates)) walk(node.templates, scope, guarded)
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
                    const from = raw ? record(raw, scope, guarded) : null
                    if (node.key) {
                        // `derived` travels with it: the closure walker applies
                        // these assigns as bindings too, and it has no other way
                        // to know the value went through a filter.
                        const derived = !!(node.value?.filters ?? []).length
                        assigns.push({ key: node.key, from, ...(derived ? { derived } : {}) })
                        // Bound for the REST of this template, which is what
                        // `assign` means — everything after it sees the alias.
                        //
                        // NOT bound when the value passed through a filter: the
                        // result is DERIVED, so a read on it says nothing about
                        // the source. `{% assign rows = c.specs | split: '|' %}`
                        // turns a string into a list, and binding it would let a
                        // loop over `rows` report `specs[]` — a key the document
                        // does not have and cannot be given, since specs is the
                        // string being split. The source itself is still
                        // recorded above, which is the true dependency.
                        if (from && !derived) scope[node.key] = from
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
                        const resolved = path ? record(path, scope, guarded) : null
                        if (resolved && node.variable) inner[node.variable] = `${resolved}[]`
                    }
                    if (Array.isArray(node.templates))     walk(node.templates, inner, guarded)
                    if (Array.isArray(node.elseTemplates)) walk(node.elseTemplates, inner, guarded)
                    break
                }
                case 'IfTag':
                case 'UnlessTag':
                case 'CaseTag': {
                    // Branches live on .branches (each has .templates) and .elseTemplates.
                    // Branch condition is a LiquidJS Value whose `.initial.postfix[]`
                    // expresses identifier paths; walk them rather than relying on
                    // string forms that aren't reliably exposed.
                    // A `case` dispatches on a value the document supplies and
                    // its branches are alternatives, not guards; `if`/`unless`
                    // are what make the content inside them optional.
                    const guards = kind !== 'CaseTag'
                    // A `case` reads its SUBJECT unconditionally — that is the
                    // value the document supplies to choose a branch. The
                    // branches hold the `when` literals, which depend on
                    // nothing, so reading only those recorded the dispatch as
                    // consuming no keys at all.
                    if (kind === 'CaseTag' && node.value) {
                        const subject = new Set()
                        collectValuePaths(node.value, subject)
                        for (const f of subject) record(f, scope)
                    }
                    if (Array.isArray(node.branches)) {
                        for (const branch of node.branches) {
                            const found = new Set()
                            collectValuePaths(branch.value, found)
                            // The condition itself is read unconditionally —
                            // the template always asks — but a document is not
                            // wrong for answering no.
                            for (const f of found) record(f, scope, guards)
                            if (Array.isArray(branch.templates)) walk(branch.templates, scope, guarded || guards)
                        }
                    }
                    if (Array.isArray(node.elseTemplates)) walk(node.elseTemplates, scope, guarded || guards)
                    break
                }
                default: {
                    // Generic walk — many tags expose nested .templates.
                    if (Array.isArray(node?.templates))     walk(node.templates, scope, guarded)
                    if (Array.isArray(node?.elseTemplates)) walk(node.elseTemplates, scope, guarded)
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
        // Read only behind a guard. Reported apart rather than dropped: a
        // consumer deciding whether a document is WRONG needs these excluded,
        // and a consumer asking what a layout can use needs them present.
        optional:   Array.from(optional).sort(),
    }
}

// v9 factory — ADR-0010.
export function renderLiquid(options = {}) {
    return { name: options.name ?? 'liquid', options, load, render, parseReferences }
}
