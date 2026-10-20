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

import CPImageLayer from "./CPImageLayer.js";
import CPGreyBmp from "./CPGreyBmp.js";
import {ByteWriter} from "../util/CPByteStream.js";
import {encodePNG} from "../util/CPPNG.js";
import {
    OP, BRUSH_FIELDS, COORD_SCALE,
    START_BLANK, START_CONTINUE, START_CONTINUE_FLAT, START_REFERENCE, START_SNAPSHOT, SOURCE_PNG,
    CHUNK_HEADER, CHUNK_SESSION, ENGINE_REVISION, CHUNK_SNAPSHOT, CHUNK_EVENTS, CHUNK_SESSION_END,
    EventChunkWriter, writeChunk, finishRecording, parseRecording, encodeHeader, encodeSessionStart, encodeSessionEnd,
    getLayerTable, layerList, forEachLayer, hashLayers, hashComposite, hashImage, rotateRGBA
} from "./CPRecordingFormat.js";

const
    DEFAULT_MAX_BYTES = 16 * 1024 * 1024,
    DEFAULT_MAX_EVENTS = 4000000,
    DEFAULT_CHECKPOINT_INTERVAL = 300,
    CHUNK_MAX_EVENTS = 16384,
    CHUNK_MAX_BYTES = 1024 * 1024;

/**
 * Methods of CPArtwork that the recorder records. Calls that these make to each other (and that undo actions make)
 * aren't recorded, only the outermost call.
 */
const
    SIMPLE_OPS = {
        removeLayer: OP.REMOVE_LAYER,
        duplicateLayer: OP.DUPLICATE_LAYER,
        mergeDown: OP.MERGE_DOWN,
        mergeGroup: OP.MERGE_GROUP,
        mergeAllLayers: OP.MERGE_ALL,
        addLayerMask: OP.ADD_MASK,
        removeLayerMask: OP.REMOVE_MASK,
        applyLayerMask: OP.APPLY_MASK,
        createClippingMask: OP.CLIP_CREATE,
        releaseClippingMask: OP.CLIP_RELEASE,
        clear: OP.CLEAR,
        hFlip: OP.FLIP_H,
        vFlip: OP.FLIP_V,
        invert: OP.INVERT,
        undo: OP.UNDO,
        redo: OP.REDO,
        clearHistory: OP.CLEAR_HISTORY
    };

function now() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function rectOf(rect) {
    return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom};
}

function isBlankDocument(artwork) {
    let
        layers = artwork.getLayersRoot().layers;

    if (layers.length !== 1 || !(layers[0] instanceof CPImageLayer) || layers[0].mask) {
        return false;
    }

    let
        data = layers[0].image.data,
        words = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);

    for (let i = 0; i < words.length; i++) {
        if (words[i] !== 0xFFFFFFFF) {
            return false;
        }
    }
    return true;
}

/**
 * Records the drawing process of a CPArtwork, for timelapse replay by CPRecordingPlayer. See docs/recording-format.md.
 *
 * The recorder stores the inputs of each operation (stroke points, tool settings, layer operations, undo/redo...) and
 * replays them through the same engine, so recordings are small. Only operations whose results can't be reproduced
 * from their inputs store pixels (free transforms, which the browser's canvas renders, and pastes of images from
 * outside the drawing).
 *
 * To make strokes reproducible, while recording the stroke coordinates and pressures passed to the engine are rounded
 * to the precision the recording stores (1/16 pixel, 1/255 pressure), and the random number generator is reseeded for
 * each stroke and noise fill.
 *
 * @param {CPArtwork} artwork - The document as just loaded (before any editing)
 * @param {Object} [options]
 * @param {?Uint8Array} [options.previous] - The recording of the drawing's previous versions, to continue
 * @param {string} [options.sourceUrl] - A permanent URL of the file the artwork was loaded from (used when the artwork
 *                                       doesn't match the end of the previous recording, instead of embedding a
 *                                       snapshot of the layers)
 * @param {int} [options.sourceFormat] - SOURCE_PNG or SOURCE_CHI
 * @param {int} [options.maxBytes] - Size limit for the whole recording file
 * @param {int} [options.maxEvents] - Event limit for this session
 * @param {int} [options.checkpointInterval] - Minimum events between composite hash checkpoints
 * @param {function(function()):function()} [options.idle] - Schedules a callback for when the editor is idle, and
 *     returns a function that cancels it. Checkpoint hashes (a few ms for a big drawing) are then computed when idle
 *     instead of at the end of a stroke; if the drawing changes first, that checkpoint is skipped, and tried again at
 *     the end of the next stroke. Without it they're computed at once.
 * @param {function():number} [options.clock] - Millisecond clock (defaults to performance.now())
 * @param {int} [options.startedAt] - Wall clock time of the session start (ms since the epoch)
 *
 * @constructor
 */
