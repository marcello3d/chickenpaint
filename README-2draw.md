# ChickenPaint for 2draw.net

This branch (`2draw`) is a fork of [ChickenPaint](https://github.com/thenickdude/chickenpaint) by Nicholas Sherlock
(GPL-3.0-or-later, see `LICENSE`), used as the ChickenPaint applet on [2draw.net](https://2draw.net/).

## Build

```sh
npm ci --ignore-scripts   # or pnpm install --frozen-lockfile
node scripts/build-2draw.mjs
```

This runs `make all min` and writes `dist-2draw/` with only the runtime files (minified JS + source maps of the editor
and of the timelapse player `chickenpaint-player.min.js` and its worker `chickenpaint-player-worker.min.js`, which it
loads from the same directory, CSS, fonts, gfx, splash), plus `dist-2draw/VERSION` with the source commit. 2draw.net serves it from `/applet/chickenpaint/`
(`resourcesRoot`); replace `html/applet/chickenpaint/` there with the contents of `dist-2draw/`.

The toolbar icon PNGs in `resources/gfx/` are committed upstream, so Cairo/ImageMagick are only needed when the
icon SVGs change (or use `chickenpaint.Dockerfile`).

## What's different from upstream

- The save response check accepts leading whitespace before `CHIBIOK`.
- Drawing recording and timelapse playback (branch `recording`, meant for upstream; see `docs/recording-format.md`).
  2draw.net stores the uploaded `recording` field as `<entry>-v<version>.chiani`.
- Pen, touch and mouse drags go through every coalesced pointer sample (`getCoalescedEvents()`), not one per frame.
- For 2draw's copy of a drawing on the device, kept as its recording, append-only: `getRecordingPieces(from)` (the
  fixed head, the event chunks sealed since, the current tail; `CPRecorder.getPieces`) and `rebuildFromRecording`
  (open a drawing by replaying its recording, then carry the recording on; the player ends a stroke a session left
  under way, as the editor does when it reopens one; the replay runs in slices of about 12 ms behind the splash
  screen's progress bar, without keyframes or drift checks (`verify: false`), and the editor appears once it's done,
  so the page never freezes and nothing is drawn onto a half-replayed picture;
  `scripts/compare-replay.mjs <old> <new> [files]` checks that two engine checkouts rebuild recordings identically).
  As a fallback for a recording that stopped early:
  `getDeviceCopy()` (the layers as a .chi, taken without yielding, plus
  the recording so far and the rotation), the `unsavedWarning: false` option (the page warns itself) and `onSent`
  (awaited, two seconds at most, before going on to `postUrl`).
- `scripts/build-2draw.mjs` and this file.
