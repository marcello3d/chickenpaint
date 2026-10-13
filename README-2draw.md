# ChickenPaint for 2draw.net

This branch (`2draw`) is a fork of [ChickenPaint](https://github.com/thenickdude/chickenpaint) by Nicholas Sherlock
(GPL-3.0-or-later, see `LICENSE`), used as the ChickenPaint applet on [2draw.net](https://2draw.net/).

## Build

```sh
npm ci --ignore-scripts   # or pnpm install --frozen-lockfile
node scripts/build-2draw.mjs
```

This runs `make all min` and writes `dist-2draw/` with only the runtime files (minified JS + source map, CSS, fonts,
gfx, splash), plus `dist-2draw/VERSION` with the source commit. 2draw.net serves it from `/applet/chickenpaint/`
(`resourcesRoot`); replace `html/applet/chickenpaint/` there with the contents of `dist-2draw/`.

The toolbar icon PNGs in `resources/gfx/` are committed upstream, so Cairo/ImageMagick are only needed when the
icon SVGs change (or use `chickenpaint.Dockerfile`).

## What's different from upstream

- The save response check accepts leading whitespace before `CHIBIOK`.
- `scripts/build-2draw.mjs` and this file.
