/*
    ChickenPaint

    ChickenPaint is a translation of ChibiPaint from Java to JavaScript
    by Nicholas Sherlock / Chicken Smoothie.

    ChibiPaint is Copyright (c) 2006-2008 Marc Schefer

    ChickenPaint is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    ChickenPaint is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with ChickenPaint. If not, see <http://www.gnu.org/licenses/>.
*/

/*
 * The drawing recording file format: see docs/recording-format.md for the byte-level specification. This module holds
 * the container (chunks), the event codec, the layer table and snapshots, and the hashes, shared by CPRecorder (which
 * writes recordings) and CPRecordingPlayer (which replays them).
 */

import pako from "pako";

import CPImageLayer from "./CPImageLayer.js";
import CPLayerGroup from "./CPLayerGroup.js";
import {ByteReader, ByteWriter, concatBytes, crc32} from "../util/CPByteStream.js";
import {decodePNG} from "../util/CPPNG.js";

export const
    MAGIC = Uint8Array.of(0x89, 0x43, 0x50, 0x52, 0x0d, 0x0a, 0x1a, 0x0a), // "\x89CPR\r\n\x1a\n"
    FORMAT_VERSION = 1,

    CHUNK_HEADER = "CPRH",
    CHUNK_SESSION = "SESS",
    CHUNK_SNAPSHOT = "SNAP",
    CHUNK_EVENTS = "EVTS",
    CHUNK_SESSION_END = "SEND",
    CHUNK_END = "CPRE",

    /**
     * Stroke coordinates are stored in fixed point with this many steps per pixel (the recorder rounds the
     * coordinates it passes to the engine to this precision, so the replay is exact).
     */
    COORD_SCALE = 16,

    /**
     * How a session's starting document is obtained.
     */
    START_BLANK = 0,          // new CPArtwork(width, height) + addBackgroundLayer()
    START_CONTINUE = 1,       // the document as the previous session left it
    START_CONTINUE_FLAT = 2,  // the previous session's saved flat image (its composite, rotated) as a single layer
    START_REFERENCE = 3,      // the file at the session's source URL
    START_SNAPSHOT = 4,       // the SNAP chunk that follows

    SOURCE_PNG = 0,
    SOURCE_CHI = 1,

    /**
     * Revision of the engine behaviour a session was recorded with, stored at the end of its SESS chunk (absent = 0),
     * so that a fix that changes what an editing operation does doesn't make older recordings replay differently:
     *   0 - undo/redo of a cut wrote to the bitmap the layer (or its mask) had when the cut was made, even if the
     *       layer had been given a new one since (undoing "add layer mask" and redoing it makes a new mask)
     *   1 - undo/redo of a cut writes to the layer's current bitmap
     */
    ENGINE_REVISION = 1,

    SESSION_END_TRUNCATED = 1,
    SESSION_END_SIMPLE = 2,

    LAYER_TYPE_IMAGE = 0,
    LAYER_TYPE_GROUP = 1,

    LAYER_FLAG_VISIBLE = 1,
    LAYER_FLAG_LOCK_ALPHA = 2,
    LAYER_FLAG_CLIP = 4,
    LAYER_FLAG_MASK = 8,
    LAYER_FLAG_MASK_LINKED = 16,
    LAYER_FLAG_MASK_VISIBLE = 32,
    LAYER_FLAG_EXPANDED = 64,
    LAYER_FLAG_LEGACY_MULTIPLY = 128;

/**
 * Event opcodes.
 */
export const OP = {
    STROKE_BEGIN: 1,
    STROKE_POINT: 2,
    STROKE_END: 3,

    TOOL: 10,
    TEXTURE: 11,

    SELECT_LAYER: 20,
    EXPAND_GROUP: 21,
    ADD_LAYER: 22,
    REMOVE_LAYER: 23,
    DUPLICATE_LAYER: 24,
    MERGE_DOWN: 25,
    MERGE_GROUP: 26,
    MERGE_ALL: 27,
    RELOCATE_LAYER: 28,
    ADD_MASK: 29,
    REMOVE_MASK: 30,
    APPLY_MASK: 31,
    LAYER_VISIBLE: 32,
    LAYER_ALPHA: 33,
    LAYER_BLEND: 34,
    LAYER_NAME: 35,
    MASK_LINKED: 36,
    MASK_VISIBLE: 37,
    CLIP_CREATE: 38,
    CLIP_RELEASE: 39,
    LOCK_ALPHA: 40,

    RECT_SELECTION: 50,
    SET_SELECTION: 51,
    MOVE: 52,
    CUT: 53,
    COPY: 54,
    COPY_MERGED: 55,
    PASTE: 56,
    TRANSFORM: 57,

    FILL: 60,
    CLEAR: 61,
    FLOOD_FILL: 62,
    GRADIENT_FILL: 63,
    FLIP_H: 64,
    FLIP_V: 65,
    NOISE_MONO: 66,
    NOISE_COLOR: 67,
    INVERT: 68,
    BOX_BLUR: 69,

    UNDO: 70,
    REDO: 71,
    CLEAR_HISTORY: 72,

    CHECKPOINT: 80
};

