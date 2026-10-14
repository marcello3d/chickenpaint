# ChickenPaint drawing recordings

ChickenPaint can record how a drawing was made, for timelapse playback ("animation" in oekaki terms, like PaintBBS
`.pch` files). This document describes how to use recordings and specifies the file format to the byte.

## Using it

### Recording

```js
new ChickenPaint({
    uiElem: document.getElementById("chickenpaint-parent"),
    saveUrl: "save.php",
    recordDrawing: true,
    // When editing an existing drawing, its recording, so that the new one continues it:
    loadChibiFileUrl: "uploaded.chi",
    loadRecordingUrl: "uploaded-recording.bin",
    resourcesRoot: "chickenpaint/"
});
```

Recording is off unless `recordDrawing` is set. The recording is uploaded with the drawing as an extra, optional field of
the save POST:

| Field       | Contents                                                     |
|-------------|--------------------------------------------------------------|
| `recording` | The recording file (`application/octet-stream`), see below. |

A recording is best-effort: if it can't be produced (or it has grown past the size limit), the drawing is saved without
the field. When `loadRecordingUrl` is given but can't be loaded, nothing is recorded, so a server that keeps the old
recording when the field is missing won't lose its history. With `allowMultipleSends`, every send uploads the whole
recording again (the previous sessions plus the current one so far), never a duplicate of the current session.

`ChickenPaint.getRecording()` returns the recording (a `Uint8Array`) at any time.

Optionally, `recordingSourceUrl` is a permanent URL of the file being edited (the `.chi` or the image). A recording that
can't continue from its previous session (see [Sessions](#sessions)) then refers to that file instead of storing a copy
of every layer.

### Playback

`resources/js/chickenpaint-player.min.js` (built by `make min`) is a separate script, without the editor's UI, that
defines `window.ChickenPaintPlayer`:

```js
let player = new ChickenPaintPlayer({
    domRoot: document.getElementById("player"),  // required
    url: "uploaded-recording.bin",               // or recording: Uint8Array
    finalImageUrl: "uploaded.png",               // optional, see below
    fit: "contain",                              // fill domRoot, or "box" to use width x height
    width: 800, height: 600,                     // optional
    autoplay: false,
    speed: 1,                                    // playback rate multiplier
    controls: true,                              // a play button and a seek bar
    maxIdle: 500,                                // pauses longer than this (ms) are shortened to it
    onTimeUpdate: info => {},                    // {currentTime, duration, isPlaying, progress}
    onEnd: () => {},
    onError: error => {},
    onDrift: drift => {},                        // the replay doesn't match the recorded drawing (see Hashes)
    keyframeMemory: 32 * 1024 * 1024,            // optional: memory for seeking (default: by device)
    worker: true,                                // replay in a worker where the browser can (default)
    workerUrl: "chickenpaint-player-worker.min.js" // default: next to chickenpaint-player(.min).js
});

player.ready;        // Promise, resolves once loaded
player.duration;     // ms
player.currentTime;  // ms
player.isPlaying;
player.play(); player.pause(); player.seek(ms); player.setSpeed(rate); player.destroy();
```

The player replays the recording through ChickenPaint's own painting engine, so it doesn't need any pictures except
those the recording can't do without. If the replay doesn't reproduce the drawing exactly (`onDrift`), the player shows
`finalImageUrl` at the end of playback.

Where the browser has `OffscreenCanvas` (not Safari before 16.4), the replay runs in a worker,
`chickenpaint-player-worker.min.js` (built alongside the player, and served from the same directory), which draws
onto the player's canvas, so the page stays responsive however much there is to replay (seeking, high speeds). If the
worker can't start, the player replays on the page. Either way, seeking restores the nearest of the keyframes (copies
of the replay kept in memory) taken during playback; how much memory they may use depends on the device
(`ChickenPaintPlayer.defaultKeyframeMemory()`: less on phones).

## How recording works

A recording holds the *input* of the editing operations — stroke points with their timing, tool settings, layer
operations, selections, fills, undo and redo — and is replayed by calling the same `CPArtwork` methods the editor
called. Pixels are only stored for what can't be regenerated:

