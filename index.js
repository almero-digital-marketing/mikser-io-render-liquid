import { Liquid } from 'liquidjs'
import path from 'node:path'

let engine

export function load({ runtime, options, config }) {
    if (!engine) {
        engine = new Liquid({
            root: options.layoutsFolder,
            extname: '.liquid',
            cache: !options.watch,
            ...config,
        })
    }
    runtime.liquid = (name, data) => engine.renderFile(name, data)
}

export async function render({ entity, options, runtime }) {
    // Expose every function on runtime as a Liquid filter,
    // so render-helper plugins (markdown, href, ...) keep working without per-plugin glue.
    for (let key in runtime) {
        if (typeof runtime[key] === 'function') {
            engine.registerFilter(key, (input, ...args) => runtime[key](input, ...args))
        }
    }
    // Keep the `.liquid` in the name. LiquidJS's renderFile resolution
    // skips its own `extname` append for names that already have a
    // file-ish extension — and `path.extname('foo.html-pdf')` is
    // `.html-pdf`, which Liquid treats as "extension already present".
    // Stripping would make multi-segment layout names (e.g.
    // `franchises.html-pdf.liquid`) fail with ENOENT.
    const name = path.relative(options.layoutsFolder, entity.layout.uri)
    try {
        return await runtime.liquid(name, runtime)
    } catch (err) {
        // LiquidJS RenderError/ParseError carry a `token` with file/line/col.
        const token = err?.token
        err.layoutUri ??= token?.file || entity.layout.uri
        if (token?.line && err.line == null) err.line = token.line
        if (token?.col && err.column == null) err.column = token.col
        throw err
    }
}