export default function CPRecorder(artwork, options) {
    options = options || {};

    const
        that = this,
        clock = options.clock || now,
        maxBytes = options.maxBytes || DEFAULT_MAX_BYTES,
        maxEvents = options.maxEvents || DEFAULT_MAX_EVENTS,
        checkpointInterval = options.checkpointInterval || DEFAULT_CHECKPOINT_INTERVAL,
        originals = {},
        ids = new WeakMap();

    let
        previousBody = null,
        sessionIndex = 0,
        start,
        snapshotBitmaps = null,
        snapshotPayload = null,

        startTime = clock(),
        lastTime = 0,

        finishedChunks = [],
        finishedBytes = 0,
        chunk = new EventChunkWriter(),
        eventCount = 0,
        eventsSinceCheckpoint = 0,
        truncated = false,

        depth = 0,
        nextId = 1,
        inStroke = false,
        /**
         * The events of the stroke in progress, each {event, time}, held back until the stroke ends so that a stroke
         * the editor abandons (abortStroke()) leaves no trace. Null once they're written (or if there's no stroke).
         *
         * @type {?Object[]}
         */
        pendingStroke = null,
        toolState = {},
        toolTexture,
        knownClip = artwork.getClipboard(),
        pendingTransform = false,

        /**
         * Cancels the checkpoint waiting for the editor to be idle (options.idle)
         */
        cancelCheckpoint = null,
        drawingChanged = false,

        attached = true;

    /**
     * Why the recording was cut short (null if it wasn't).
     *
     * @type {?string}
     */
    this.truncatedReason = null;

    /**
     * Set if the previous recording couldn't be read (so this one starts over).
     *
     * @type {?Error}
     */
    this.previousError = null;

    function assignIds() {
        forEachLayer(artwork.getLayersRoot(), layer => {
            if (!ids.has(layer)) {
                ids.set(layer, nextId++);
            }
        });
    }

    function truncate(reason) {
        if (!truncated) {
            truncated = true;
            that.truncatedReason = reason;
        }
    }

    /**
     * @param {CPLayer} layer
     * @returns {int} The layer's id, or -1 if it isn't part of the document
     */
    function idOf(layer) {
        if (layer === artwork.getLayersRoot()) {
            return 0;
        }
        if (!ids.has(layer)) {
            assignIds();
        }
        if (ids.has(layer)) {
            return ids.get(layer);
        }
        truncate("operation on a layer outside the document");
        return -1;
    }

    function emit(event) {
        // Keep the events in order: anything recorded during a stroke follows the points it already has
        flushPendingStroke();
        write(event, clock());
    }

    /**
     * Record an event of the stroke in progress.
     */
    function emitStrokeEvent(event) {
        if (pendingStroke) {
            pendingStroke.push({event: event, time: clock()});
        } else {
            write(event, clock());
        }
    }

    function flushPendingStroke() {
        if (pendingStroke) {
            let
                events = pendingStroke;

            pendingStroke = null;
            for (let e of events) {
                write(e.event, e.time);
            }
        }
    }

    /**
     * @param {Object} event
     * @param {number} time - Clock time of the event
     */
    function write(event, time) {
        if (truncated) {
            return;
        }

        let
            t = Math.max(lastTime, Math.round(time - startTime));

        event.dt = t - lastTime;
        lastTime = t;

        chunk.write(event);
        eventCount++;
        eventsSinceCheckpoint++;

        if (chunk.count >= CHUNK_MAX_EVENTS || chunk.size >= CHUNK_MAX_BYTES) {
            let
                payload = chunk.toPayload();

            finishedChunks.push(payload);
            finishedBytes += payload.length;
            chunk = new EventChunkWriter();
        }

        if (eventCount >= maxEvents) {
            truncate("too many events");
        } else if ((previousBody ? previousBody.length : 0) + finishedBytes + chunk.size > maxBytes) {
            truncate("recording too large");
        }
    }

    function greyPNG(bmp) {
        return encodePNG(bmp.width, bmp.height, bmp.data, 1);
    }

    /**
     * Record any changes of the tool settings that strokes and fills use.
     */
    function syncTool() {
        let
            brush = artwork.getBrush(),
            texture = artwork.getBrushTexture(),
            values = [artwork.getForegroundColor() & 0xFFFFFF, artwork.getSampleAllLayers() ? 1 : 0];

        for (let field = 2; field < BRUSH_FIELDS.length; field++) {
            let
                value = brush ? brush[BRUSH_FIELDS[field]] : undefined;

            values.push(typeof value === "boolean" ? +value : value);
        }

        values.forEach((value, field) => {
            if (typeof value === "number" && !Object.is(toolState[field], value)) {
                toolState[field] = value;
                emit({op: OP.TOOL, field: field, value: value});
            }
        });

        if (texture !== toolTexture) {
            toolTexture = texture;
            emit({op: OP.TEXTURE, png: texture ? greyPNG(texture) : null});
        }
    }

    function newSeed() {
        return (Math.random() * 0x100000000) >>> 0;
    }

    function quantizePoint(x, y, pressure) {
        let
            qx = Math.round(x * COORD_SCALE) || 0,
            qy = Math.round(y * COORD_SCALE) || 0,
            qp = Math.round(Math.max(0, Math.min(1, pressure)) * 255) || 0;

        return {x: qx, y: qy, p: qp};
    }

    function checkpoint() {
        eventsSinceCheckpoint = 0;
        emit({op: OP.CHECKPOINT, hash: hashComposite(artwork)});
    }

    function maybeCheckpoint() {
        if (eventsSinceCheckpoint < checkpointInterval || cancelCheckpoint) {
            return;
        }
        if (!options.idle) {
            checkpoint();
            return;
        }

        let
            due = eventCount;

        drawingChanged = false;
        cancelCheckpoint = options.idle(() => {
            cancelCheckpoint = null;
            // The hash must be of the drawing as the last event left it
            if (attached && !truncated && !inStroke && !drawingChanged && eventCount === due) {
                checkpoint();
            }
        });
    }

    function onUpdateRegion() {
        drawingChanged = true;
    }

    function onAddUndo(undo) {
        if (!pendingTransform || !attached) {
            return;
        }
        pendingTransform = false;

        // A CPActionAffineTransformSelection: record the pixels it produced
        let
            bounds = artwork.getBounds(),
            damaged = undo.srcRect.getUnion(undo.dstRect).getIntersection(bounds),
            changes = [];

        if (!damaged.isEmpty()) {
            for (let info of undo.movingLayers) {
                if (!info.moveImage && !info.moveMask) {
                    continue;
                }

                let
                    change = {layer: idOf(info.layer), rect: rectOf(damaged), image: null, mask: null};

                if (info.moveImage) {
                    let
                        bmp = info.layer.image.cloneRect(damaged);

                    change.image = encodePNG(bmp.width, bmp.height, bmp.data, 4);
                }
                if (info.moveMask) {
                    change.mask = greyPNG(info.layer.mask.cloneRect(damaged));
                }
                changes.push(change);
            }
        }

        emit({
            op: OP.TRANSFORM,
            selection: rectOf(artwork.getSelection()),
            layer: idOf(undo.layer),
            mask: !!undo.fromMaskMode,
            changes: changes
        });
    }

    /**
     * Handlers for the recorded methods: each gets the original method and the arguments, and returns its result.
     */
    const handlers = {
        beginStroke(original, x, y, pressure) {
            if (!artwork.getBrush()) {
                return original(x, y, pressure);
            }

            syncTool();

            let
                seed = newSeed(),
                q = quantizePoint(x, y, pressure);

            artwork.setRandomSeed(seed);
            if (artwork.getSampleAllLayers()) {
                // The engine samples the cached composite, make sure it's up to date (as the player's will be)
                artwork.fusionLayers();
            }

            let
                result = original(q.x / COORD_SCALE, q.y / COORD_SCALE, q.p / 255);

            if (result) {
                flushPendingStroke();
                pendingStroke = [];
                emitStrokeEvent({op: OP.STROKE_BEGIN, x: q.x, y: q.y, p: q.p, seed: seed});
                inStroke = true;
            }

            return result;
        },

        continueStroke(original, x, y, pressure) {
            if (!inStroke) {
                return original(x, y, pressure);
            }

            let
                q = quantizePoint(x, y, pressure);

            // (Even a repeat of the previous point isn't a no-op: the brush spacing depends on the last dab's pressure)
            emitStrokeEvent({op: OP.STROKE_POINT, x: q.x, y: q.y, p: q.p});

            return original(q.x / COORD_SCALE, q.y / COORD_SCALE, q.p / 255);
        },

        endStroke(original) {
            let
                result = original();

            if (inStroke) {
                inStroke = false;
                emit({op: OP.STROKE_END});
                maybeCheckpoint();
            }

            return result;
        },

        abortStroke(original) {
            let
                result = original();

            if (inStroke) {
                inStroke = false;
                if (pendingStroke) {
                    // The layer is back as it was, so as far as the replay is concerned the stroke never happened
                    pendingStroke = null;
                } else {
                    // Its points are already in the recording (it was sent mid-stroke), which has no way to take them back
                    truncate("stroke abandoned after it was recorded");
                }
            }

            return result;
        },

        floodFill(original, x, y) {
            syncTool();
            emit({op: OP.FLOOD_FILL, x: ~~x, y: ~~y});
            return original(x, y);
        },

        gradientFill(original, fromX, fromY, toX, toY, gradientPoints) {
            emit({
                op: OP.GRADIENT_FILL, fromX: fromX, fromY: fromY, toX: toX, toY: toY,
                colors: gradientPoints.map(color => color >>> 0)
            });
            return original(fromX, fromY, toX, toY, gradientPoints);
        },

        fill(original, color) {
            emit({op: OP.FILL, color: color >>> 0});
            return original(color);
        },

        flip(original, horizontal) {
            emit({op: horizontal ? OP.FLIP_H : OP.FLIP_V});
            return original(horizontal);
        },

        monochromaticNoise(original) {
            let
                seed = newSeed();

            artwork.setRandomSeed(seed);
            emit({op: OP.NOISE_MONO, seed: seed});
            return original();
        },

        colorNoise(original) {
            let
                seed = newSeed();

            artwork.setRandomSeed(seed);
            emit({op: OP.NOISE_COLOR, seed: seed});
            return original();
        },

        boxBlur(original, radiusX, radiusY, iterations) {
            emit({op: OP.BOX_BLUR, radiusX: radiusX | 0, radiusY: radiusY | 0, iterations: iterations | 0});
            return original(radiusX | 0, radiusY | 0, iterations | 0);
        },

        rectangleSelection(original, rect) {
            emit({op: OP.RECT_SELECTION, rect: rectOf(rect)});
            return original(rect);
        },

        setSelection(original, rect) {
            emit({op: OP.SET_SELECTION, rect: rectOf(rect)});
            return original(rect);
        },

        emptySelection(original) {
            emit({op: OP.SET_SELECTION, rect: {left: 0, top: 0, right: 0, bottom: 0}});
            return original();
        },

        move(original, offsetX, offsetY, copy) {
            emit({op: OP.MOVE, dx: offsetX | 0, dy: offsetY | 0, copy: !!copy});
            return original(offsetX, offsetY, copy);
        },

        cutSelection(original) {
            emit({op: OP.CUT});
            let
                result = original();

            knownClip = artwork.getClipboard();
            return result;
        },

        copySelection(original) {
            emit({op: OP.COPY});
            let
                result = original();

            knownClip = artwork.getClipboard();
            return result;
        },

        copySelectionMerged(original) {
            emit({op: OP.COPY_MERGED});
            let
                result = original();

            knownClip = artwork.getClipboard();
            return result;
        },

        pasteClipboard(original) {
            let
                clip = artwork.getClipboard();

            if (clip && clip !== knownClip) {
                // From outside the drawing, so the player won't have it
                let
                    grey = clip.bmp instanceof CPGreyBmp;

                emit({
                    op: OP.PASTE, x: clip.x | 0, y: clip.y | 0, grey: grey,
                    png: encodePNG(clip.bmp.width, clip.bmp.height, clip.bmp.data, grey ? 1 : 4)
                });
                knownClip = clip;
            } else {
                emit({op: OP.PASTE, png: null});
            }
            return original();
        },

        transformAffineFinish(original) {
            pendingTransform = true;
            try {
                return original();
            } finally {
                pendingTransform = false;
            }
        },

        addLayer(original, layerType) {
            emit({op: OP.ADD_LAYER, group: layerType === "group"});
            return original(layerType);
        },

        relocateLayer(original, layer, toGroup, toIndex) {
            emit({op: OP.RELOCATE_LAYER, layer: idOf(layer), group: idOf(toGroup), index: toIndex | 0});
            return original(layer, toGroup, toIndex);
        },

        setActiveLayer(original, layer, selectMask) {
            if (layer) {
                emit({op: OP.SELECT_LAYER, layer: idOf(layer), mask: !!selectMask});
            }
            return original(layer, selectMask);
        },

        expandLayerGroup(original, group, expand) {
            emit({op: OP.EXPAND_GROUP, layer: idOf(group), expand: !!expand});
            return original(group, expand);
        },

        setLayerVisibility(original, layer, visible) {
            emit({op: OP.LAYER_VISIBLE, layer: idOf(layer), value: !!visible});
            return original(layer, visible);
        },

        setLayerMaskVisible(original, layer, visible) {
            emit({op: OP.MASK_VISIBLE, layer: idOf(layer), value: !!visible});
            return original(layer, visible);
        },

        setLayerName(original, layer, name) {
            emit({op: OP.LAYER_NAME, layer: idOf(layer), name: String(name)});
            return original(layer, name);
        },

        setLayerAlpha(original, alpha) {
            emit({op: OP.LAYER_ALPHA, value: alpha});
            return original(alpha);
        },

        setLayerBlendMode(original, blendMode) {
            emit({op: OP.LAYER_BLEND, value: blendMode});
            return original(blendMode);
        },

        setLayerMaskLinked(original, linked) {
            emit({op: OP.MASK_LINKED, value: !!linked});
            return original(linked);
        },

        setLayerLockAlpha(original, lock) {
            emit({op: OP.LOCK_ALPHA, value: !!lock});
            return original(lock);
        }
    };

    /*
     * Methods that aren't recorded, and whose calls to recorded methods aren't recorded either (the free transform
     * preview: its effect is recorded when it's finished, or undone when it's aborted).
     */
    for (let name of ["transformAffineBegin", "transformAffineAmend", "transformAffineAbort", "setTransformInterpolation"]) {
        handlers[name] = (original, ...args) => original(...args);
    }

    for (let name of Object.keys(SIMPLE_OPS)) {
        let
            op = SIMPLE_OPS[name];

        handlers[name] = (original, ...args) => {
            emit({op: op});
            return original(...args);
        };
    }

    // == Session start ================================================================================================

    if (options.previous && options.previous.length) {
        try {
            let
                previous = parseRecording(options.previous);

            previousBody = previous.body;
            sessionIndex = previous.sessions.length;

            let
                last = previous.sessions[previous.sessions.length - 1],
                end = last && last.end;

            this.previousEnd = end && !end.truncated ? end : null;
        } catch (e) {
            this.previousError = e;
            previousBody = null;
            sessionIndex = 0;
        }
    }

    {
        let
            startHash = hashLayers(artwork),
            prevEnd = this.previousEnd,
            rootLayers = artwork.getLayersRoot().layers,
            kind;

        if (prevEnd && startHash === prevEnd.layersHash && artwork.width === prevEnd.width && artwork.height === prevEnd.height) {
            kind = START_CONTINUE;
        } else if (prevEnd && prevEnd.simple && rootLayers.length === 1 && rootLayers[0] instanceof CPImageLayer
                && !rootLayers[0].mask
                && hashImage(artwork.width, artwork.height, rootLayers[0].image.data) === prevEnd.imageHash) {
            // The previous version was saved as a flat image, and that's what we loaded
            kind = START_CONTINUE_FLAT;
        } else if (!previousBody && isBlankDocument(artwork)) {
            kind = START_BLANK;
        } else if (options.sourceUrl) {
            kind = START_REFERENCE;
        } else {
            kind = START_SNAPSHOT;
            // Copy the layers now, they're encoded when the recording is first requested
            snapshotBitmaps = [];
            forEachLayer(artwork.getLayersRoot(), layer => {
                if (layer instanceof CPImageLayer) {
                    snapshotBitmaps.push(layer.image.clone());
                }
                if (layer.mask) {
                    snapshotBitmaps.push(layer.mask.clone());
                }
            });
        }

        let
            layers = layerList(artwork),
            selection = artwork.getSelection();

        start = {
            index: sessionIndex,
            kind: kind,
            width: artwork.width,
            height: artwork.height,
            startedAt: Math.max(0, Math.round(options.startedAt === undefined ? Date.now() : options.startedAt)),
            startHash: startHash,
            sourceUrl: options.sourceUrl || "",
            sourceFormat: options.sourceFormat || SOURCE_PNG,
            rootChildren: rootLayers.length,
            layers: getLayerTable(artwork),
            activeLayer: Math.max(0, layers.indexOf(artwork.getActiveLayer())),
            editingMask: artwork.isEditingMask(),
            selection: rectOf(selection),
            engine: ENGINE_REVISION
        };
    }

    /**
     * How this session starts (one of the START_* constants of CPRecordingFormat).
     *
     * @type {int}
     */
    this.startKind = start.kind;

    function encodeSnapshotPayload() {
        if (!snapshotPayload) {
            let
                w = new ByteWriter(64 * 1024);

            for (let bmp of snapshotBitmaps) {
                if (bmp instanceof CPGreyBmp) {
                    w.blob(encodePNG(bmp.width, bmp.height, bmp.data, 1));
                } else {
                    w.blob(encodePNG(bmp.width, bmp.height, bmp.data, 4));
                }
            }
            snapshotPayload = w.toBytes();
            snapshotBitmaps = null;
        }
        return snapshotPayload;
    }

    assignIds();

    // The replay can't undo past the start of the session, so neither can the editor
    artwork.clearHistory();

    // == Wrapping =====================================================================================================

    artwork.on("addUndo", onAddUndo);
    artwork.on("updateRegion", onUpdateRegion);

    for (let name of Object.keys(handlers)) {
        let
            original = artwork[name],
            handler = handlers[name];

        if (typeof original !== "function") {
            continue;
        }

        originals[name] = original;

        artwork[name] = function(...args) {
            if (depth > 0 || !attached) {
                return original.apply(artwork, args);
            }

            depth++;
            try {
                return handler((...a) => original.apply(artwork, a), ...args);
            } finally {
                depth--;
                assignIds();
            }
        };
    }

    // == Public API ===================================================================================================

    /**
     * Get the recording so far: the previous recording (if any) plus this session. Can be called repeatedly (e.g.
     * for each save), each call returns the whole file again.
     *
     * @param {Object} [saveOptions]
     * @param {int} [saveOptions.rotation] - The rotation the flat image is being saved with (as CPResourceSaver)
     * @returns {?Uint8Array} The recording, or null if it would exceed the size limit
     */
    this.getRecording = function(saveOptions) {
        // A stroke in progress is part of the drawing being sent
        flushPendingStroke();

        let
            rotation = (saveOptions && saveOptions.rotation) || 0,
            out = new ByteWriter(1024 * 1024),
            fusion = artwork.fusionLayers(),
            rotated = rotateRGBA(fusion.width, fusion.height, fusion.data, rotation);

        if (previousBody) {
            out.bytes(previousBody);
        } else {
            writeChunk(out, CHUNK_HEADER, encodeHeader({Software: "ChickenPaint"}));
        }

        writeChunk(out, CHUNK_SESSION, encodeSessionStart(start));

        if (start.kind === START_SNAPSHOT) {
            writeChunk(out, CHUNK_SNAPSHOT, encodeSnapshotPayload());
        }

        for (let payload of finishedChunks) {
            writeChunk(out, CHUNK_EVENTS, payload);
        }
        if (chunk.count > 0) {
            writeChunk(out, CHUNK_EVENTS, chunk.toPayload());
        }

        writeChunk(out, CHUNK_SESSION_END, encodeSessionEnd({
            eventCount: eventCount,
            durationMs: Math.max(lastTime, Math.round(clock() - startTime)),
            truncated: truncated,
            simple: artwork.isSimpleDrawing(),
            rotation: rotation,
            compositeHash: hashImage(fusion.width, fusion.height, fusion.data),
            imageHash: hashImage(rotated.width, rotated.height, rotated.data),
            layersHash: hashLayers(artwork),
            width: artwork.width,
            height: artwork.height,
            layerCount: layerList(artwork).length
        }));

        let
            result = finishRecording(out.view());

        return result.length <= maxBytes ? result : null;
    };

    /**
     * @returns {boolean} True if the recording stopped early (too large, or an operation it couldn't record)
     */
    this.isTruncated = function() {
        return truncated;
    };

    /**
     * Stop recording and restore the artwork's methods.
     */
    this.detach = function() {
        if (attached) {
            flushPendingStroke();
            attached = false;
            for (let name of Object.keys(originals)) {
                artwork[name] = originals[name];
            }
            artwork.off("addUndo", onAddUndo);
            artwork.off("updateRegion", onUpdateRegion);
            if (cancelCheckpoint) {
                cancelCheckpoint();
                cancelCheckpoint = null;
            }
        }
    };
}