* the starting canvas, when it isn't blank and isn't the end of a previous recording (see [Sessions](#sessions));
* the result of a free transform (it's rendered by the browser's canvas, which differs between browsers);
* a pasted image that didn't come from a copy or cut made while recording (the host called `setClipboard()`);
* brush textures.

To make the replay exact (it's checked by the tests in `test/CPRecording.js`, which replay random editing and compare
every pixel of every layer and mask, and the whole undo history):

* While recording, stroke coordinates and pressures are rounded to what the file stores (1/16 pixel, pressure 0..255)
  before they reach the engine.
* The random number generator (brush scattering, noise fills) is seeded for each stroke and fill, and the seed stored.
* `Math.sin`, `Math.cos` and `Math.log` may differ between browsers, so the brush engine uses deterministic versions
  (`js/util/CPMath.js`, ports of fdlibm).
* The composite image (which "merge all layers", "copy merged" and "sample all layers" brushes read) no longer depends
  on which part of the canvas was last redrawn.

Calls to `CPArtwork` methods made by other methods, or by undo/redo, aren't recorded, only the outermost call. Starting
to record clears the undo history (a replay can't undo past its start).

## File format

All integers are unsigned unless noted. Encodings:

| Name     | Encoding                                                                                                   |
|----------|------------------------------------------------------------------------------------------------------------|
| `u8`     | 1 byte                                                                                                     |
| `u24`    | 3 bytes, big-endian                                                                                        |
| `u32`    | 4 bytes, big-endian                                                                                        |
| `varint` | unsigned LEB128: 7 bits per byte, least significant group first, high bit set on all but the last byte    |
| `svarint`| signed: zigzag (`v >= 0 ? 2v : -2v - 1`) then `varint`                                                     |
| `num`    | a number: an integer `v` with \|v\| < 2^40 is `varint(zigzag(v) * 2)`; anything else is `varint(1)` followed by an IEEE-754 double, big-endian (8 bytes) |
| `string` | `varint` byte length, then UTF-8                                                                           |
| `blob`   | `varint` byte length, then the bytes                                                                       |
| `rect`   | `num` left, `num` top, `num` right, `num` bottom (right/bottom exclusive)                                  |
| `PNG`    | a PNG file (8 bits per channel: RGBA for color, greyscale for masks and textures), stored as a `blob`      |

These are the same primitives as Lascaux's `.lsa` v3 animation format.

### Container

```
magic   89 43 50 52 0D 0A 1A 0A            ("\x89CPR\r\n\x1a\n")
chunk*  u32 payload length
        4 bytes chunk type (ASCII)
        payload
        u32 CRC-32 (as PNG's) of the type and the payload
```

Chunks, in order:

```
CPRH                file header
then for each editing session:
  SESS              session start
  SNAP              starting canvas (only for session start kind 4)
  EVTS*             events
  SEND              session end
CPRE                end of file (empty payload)
```

Readers skip chunks of unknown types. A recording is continued by copying every chunk before `CPRE`, then appending a
new session and a new `CPRE`.

#### `CPRH` file header

```
varint  format version (1)
varint  number of metadata entries
        (string key, string value) * entries    e.g. "Software" = "ChickenPaint"
```

#### `SESS` session start

```
varint  session index (0 for the first)
varint  start kind (see Sessions)
varint  canvas width
varint  canvas height
varint  wall-clock time the session started, ms since the Unix epoch (0 if unknown)
u32     start hash: the document hash (see Hashes) of the document the editor started from
string  source URL ("" if none): the file the editor opened. Required for start kind 3; other kinds may carry it
        too, for information (the player only fetches it for kind 3)
u8      source format: 0 = image (PNG), 1 = ChickenPaint layers file (.chi)
varint  number of layers in the root group
varint  number of layer table entries
        layer table entries (below)
varint  active layer (index into the layer table)
u8      1 if the active layer's mask is being edited, else 0
rect    selection (all zero for none)
varint  engine revision (0 if absent: it was added later, and readers ignore bytes after the fields they know)
```

The engine revision tells the player to reproduce engine behaviour that has since been fixed, so that a recording keeps
replaying the way it was made:

| Revision | Behaviour                                                                                                    |
|----------|--------------------------------------------------------------------------------------------------------------|
| 0        | Undoing or redoing a cut writes to the bitmap the layer (or its mask) had when the cut was made, even after undoing past "add layer mask" and redoing it gave the layer a new mask |
| 1        | Undoing or redoing a cut writes to the layer's current bitmap                                                 |

The layer table lists every layer and group in *table order*: depth-first, each group followed by its children, children
from bottom to top. Each entry:

```
u8      type: 0 = image layer, 1 = group
u8      flags: 1 visible, 2 lock alpha, 4 clipping (image layers), 8 has a mask, 16 mask linked, 32 mask visible,
               64 expanded (groups), 128 legacy multiply
varint  opacity 0..100
varint  blend mode (CPBlend.LM_*)
string  name
varint  number of children (groups only)
```

#### `SNAP` starting canvas

For each layer in table order: a `PNG` of the image (image layers only, RGBA), then a `PNG` of the mask if the layer has
one (greyscale). Each PNG is the size of the canvas.

#### `EVTS` events

```
varint  number of events in the chunk
u8      compression: 0 = stored, 1 = zlib (deflate)
varint  length of the streams before compression
varint  length of the stored streams
        stored streams
        blobs: the rest of the payload, never compressed (PNGs are compressed already)
```

The streams, once decompressed:

```
varint  number of streams (6)
varint  length of each stream
        the streams: op, dt, dx, dy, p, other
```

Each event is spread over the streams (so that similar numbers compress together, as in Lascaux's `.lsa` v3):

| Stream  | Contents                                                                                      |
|---------|-----------------------------------------------------------------------------------------------|
| `op`    | `varint` opcode of every event                                                                |
| `dt`    | `varint` milliseconds since the previous event of the session (recording clock)              |
| `dx`    | `svarint` change of stroke x, in 1/16 pixels, for stroke points                               |
| `dy`    | `svarint` change of stroke y                                                                  |
| `p`     | `svarint` change of stroke pressure (0..255)                                                  |
| `other` | every other field, in event order                                                             |
| blobs   | `PNG`s referenced by events, in event order                                                   |

Stroke x, y and pressure are relative to the previous stroke point in the same chunk, starting from x = 0, y = 0,
pressure = 255 at the start of every `EVTS` chunk, so each chunk decodes on its own. A writer may start a new chunk at
any event; ChickenPaint does every 16384 events or 1MB.

Unknown opcodes can't be skipped, so adding events requires a new format version.

### Events

Each row gives the opcode, the fields in the `other` stream (in order) unless noted, and the `CPArtwork` call the
player makes. "Layer" fields are layer ids (see [Layer ids](#layer-ids)).

| Op | Name             | Fields                                                                 | Replayed as                                    |
|----|------------------|------------------------------------------------------------------------|------------------------------------------------|
| 1  | stroke begin     | `dx`, `dy`, `p` streams; `varint` seed (other)                         | `setRandomSeed(seed)`; `fusionLayers()` if sampling all layers; `beginStroke(x / 16, y / 16, p / 255)` |
| 2  | stroke point     | `dx`, `dy`, `p` streams                                                | `continueStroke(x / 16, y / 16, p / 255)`      |
| 3  | stroke end       |                                                                        | `endStroke()`                                  |
| 10 | tool setting     | `varint` field, value (see below)                                      | sets the brush, color or sample-all-layers     |
| 11 | brush texture    | `u8` 1 if present; texture `PNG` (blobs) if present                    | `setBrushTexture()`                            |
| 20 | select layer     | `varint` layer, `u8` edit mask                                         | `setActiveLayer(layer, mask)`                  |
| 21 | expand group     | `varint` layer, `u8` expand                                            | `expandLayerGroup(layer, expand)`              |
| 22 | add layer        | `u8` 1 for a group                                                     | `addLayer("group" or "layer")`                 |
| 23 | remove layer     |                                                                        | `removeLayer()`                                |
| 24 | duplicate layer  |                                                                        | `duplicateLayer()`                             |
| 25 | merge down       |                                                                        | `mergeDown()`                                  |
| 26 | merge group      |                                                                        | `mergeGroup()`                                 |
| 27 | merge all        |                                                                        | `mergeAllLayers()`                             |
| 28 | move layer       | `varint` layer, `varint` group, `varint` index                         | `relocateLayer(layer, group, index)`           |
| 29 | add mask         |                                                                        | `addLayerMask()`                               |
| 30 | remove mask      |                                                                        | `removeLayerMask()`                            |
| 31 | apply mask       |                                                                        | `applyLayerMask()`                             |
| 32 | layer visibility | `varint` layer, `u8` visible                                           | `setLayerVisibility(layer, visible)`           |
| 33 | layer opacity    | `num` opacity                                                          | `setLayerAlpha(opacity)`                       |
| 34 | layer blend mode | `num` mode                                                             | `setLayerBlendMode(mode)`                      |
| 35 | rename layer     | `varint` layer, `string` name                                          | `setLayerName(layer, name)`                    |
| 36 | mask linked      | `u8` linked                                                            | `setLayerMaskLinked(linked)`                   |
| 37 | mask visibility  | `varint` layer, `u8` visible                                           | `setLayerMaskVisible(layer, visible)`          |
| 38 | clip             |                                                                        | `createClippingMask()`                         |
| 39 | unclip           |                                                                        | `releaseClippingMask()`                        |
| 40 | lock alpha       | `u8` locked                                                            | `setLayerLockAlpha(locked)`                    |
| 50 | select rectangle | `rect`                                                                 | `rectangleSelection(rect)`                     |
| 51 | set selection    | `rect` (empty to deselect)                                             | `setSelection(rect)`                           |
| 52 | move             | `svarint` dx, `svarint` dy, `u8` copy                                  | `move(dx, dy, copy)`                           |
| 53 | cut              |                                                                        | `cutSelection()`                               |
| 54 | copy             |                                                                        | `copySelection()`                              |
| 55 | copy merged      |                                                                        | `copySelectionMerged()`                        |
| 56 | paste            | `u8` 1 if the image is included; if so `svarint` x, `svarint` y, `u8` 1 for greyscale, and the `PNG` (blobs) | `setClipboard(new CPClip(image, x, y))` if included; `pasteClipboard()` |
| 57 | free transform   | `rect` selection after, `varint` layer, `u8` mask edited, `varint` n, then n × (`varint` layer, `u8` flags: 1 image, 2 mask, `varint` left, `varint` top, `varint` width, `varint` height); the image then mask `PNG` of each (blobs) | `applyRecordedChange()`: replaces those pixels as one undoable step |
| 60 | fill             | `u32` ARGB color                                                       | `fill(color)`                                  |
| 61 | clear            |                                                                        | `clear()`                                      |
| 62 | flood fill       | `svarint` x, `svarint` y                                               | `floodFill(x, y)`                              |
| 63 | gradient fill    | `num` from x, `num` from y, `num` to x, `num` to y, `varint` n, n × `u32` ARGB | `gradientFill(...)`                    |
| 64 | flip horizontal  |                                                                        | `hFlip()`                                      |
| 65 | flip vertical    |                                                                        | `vFlip()`                                      |
| 66 | monochrome noise | `varint` seed                                                          | `setRandomSeed(seed)`; `monochromaticNoise()`  |
| 67 | color noise      | `varint` seed                                                          | `setRandomSeed(seed)`; `colorNoise()`          |
| 68 | invert           |                                                                        | `invert()`                                     |
| 69 | box blur         | `varint` radius x, `varint` radius y, `varint` iterations             | `boxBlur(...)`                                 |
| 70 | undo             |                                                                        | `undo()`                                       |
| 71 | redo             |                                                                        | `redo()`                                       |
| 72 | clear history    |                                                                        | `clearHistory()`                               |
| 80 | checkpoint       | `u32` composite hash                                                   | compares the composite hash (see Hashes)       |

Tool settings (opcode 10): field 0 is the foreground color as `u24` RGB; every other field's value is a `num` (booleans
are 0 or 1). Fields 2 and up set the `CPBrushInfo` property of the same name:

| Field | Setting             | Field | Setting              | Field | Setting      |
|-------|---------------------|-------|----------------------|-------|--------------|
| 0     | color               | 7     | `brushMode`          | 14    | `resat`      |
| 1     | sample all layers   | 8     | `paintMode`          | 15    | `bleed`      |
| 2     | `size`              | 9     | `isAA`               | 16    | `texture`    |
| 3     | `alpha`             | 10    | `pressureSize`       | 17    | `scattering` |
| 4     | `spacing`           | 11    | `pressureAlpha`      | 18    | `squeeze`    |
| 5     | `minSpacing`        | 12    | `pressureScattering` | 19    | `angle`      |
| 6     | `tip`               | 13    | `alphaScale`         |       |              |

The recorder writes a setting just before the first stroke or flood fill that uses a changed value, and every setting
before the first stroke of a session; the brush texture likewise.

### Layer ids

Layers are referred to by id. At the start of a session, the root group is 0 and the layers get ids 1, 2, ... in table
order. After every event, layers that don't have an id yet (made by the event) get the next ids, in table order. Ids
stay with their layer for the rest of the session (also when it's removed and later restored by undo).

### Sessions

Each time the drawing is edited and saved, a session is added. Its start kind says what the session started from:

| Kind | Name          | The starting document                                                                                  |
|------|---------------|--------------------------------------------------------------------------------------------------------|
| 0    | blank         | `new CPArtwork(width, height)` + `addBackgroundLayer()` (a new drawing)                                |
| 1    | continue      | the document as the previous session left it (the editor opened what that session saved)               |
| 2    | continue flat | a single layer holding the previous session's saved flat image: its composite, rotated by its rotation (a simple drawing is saved without a layers file, see `CPArtwork.isSimpleDrawing()`) |
| 3    | reference     | the file at the source URL                                                                            |
| 4    | snapshot      | the `SNAP` chunk                                                                                       |

The editor uses kind 1 if the document it opened has the start hash of the previous session's end (`SEND` layers
hash), kind 2 if the previous session ended as a simple drawing and the opened single layer has that session's saved
image hash, kind 0 for a new blank drawing, and otherwise kind 3 if it has a source URL, else kind 4. A truncated
session is never continued.

The player then sets every layer's properties from the layer table, makes the given layer active, sets the selection,
and starts with an empty undo history, clipboard and brush texture. If the starting document's hash doesn't match the
start hash, it reports drift and carries on (after building the starting document from the snapshot or the source file,
for kinds 3 and 4). A source file that can't be fetched is also reported as drift, and the session then starts from a
blank canvas. A host that passes `recordingSourceUrl` must keep that file for as long as the recording.

#### `SEND` session end

Written when the recording is saved, so it describes the document as it was saved.

```
varint  number of events in the session
varint  duration of the session, ms
u8      flags: 1 truncated (events were dropped because the session got too long), 2 simple drawing
u8      rotation the flat image was saved with: 0..3 quarter turns clockwise
u32     composite hash
u32     saved image hash: the composite hash of the composite rotated by the rotation (the uploaded image)
u32     document hash
varint  canvas width
varint  canvas height
varint  number of layers and groups
```

### Hashes

All hashes are 32-bit FNV-1a over 32-bit words (`h = 0x811C9DC5`, then for each word `h = (h ^ word) * 0x01000193`
modulo 2^32), the same function as JSPaint's `.p95` recordings.

* **Composite hash**: the width, the height, then every RGBA pixel of the composite (`CPArtwork.fusionLayers()`) as a
  little-endian word (`r | g << 8 | b << 16 | a << 24`), row by row.
* **Document hash**: the width, the height, the number of layers in the root group, then for every layer in table
  order: its type (0 image, 1 group), its number of children (0 for image layers), 1 if it has a mask else 0, its RGBA
  pixels as above (image layers), and its mask pixels packed four to a little-endian word (zero-padded at the end).
  Layer properties aren't included: the layer table carries them.

The recorder writes a checkpoint (opcode 80) at the end of a stroke once 300 events have passed since the last one.
The player compares its composite hash at each checkpoint, and its document hash at the start and end of each session,
and reports drift on a mismatch.

### Limits

A recording that would exceed 16MB isn't saved. A session stops recording after 4,000,000 events or once the file
reaches that size, and is marked truncated; the player plays what there is, and shows the final image at the end.
