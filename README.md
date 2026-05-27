# mikser-io-render-liquid

[LiquidJS](https://www.npmjs.com/package/liquidjs) renderer for [Mikser](https://github.com/almero-digital-marketing/mikser-io). Renders entities whose layout uses the `.liquid` template engine.

Mikser doesn't pick your template engine for you — install the renderer that matches the syntax your team already knows. Liquid is the templating syntax behind Shopify, Jekyll, and Eleventy — designer-friendly, safe by default, deeply familiar to anyone who has touched a Jekyll site. Mix freely with other engines in the same project (`.liquid`, `.hbs`, `.eta` can all coexist).

## Install

```bash
npm install mikser-io-render-liquid
```

## Usage

```js
// mikser.config.js
export default {
  renderer: 'liquid',
  'render-liquid': {
    jsTruthy: true,
    strictFilters: false
  }
}
```

The `render-liquid` config object is passed through to the `Liquid` constructor — see [LiquidJS options](https://liquidjs.com/api/interfaces/LiquidOptions.html). Defaults applied by the plugin:

- `root: options.layoutsFolder`
- `extname: '.liquid'`
- `cache: !options.watch` (cached for one-shot builds, disabled in watch mode)

## Runtime → Filters

Every function exposed on the render runtime (by Mikser itself or by other `render-*` helper plugins) is auto-registered as a Liquid filter. So if you load `render-markdown`, this works in any template:

```liquid
{{ entity.meta.title }}
{{ entity.meta.body | markdown }}
{{ entity.meta.summary | removeMarkdown }}
{{ '/blog/welcome' | href: 'en' }}
```

Includes resolve from the layouts folder:

```liquid
{% include 'partials/header' %}
```

## License

MIT