/**
 * Tool state fields set by OP.TOOL. Field 0 is the RGB foreground color, 1 is "sample all layers", the rest are
 * CPBrushInfo properties.
 */
export const
    TOOL_COLOR = 0,
    TOOL_SAMPLE_ALL_LAYERS = 1,
    BRUSH_FIELDS = [
        null, null,
        "size", "alpha", "spacing", "minSpacing", "tip", "brushMode", "paintMode", "isAA", "pressureSize",
        "pressureAlpha", "pressureScattering", "alphaScale", "resat", "bleed", "texture", "scattering", "squeeze", "angle"
    ];

/**
 * Event opcodes with no payload.
 */
const
    NO_PAYLOAD = new Set([
        OP.STROKE_END, OP.REMOVE_LAYER, OP.DUPLICATE_LAYER, OP.MERGE_DOWN, OP.MERGE_GROUP, OP.MERGE_ALL, OP.ADD_MASK,
        OP.REMOVE_MASK, OP.APPLY_MASK, OP.CLIP_CREATE, OP.CLIP_RELEASE, OP.CUT, OP.COPY, OP.COPY_MERGED, OP.CLEAR,
        OP.FLIP_H, OP.FLIP_V, OP.INVERT, OP.UNDO, OP.REDO, OP.CLEAR_HISTORY
    ]),

    STREAM_NAMES = ["op", "dt", "dx", "dy", "p", "other"];

// == Hashes ===========================================================================================================

const
    FNV_OFFSET = 0x811c9dc5,
    FNV_PRIME = 0x01000193,
    LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * FNV-1a over 32-bit words (one multiply per word rather than per byte), continuing from hash h.
 */
function fnvWord(h, v) {
    return Math.imul(h ^ v, FNV_PRIME);
}

/**
 * Hash RGBA pixels as little-endian 32-bit words, continuing from hash h.
 */
function fnvRGBA(h, data) {
    if (LITTLE_ENDIAN && data.byteOffset % 4 === 0 && data.length % 4 === 0) {
        let
            words = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);

        for (let i = 0; i < words.length; i++) {
            h = Math.imul(h ^ words[i], FNV_PRIME);
        }
    } else {
        for (let i = 0; i + 3 < data.length; i += 4) {
            h = Math.imul(h ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)), FNV_PRIME);
        }
    }
    return h;
}

/**
 * Hash 8-bit greyscale pixels packed 4 to a little-endian 32-bit word (zero-padded), continuing from hash h.
 */
function fnvGrey(h, data) {
    let
        i = 0;

    for (; i + 3 < data.length; i += 4) {
        h = Math.imul(h ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)), FNV_PRIME);
    }
    if (i < data.length) {
        let
            word = 0;

        for (let shift = 0; i < data.length; i++, shift += 8) {
            word |= data[i] << shift;
        }
        h = Math.imul(h ^ word, FNV_PRIME);
    }
    return h;
}

/**
 * The image hash: FNV-1a 32 over the width, the height, then the RGBA pixels as little-endian 32-bit words. This is
 * the same function JSPaint's .p95 recordings use.
 *
 * @param {int} width
 * @param {int} height
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @returns {int} unsigned 32-bit hash
 */
export function hashImage(width, height, rgba) {
    return fnvRGBA(fnvWord(fnvWord(FNV_OFFSET, width), height), rgba) >>> 0;
}

/**
 * Rotate RGBA pixels clockwise by rotation * 90 degrees (as CPColorBmp.getAsPNG(rotation) does).
 *
 * @returns {{width: int, height: int, data: Uint8Array}}
 */
export function rotateRGBA(width, height, data, rotation) {
    rotation = ((rotation % 4) + 4) % 4;

    if (rotation === 0) {
        return {width, height, data};
    }

    let
        outWidth = rotation === 2 ? width : height,
        outHeight = rotation === 2 ? height : width,
        src = new Uint32Array(data.buffer, data.byteOffset, width * height),
        out = new Uint8Array(width * height * 4),
        dst = new Uint32Array(out.buffer),
        i = 0;

    for (let y = 0; y < outHeight; y++) {
        for (let x = 0; x < outWidth; x++, i++) {
            let
                sx, sy;

            switch (rotation) {
                case 1:
                    sx = y;
                    sy = height - 1 - x;
                    break;
                case 2:
                    sx = width - 1 - x;
                    sy = height - 1 - y;
                    break;
                default:
                    sx = width - 1 - y;
                    sy = x;
            }
            dst[i] = src[sy * width + sx];
        }
    }

    return {width: outWidth, height: outHeight, data: out};
}

/**
 * Visit the layers of the document in table order: pre-order, each group followed by its children, children bottom
 * to top.
 *
 * @param {CPLayerGroup} root
 * @param {function(CPLayer)} callback
 */
