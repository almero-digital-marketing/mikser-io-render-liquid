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

export function render({ entity, options, runtime }) {
    // Expose every function on runtime as a Liquid filter,
    // so render-helper plugins (markdown, href, ...) keep working without per-plugin glue.
    for (let key in runtime) {
        if (typeof runtime[key] === 'function') {
            engine.registerFilter(key, (input, ...args) => runtime[key](input, ...args))
        }
    }
    const name = path.relative(options.layoutsFolder, entity.layout.uri).replace(/\.liquid$/, '')
    return runtime.liquid(name, runtime)
}