export function forEachLayer(root, callback) {
    for (let layer of root.layers) {
        callback(layer);
        if (layer instanceof CPLayerGroup) {
            forEachLayer(layer, callback);
        }
    }
}

/**
 * @param {CPArtwork} artwork
 * @returns {CPLayer[]} The layers in table order
 */
export function layerList(artwork) {
    let
        result = [];

    forEachLayer(artwork.getLayersRoot(), layer => result.push(layer));

    return result;
}

/**
 * The document hash: FNV-1a 32 (as hashImage()) over the canvas size, the root's child count, then for every layer in
 * table order its type, child count and mask presence, its RGBA pixels (image layers) and its mask (packed 4 pixels
 * to a word). Layer properties (names, opacity, ...) aren't included: the layer table carries them.
 *
 * @param {CPArtwork} artwork
 * @returns {int} unsigned 32-bit hash
 */
export function hashLayers(artwork) {
    let
        root = artwork.getLayersRoot(),
        h = fnvWord(fnvWord(fnvWord(FNV_OFFSET, artwork.width), artwork.height), root.layers.length);

    forEachLayer(root, layer => {
        let
            isGroup = layer instanceof CPLayerGroup;

        h = fnvWord(h, isGroup ? LAYER_TYPE_GROUP : LAYER_TYPE_IMAGE);
        h = fnvWord(h, isGroup ? layer.layers.length : 0);
        h = fnvWord(h, layer.mask ? 1 : 0);

        if (!isGroup) {
            h = fnvRGBA(h, layer.image.data);
        }
        if (layer.mask) {
            h = fnvGrey(h, layer.mask.data);
        }
    });

    return h >>> 0;
}

/**
 * hashImage() of the artwork's composite image.
 *
 * @param {CPArtwork} artwork
 * @returns {int}
 */
export function hashComposite(artwork) {
    let
        fusion = artwork.fusionLayers();

    return hashImage(fusion.width, fusion.height, fusion.data);
}

/**
 * hashImage() of the flat image CPResourceSaver uploads: the composite rotated clockwise by rotation * 90 degrees.
 *
 * @param {CPArtwork} artwork
 * @param {int} rotation
 * @returns {int}
 */
export function hashSavedImage(artwork, rotation) {
    let
        fusion = artwork.fusionLayers(),
        rotated = rotateRGBA(fusion.width, fusion.height, fusion.data, rotation);

    return hashImage(rotated.width, rotated.height, rotated.data);
}

// == Container ========================================================================================================

function asciiBytes(s) {
    return Uint8Array.from(s, c => c.charCodeAt(0));
}

/**
 * Append a chunk: [u32 payload length][4-byte type][payload][u32 CRC-32 of type + payload]
 *
 * @param {ByteWriter} out
 * @param {string} type
 * @param {Uint8Array} payload
 */
export function writeChunk(out, type, payload) {
    let
        typeBytes = asciiBytes(type);

    out.u32(payload.length);
    out.bytes(typeBytes);
    out.bytes(payload);
    out.u32(crc32(payload, crc32(typeBytes)));
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isRecording(bytes) {
    return bytes && bytes.length >= MAGIC.length && MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * @typedef {Object} RecordingSessionEnd
 * @property {int} eventCount
 * @property {int} durationMs
 * @property {boolean} truncated
 * @property {boolean} simple - The drawing was saved as a flat image (no layers file)
 * @property {int} rotation
 * @property {int} compositeHash
 * @property {int} imageHash
 * @property {int} layersHash
 * @property {int} width
 * @property {int} height
 * @property {int} layerCount
 */

/**
 * @typedef {Object} RecordingSession
 * @property {Object} start - Decoded SESS chunk (see decodeSessionStart())
 * @property {?Uint8Array} snapshot - SNAP payload
 * @property {Uint8Array[]} eventChunks - EVTS payloads
 * @property {?RecordingSessionEnd} end
 */

/**
 * Parse the chunk structure of a recording (events stay encoded, see decodeEvents()).
 *
 * @param {Uint8Array} bytes
 * @returns {{version: int, meta: Object, sessions: RecordingSession[], body: Uint8Array}} body is every chunk after the
 *          magic and before the end chunk, verbatim, so that a continued recording can append to it.
 */
export function parseRecording(bytes) {
    if (!isRecording(bytes)) {
        throw new Error("Not a ChickenPaint recording");
    }

    let
        r = new ByteReader(bytes),
        file = {version: 0, meta: {}, sessions: [], body: null},
        sawHeader = false,
        bodyEnd,
        current = null;

    r.pos = MAGIC.length;
    bodyEnd = r.pos;

    while (r.remaining > 0) {
        let
            length = r.u32(),
            typeBytes = r.bytes(4),
            type = String.fromCharCode(...typeBytes),
            payload = r.bytes(length),
            crc = r.u32();

        if (crc !== crc32(payload, crc32(typeBytes))) {
            throw new Error("Corrupt recording (" + type + " chunk CRC)");
        }

        if (type === CHUNK_END) {
            break;
        }

        bodyEnd = r.pos;

        let
            p = new ByteReader(payload);

        switch (type) {
            case CHUNK_HEADER:
                file.version = p.varint();
                if (file.version > FORMAT_VERSION) {
                    throw new Error("Recording format " + file.version + " is newer than this player");
                }
                for (let n = p.varint(); n > 0; n--) {
                    let
                        key = p.string();

                    file.meta[key] = p.string();
                }
                sawHeader = true;
                break;
            case CHUNK_SESSION:
                current = {start: decodeSessionStart(p), snapshot: null, eventChunks: [], end: null};
                file.sessions.push(current);
                break;
            case CHUNK_SNAPSHOT:
                if (!current) {
                    throw new Error("Snapshot outside a session");
                }
                current.snapshot = payload;
                break;
            case CHUNK_EVENTS:
                if (!current) {
                    throw new Error("Events outside a session");
                }
                current.eventChunks.push(payload);
                break;
            case CHUNK_SESSION_END:
                if (!current) {
                    throw new Error("Session end outside a session");
                }
                current.end = decodeSessionEnd(p);
                current = null;
                break;
            default:
                // Unknown chunks are skipped
        }
    }

    if (!sawHeader) {
        throw new Error("Recording header missing");
    }

    file.body = bytes.slice(MAGIC.length, bodyEnd);

    return file;
}

/**
 * @param {Object} meta - String keys and values
 * @returns {Uint8Array}
 */
export function encodeHeader(meta) {
    let
        w = new ByteWriter(64),
        keys = Object.keys(meta);

    w.varint(FORMAT_VERSION);
    w.varint(keys.length);
    for (let key of keys) {
        w.string(key);
        w.string(String(meta[key]));
    }
    return w.toBytes();
}

/**
 * @param {RecordingSessionEnd} end
 * @returns {Uint8Array}
 */
export function encodeSessionEnd(end) {
    let
        w = new ByteWriter(64);

    w.varint(end.eventCount);
    w.varint(end.durationMs);
    w.u8((end.truncated ? SESSION_END_TRUNCATED : 0) | (end.simple ? SESSION_END_SIMPLE : 0));
    w.u8(end.rotation);
    w.u32(end.compositeHash);
    w.u32(end.imageHash);
    w.u32(end.layersHash);
    w.varint(end.width);
    w.varint(end.height);
    w.varint(end.layerCount);
    return w.toBytes();
}

function decodeSessionEnd(p) {
    let
        eventCount = p.varint(),
        durationMs = p.varint(),
        flags = p.u8();

    return {
        eventCount,
        durationMs,
        truncated: (flags & SESSION_END_TRUNCATED) !== 0,
        simple: (flags & SESSION_END_SIMPLE) !== 0,
        rotation: p.u8(),
        compositeHash: p.u32(),
        imageHash: p.u32(),
        layersHash: p.u32(),
        width: p.varint(),
        height: p.varint(),
        layerCount: p.varint()
    };
}

// == Layer table and session start ====================================================================================

/**
 * @typedef {Object} LayerTableEntry
 * @property {int} type - LAYER_TYPE_*
 * @property {int} flags - LAYER_FLAG_*
 * @property {int} alpha
 * @property {int} blendMode
 * @property {string} name
 * @property {int} children - Number of child entries (groups), which follow this one
 */

/**
 * @param {CPArtwork} artwork
 * @returns {LayerTableEntry[]} in table order
 */
export function getLayerTable(artwork) {
    return layerList(artwork).map(layer => {
        let
            isGroup = layer instanceof CPLayerGroup,
            flags = (layer.visible ? LAYER_FLAG_VISIBLE : 0)
                | (layer.lockAlpha ? LAYER_FLAG_LOCK_ALPHA : 0)
                | (!isGroup && layer.clip ? LAYER_FLAG_CLIP : 0)
                | (layer.mask ? LAYER_FLAG_MASK : 0)
                | (layer.maskLinked ? LAYER_FLAG_MASK_LINKED : 0)
                | (layer.maskVisible ? LAYER_FLAG_MASK_VISIBLE : 0)
                | (isGroup && layer.expanded ? LAYER_FLAG_EXPANDED : 0)
                | (layer.useLegacyMultiply ? LAYER_FLAG_LEGACY_MULTIPLY : 0);

        return {
            type: isGroup ? LAYER_TYPE_GROUP : LAYER_TYPE_IMAGE,
            flags: flags,
            alpha: layer.alpha,
            blendMode: layer.blendMode,
            name: layer.name,
            children: isGroup ? layer.layers.length : 0
        };
    });
}

/**
 * Set a layer's properties from its table entry.
 *
 * @param {CPLayer} layer
 * @param {LayerTableEntry} entry
 */
export function applyLayerTableEntry(layer, entry) {
    layer.name = entry.name;
    layer.alpha = entry.alpha;
    layer.blendMode = entry.blendMode;
    layer.visible = (entry.flags & LAYER_FLAG_VISIBLE) !== 0;
    layer.lockAlpha = (entry.flags & LAYER_FLAG_LOCK_ALPHA) !== 0;
    layer.maskLinked = (entry.flags & LAYER_FLAG_MASK_LINKED) !== 0;
    layer.maskVisible = (entry.flags & LAYER_FLAG_MASK_VISIBLE) !== 0;
    layer.useLegacyMultiply = (entry.flags & LAYER_FLAG_LEGACY_MULTIPLY) !== 0;

    if (layer instanceof CPLayerGroup) {
        layer.expanded = (entry.flags & LAYER_FLAG_EXPANDED) !== 0;
    } else {
        layer.clip = (entry.flags & LAYER_FLAG_CLIP) !== 0;
    }
}

/**
 * True if the document's layer tree has the shape the table describes (layer types, nesting and masks).
 *
 * @param {CPArtwork} artwork
 * @param {Object} start - Decoded session start
 * @returns {boolean}
 */
export function layerTableMatches(artwork, start) {
    let
        layers = layerList(artwork),
        table = start.layers;

    if (layers.length !== table.length || artwork.getLayersRoot().layers.length !== start.rootChildren) {
        return false;
    }

    return layers.every((layer, i) => {
        let
            isGroup = layer instanceof CPLayerGroup;

        return table[i].type === (isGroup ? LAYER_TYPE_GROUP : LAYER_TYPE_IMAGE)
            && (isGroup ? layer.layers.length : 0) === table[i].children
            && !!layer.mask === ((table[i].flags & LAYER_FLAG_MASK) !== 0);
    });
}

function writeRect(w, rect) {
    w.num(rect.left);
    w.num(rect.top);
    w.num(rect.right);
    w.num(rect.bottom);
}

function readRect(r) {
    return {left: r.num(), top: r.num(), right: r.num(), bottom: r.num()};
}

/**
 * @typedef {Object} SessionStart
 * @property {int} index
 * @property {int} kind - START_*
 * @property {int} width
 * @property {int} height
 * @property {int} startedAt - Wall clock time the session started (ms since the Unix epoch), or 0
 * @property {int} startHash - hashLayers() of the document the session started from
 * @property {string} sourceUrl - URL of the file the editor opened (required for START_REFERENCE), or ""
 * @property {int} sourceFormat - SOURCE_*
 * @property {int} rootChildren
 * @property {LayerTableEntry[]} layers
 * @property {int} activeLayer - Index into layers
 * @property {boolean} editingMask
 * @property {{left, top, right, bottom}} selection
 * @property {int} engine - ENGINE_REVISION the session was recorded with (0 if absent)
 */

/**
 * @param {SessionStart} start
 * @returns {Uint8Array}
 */
export function encodeSessionStart(start) {
    let
        w = new ByteWriter(256);

    w.varint(start.index);
    w.varint(start.kind);
    w.varint(start.width);
    w.varint(start.height);
    w.varint(start.startedAt);
    w.u32(start.startHash);
    w.string(start.sourceUrl);
    w.u8(start.sourceFormat);

    w.varint(start.rootChildren);
    w.varint(start.layers.length);
    for (let entry of start.layers) {
        w.u8(entry.type);
        w.u8(entry.flags);
        w.varint(entry.alpha);
        w.varint(entry.blendMode);
        w.string(entry.name);
        if (entry.type === LAYER_TYPE_GROUP) {
            w.varint(entry.children);
        }
    }

    w.varint(start.activeLayer);
    w.u8(start.editingMask ? 1 : 0);
    writeRect(w, start.selection);
    w.varint(start.engine === undefined ? ENGINE_REVISION : start.engine);

    return w.toBytes();
}

/**
 * @param {ByteReader} r
 * @returns {SessionStart}
 */
export function decodeSessionStart(r) {
    let
        start = {
            index: r.varint(),
            kind: r.varint(),
            width: r.varint(),
            height: r.varint(),
            startedAt: r.varint(),
            startHash: r.u32(),
            sourceUrl: r.string(),
            sourceFormat: r.u8(),
            rootChildren: r.varint(),
            layers: []
        },
        count = r.varint();

    if (start.width <= 0 || start.height <= 0 || start.width * start.height > 1 << 26 || count > 10000) {
        throw new Error("Bad session start");
    }

    for (let i = 0; i < count; i++) {
        let
            entry = {type: r.u8(), flags: r.u8(), alpha: r.varint(), blendMode: r.varint(), name: r.string(), children: 0};

        if (entry.type === LAYER_TYPE_GROUP) {
            entry.children = r.varint();
        }
        start.layers.push(entry);
    }

    start.activeLayer = r.varint();
    start.editingMask = r.u8() !== 0;
    start.selection = readRect(r);
    // Fields appended later are absent from older recordings
    start.engine = r.remaining > 0 ? r.varint() : 0;

    return start;
}

/**
 * Decode a SNAP payload.
 *
 * @param {Uint8Array} payload
 * @returns {Uint8Array[]} The bitmaps in snapshot order (see layerBitmaps())
 */
export function decodeSnapshot(payload) {
    let
        r = new ByteReader(payload),
        result = [];

    while (r.remaining > 0) {
        result.push(decodePNG(r.blob()).data);
    }
    return result;
}

/**
 * Copy the pixels of every layer in snapshot order: per layer in table order, its RGBA image (image layers) then its
 * mask (if it has one).
 *
 * @param {CPArtwork} artwork
 * @returns {Uint8Array[]}
 */
export function layerBitmaps(artwork) {
    let
        result = [];

    forEachLayer(artwork.getLayersRoot(), layer => {
        if (layer instanceof CPImageLayer) {
            result.push(new Uint8Array(layer.image.data));
        }
        if (layer.mask) {
            result.push(new Uint8Array(layer.mask.data));
        }
    });
    return result;
}

/**
 * Build the layer tree described by a session start into an empty artwork.
 *
 * @param {CPArtwork} artwork - New artwork with no layers
 * @param {SessionStart} start
 * @param {Uint8Array[]} bitmaps - Layer pixels in snapshot order (see layerBitmaps())
 * @param {function} CPGreyBmp
 */
export function buildLayersFromTable(artwork, start, bitmaps, CPGreyBmp) {
    let
        index = 0,
        bitmapIndex = 0;

    function nextBitmap(isMask) {
        let
            data = bitmaps[bitmapIndex++];

        if (!data || data.length !== artwork.width * artwork.height * (isMask ? 1 : 4)) {
            throw new Error("Snapshot bitmap doesn't match the canvas");
        }
        return data;
    }

    function build(parent, count) {
        for (let i = 0; i < count; i++) {
            let
                entry = start.layers[index++],
                layer;

            if (!entry) {
                throw new Error("Bad layer table");
            }

            if (entry.type === LAYER_TYPE_GROUP) {
                layer = new CPLayerGroup(entry.name, entry.blendMode);
            } else {
                layer = new CPImageLayer(artwork.width, artwork.height, entry.name);
                layer.image.data.set(nextBitmap(false));
            }

            if (entry.flags & LAYER_FLAG_MASK) {
                let
                    mask = new CPGreyBmp(artwork.width, artwork.height, 8);

                mask.data.set(nextBitmap(true));
                layer.setMask(mask);
            }

            applyLayerTableEntry(layer, entry);
            artwork.addLayerObject(parent, layer);

            if (layer instanceof CPLayerGroup) {
                build(layer, entry.children);
            }
        }
    }

    build(artwork.getLayersRoot(), start.rootChildren);

    if (index !== start.layers.length || bitmapIndex !== bitmaps.length) {
        throw new Error("Bad layer table");
    }
}

// == Events ===========================================================================================================

/**
 * Per-chunk delta coding state (reset at every EVTS chunk, so chunks decode independently).
 */
export class CoderContext {
    constructor() {
        this.x = 0;
        this.y = 0;
        this.p = 255;
    }
}

/**
 * Accumulates the events of one EVTS chunk in parallel streams: opcodes, timings, stroke dx, dy and pressure deltas,
 * other payloads, and blobs (PNGs, never deflated again).
 */
export class EventChunkWriter {
    constructor() {
        this.streams = {};
        for (let name of STREAM_NAMES) {
            this.streams[name] = new ByteWriter(4096);
        }
        this.blobs = new ByteWriter(1024);
        this.ctx = new CoderContext();
        this.count = 0;
    }

    /**
     * Approximate encoded size in bytes (before deflate).
     */
    get size() {
        return STREAM_NAMES.reduce((n, name) => n + this.streams[name].length, 0) + this.blobs.length;
    }

    /**
     * @param {Object} event - {op, dt, ...payload}
     */
    write(event) {
        let
            s = this.streams,
            w = s.other,
            ctx = this.ctx;

        s.op.varint(event.op);
        s.dt.varint(event.dt);

        if (NO_PAYLOAD.has(event.op)) {
            this.count++;
            return;
        }

        switch (event.op) {
            case OP.STROKE_BEGIN:
            case OP.STROKE_POINT:
                s.dx.svarint(event.x - ctx.x);
                s.dy.svarint(event.y - ctx.y);
                s.p.svarint(event.p - ctx.p);
                ctx.x = event.x;
                ctx.y = event.y;
                ctx.p = event.p;
                if (event.op === OP.STROKE_BEGIN) {
                    w.varint(event.seed);
                }
                break;
            case OP.TOOL:
                w.varint(event.field);
                if (event.field === TOOL_COLOR) {
                    w.u24(event.value);
                } else {
                    w.num(+event.value);
                }
                break;
            case OP.TEXTURE:
                w.u8(event.png ? 1 : 0);
                if (event.png) {
                    this.blobs.blob(event.png);
                }
                break;
            case OP.SELECT_LAYER:
                w.varint(event.layer);
                w.u8(event.mask ? 1 : 0);
                break;
            case OP.EXPAND_GROUP:
                w.varint(event.layer);
                w.u8(event.expand ? 1 : 0);
                break;
            case OP.ADD_LAYER:
                w.u8(event.group ? 1 : 0);
                break;
            case OP.RELOCATE_LAYER:
                w.varint(event.layer);
                w.varint(event.group);
                w.varint(event.index);
                break;
            case OP.LAYER_VISIBLE:
            case OP.MASK_VISIBLE:
                w.varint(event.layer);
                w.u8(event.value ? 1 : 0);
                break;
            case OP.LAYER_ALPHA:
            case OP.LAYER_BLEND:
                w.num(event.value);
                break;
            case OP.LAYER_NAME:
                w.varint(event.layer);
                w.string(event.name);
                break;
            case OP.MASK_LINKED:
            case OP.LOCK_ALPHA:
                w.u8(event.value ? 1 : 0);
                break;
            case OP.RECT_SELECTION:
            case OP.SET_SELECTION:
                writeRect(w, event.rect);
                break;
            case OP.MOVE:
                w.svarint(event.dx);
                w.svarint(event.dy);
                w.u8(event.copy ? 1 : 0);
                break;
            case OP.PASTE:
                w.u8(event.png ? 1 : 0);
                if (event.png) {
                    w.svarint(event.x);
                    w.svarint(event.y);
                    w.u8(event.grey ? 1 : 0);
                    this.blobs.blob(event.png);
                }
                break;
            case OP.TRANSFORM:
                writeRect(w, event.selection);
                w.varint(event.layer);
                w.u8(event.mask ? 1 : 0);
                w.varint(event.changes.length);
                for (let change of event.changes) {
                    w.varint(change.layer);
                    w.u8((change.image ? 1 : 0) | (change.mask ? 2 : 0));
                    w.varint(change.rect.left);
                    w.varint(change.rect.top);
                    w.varint(change.rect.right - change.rect.left);
                    w.varint(change.rect.bottom - change.rect.top);
                    if (change.image) {
                        this.blobs.blob(change.image);
                    }
                    if (change.mask) {
                        this.blobs.blob(change.mask);
                    }
                }
                break;
            case OP.FILL:
                w.u32(event.color);
                break;
            case OP.FLOOD_FILL:
                w.svarint(event.x);
                w.svarint(event.y);
                break;
            case OP.GRADIENT_FILL:
                w.num(event.fromX);
                w.num(event.fromY);
                w.num(event.toX);
                w.num(event.toY);
                w.varint(event.colors.length);
                for (let color of event.colors) {
                    w.u32(color);
                }
                break;
            case OP.NOISE_MONO:
            case OP.NOISE_COLOR:
                w.varint(event.seed);
                break;
            case OP.BOX_BLUR:
                w.varint(event.radiusX);
                w.varint(event.radiusY);
                w.varint(event.iterations);
                break;
            case OP.CHECKPOINT:
                w.u32(event.hash);
                break;
            default:
                throw new Error("Can't encode event " + event.op);
        }

        this.count++;
    }

    /**
     * Encode the EVTS payload of the events written so far (the writer can keep accepting events afterwards).
     *
     * @returns {Uint8Array}
     */
    toPayload() {
        let
            joined = new ByteWriter(this.size + 32);

        joined.varint(STREAM_NAMES.length);
        for (let name of STREAM_NAMES) {
            joined.varint(this.streams[name].length);
        }
        for (let name of STREAM_NAMES) {
            joined.bytes(this.streams[name].view());
        }

        let
            raw = joined.view(),
            deflated = pako.deflate(raw),
            compressed = deflated.length < raw.length,
            stored = compressed ? deflated : raw,
            w = new ByteWriter(stored.length + this.blobs.length + 16);

        w.varint(this.count);
        w.u8(compressed ? 1 : 0);
        w.varint(raw.length);
        w.varint(stored.length);
        w.bytes(stored);
        w.bytes(this.blobs.view());

        return w.toBytes();
    }
}

/**
 * Decode one EVTS payload.
 *
 * @param {Uint8Array} payload
 * @returns {Object[]} events ({op, dt, ...payload}), with PNG blobs as Uint8Arrays
 */
export function decodeEvents(payload) {
    let
        r = new ByteReader(payload),
        count = r.varint(),
        compression = r.u8(),
        rawLength = r.varint(),
        stored = r.bytes(r.varint()),
        raw = compression === 1 ? pako.inflate(stored) : stored,
        blobs = new ByteReader(payload.subarray(r.pos));

    if (compression > 1 || raw.length !== rawLength) {
        throw new Error("Bad event chunk");
    }

    let
        jr = new ByteReader(raw),
        n = jr.varint(),
        lengths = [],
        s = {};

    if (n < STREAM_NAMES.length) {
        throw new Error("Bad event streams");
    }
    for (let i = 0; i < n; i++) {
        lengths.push(jr.varint());
    }
    STREAM_NAMES.forEach((name, i) => {
        s[name] = new ByteReader(jr.bytes(lengths[i]));
    });

    let
        ctx = new CoderContext(),
        w = s.other,
        events = [];

    for (let i = 0; i < count; i++) {
        let
            op = s.op.varint(),
            event = {op: op, dt: s.dt.varint()};

        if (!NO_PAYLOAD.has(op)) {
            switch (op) {
                case OP.STROKE_BEGIN:
                case OP.STROKE_POINT:
                    ctx.x += s.dx.svarint();
                    ctx.y += s.dy.svarint();
                    ctx.p += s.p.svarint();
                    event.x = ctx.x;
                    event.y = ctx.y;
                    event.p = ctx.p;
                    if (op === OP.STROKE_BEGIN) {
                        event.seed = w.varint();
                    }
                    break;
                case OP.TOOL:
                    event.field = w.varint();
                    event.value = event.field === TOOL_COLOR ? w.u24() : w.num();
                    break;
                case OP.TEXTURE:
                    event.png = w.u8() ? blobs.blob() : null;
                    break;
                case OP.SELECT_LAYER:
                    event.layer = w.varint();
                    event.mask = w.u8() !== 0;
                    break;
                case OP.EXPAND_GROUP:
                    event.layer = w.varint();
                    event.expand = w.u8() !== 0;
                    break;
                case OP.ADD_LAYER:
                    event.group = w.u8() !== 0;
                    break;
                case OP.RELOCATE_LAYER:
                    event.layer = w.varint();
                    event.group = w.varint();
                    event.index = w.varint();
                    break;
                case OP.LAYER_VISIBLE:
                case OP.MASK_VISIBLE:
                    event.layer = w.varint();
                    event.value = w.u8() !== 0;
                    break;
                case OP.LAYER_ALPHA:
                case OP.LAYER_BLEND:
                    event.value = w.num();
                    break;
                case OP.LAYER_NAME:
                    event.layer = w.varint();
                    event.name = w.string();
                    break;
                case OP.MASK_LINKED:
                case OP.LOCK_ALPHA:
                    event.value = w.u8() !== 0;
                    break;
                case OP.RECT_SELECTION:
                case OP.SET_SELECTION:
                    event.rect = readRect(w);
                    break;
                case OP.MOVE:
                    event.dx = w.svarint();
                    event.dy = w.svarint();
                    event.copy = w.u8() !== 0;
                    break;
                case OP.PASTE:
                    if (w.u8()) {
                        event.x = w.svarint();
                        event.y = w.svarint();
                        event.grey = w.u8() !== 0;
                        event.png = blobs.blob();
                    } else {
                        event.png = null;
                    }
                    break;
                case OP.TRANSFORM:
                    event.selection = readRect(w);
                    event.layer = w.varint();
                    event.mask = w.u8() !== 0;
                    event.changes = [];
                    for (let j = w.varint(); j > 0; j--) {
                        let
                            change = {layer: w.varint()},
                            flags = w.u8(),
                            left = w.varint(),
                            top = w.varint(),
                            width = w.varint(),
                            height = w.varint();

                        change.rect = {left: left, top: top, right: left + width, bottom: top + height};
                        change.image = flags & 1 ? blobs.blob() : null;
                        change.mask = flags & 2 ? blobs.blob() : null;
                        event.changes.push(change);
                    }
                    break;
                case OP.FILL:
                    event.color = w.u32();
                    break;
                case OP.FLOOD_FILL:
                    event.x = w.svarint();
                    event.y = w.svarint();
                    break;
                case OP.GRADIENT_FILL:
                    event.fromX = w.num();
                    event.fromY = w.num();
                    event.toX = w.num();
                    event.toY = w.num();
                    event.colors = [];
                    for (let j = w.varint(); j > 0; j--) {
                        event.colors.push(w.u32());
                    }
                    break;
                case OP.NOISE_MONO:
                case OP.NOISE_COLOR:
                    event.seed = w.varint();
                    break;
                case OP.BOX_BLUR:
                    event.radiusX = w.varint();
                    event.radiusY = w.varint();
                    event.iterations = w.varint();
                    break;
                case OP.CHECKPOINT:
                    event.hash = w.u32();
                    break;
                default:
                    throw new Error("Unknown event opcode " + op);
            }
        }

        events.push(event);
    }

    return events;
}

/**
 * Assemble a complete recording file.
 *
 * @param {Uint8Array} body - Chunks (header first), without the magic or the end chunk
 * @returns {Uint8Array}
 */
export function finishRecording(body) {
    let
        end = new ByteWriter(16);

    writeChunk(end, CHUNK_END, new Uint8Array(0));

    return concatBytes([MAGIC, body, end.view()]);
}
