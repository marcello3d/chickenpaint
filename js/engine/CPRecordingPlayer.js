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

import CPArtwork from "./CPArtwork.js";
import CPBrushInfo from "./CPBrushInfo.js";
import CPColorBmp from "./CPColorBmp.js";
import CPGreyBmp from "./CPGreyBmp.js";
import CPImageLayer from "./CPImageLayer.js";
import CPClip from "./CPClip.js";
import CPLayerGroup from "./CPLayerGroup.js";
import {load as chiLoad} from "./CPChibiFile.js";
import CPRect from "../util/CPRect.js";
import {decodePNG} from "../util/CPPNG.js";
import {
    OP, TOOL_COLOR, TOOL_SAMPLE_ALL_LAYERS, BRUSH_FIELDS, COORD_SCALE,
    START_BLANK, START_CONTINUE, START_CONTINUE_FLAT, START_REFERENCE, START_SNAPSHOT, SOURCE_CHI,
    parseRecording, inflateEvents, decodeEventTimes, decodeEvents, decodeSnapshot, layerBitmaps, buildLayersFromTable, applyLayerTableEntry,
    layerTableMatches, layerList, forEachLayer, hashLayers, hashComposite, rotateRGBA, getLayerTable
} from "./CPRecordingFormat.js";

const
    BOOLEAN_BRUSH_FIELDS = new Set(["isAA", "pressureSize", "pressureAlpha", "pressureScattering"]);

function toCPRect(rect) {
    return new CPRect(rect.left, rect.top, rect.right, rect.bottom);
}

function colorBmpFromRGBA(width, height, data) {
    let
        bmp = new CPColorBmp(width, height);

    bmp.data.set(data);
    return bmp;
}

function greyBmpFromData(width, height, data) {
    let
        bmp = new CPGreyBmp(width, height, 8);

    bmp.data.set(data);
    return bmp;
}

function decodeColorPNG(png) {
    let
        image = decodePNG(png);

    if (image.channels === 1) {
        let
            rgba = new Uint8Array(image.width * image.height * 4);

        for (let i = 0; i < image.data.length; i++) {
            rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = image.data[i];
            rgba[i * 4 + 3] = 255;
        }
        return colorBmpFromRGBA(image.width, image.height, rgba);
    }
    return colorBmpFromRGBA(image.width, image.height, image.data);
}

function decodeGreyPNG(png) {
    let
        image = decodePNG(png);

    if (image.channels !== 1) {
        throw new Error("Expected a greyscale image");
    }
    return greyBmpFromData(image.width, image.height, image.data);
}

/**
 * Replays a drawing recording made by CPRecorder in a headless CPArtwork, through the same engine methods the editor
 * called. See docs/recording-format.md.
 *
 * Usage: construct, await prepare(), then call advanceTo(time) to replay up to a time on the playback timeline, and
 * read `artwork` to render it. Going backwards requires reset() (replays from the start).
 *
 * @param {Uint8Array} bytes - The recording
 * @param {Object} [options]
 * @param {number} [options.maxIdle] - Pauses longer than this (ms) are shortened to it (default 500)
 * @param {number} [options.sessionGap] - Pause between sessions (ms, default 500)
 * @param {function(string):Promise<Uint8Array>} [options.fetch] - Loads referenced source files (defaults to fetch())
 * @param {function(Object)} [options.onDrift] - Called when the replay doesn't match a hash stored in the recording
 * @param {number} [options.keyframeInterval] - Take a keyframe (for seeking) after about this much replay work (ms,
 *                                              default 250; 0 for none)
 * @param {number} [options.keyframeMemory] - Bytes the keyframes may use (default 128MB). Over that, every other one is
 *                                            dropped
 * @param {boolean} [options.fuseAfterStrokes] - Update the composite after each stroke (default true)
 *
 * @constructor
 */
export default function CPRecordingPlayer(bytes, options) {
    options = options || {};

    const
        that = this,
        maxIdle = options.maxIdle === undefined ? 500 : options.maxIdle,
        sessionGap = options.sessionGap === undefined ? 500 : options.sessionGap,
        file = parseRecording(bytes);

    let
        /**
         * The replay's steps in order: step i happens at stepTimes[i]. The steps are in segments: a session start (one
         * step, with no event), or the events of one EVTS chunk, decoded only when the replay gets to them.
         */
        stepTimes = new Float64Array(0),
        stepCount = 0,
        /**
         * @type {{first: int, count: int, session: RecordingSession, payload: ?Uint8Array, inflated: ?Object, events: ?Object[]}[]}
         */
        segments = [],
        lastSegment = null,
        /**
         * The segments whose events are decoded, the most recently used last
         */
        decodedSegments = [],
        position = 0,

        brush = null,
        ids = new WeakMap(),
        layersById = new Map(),
        nextId = 1,
        currentSession = null,
        driftReported = false,

        /*
         * Keyframes: in-memory copies of the replay state (never stored in the file), taken as the replay goes, so that
         * seeking (backwards especially) restores the nearest one instead of replaying from the start. A keyframe has
         * no undo history, so it's only taken when the next operation can't merge into the last undo, and a replay
         * restored from one gives up (and goes back to an earlier keyframe) if it reaches an undo or redo of an
         * operation from before the keyframe.
         */
        keyframeInterval = options.keyframeInterval === undefined ? 250 : options.keyframeInterval,
        // Browsers pass a budget that suits the device (see ChickenPaintPlayer)
        keyframeMemory = options.keyframeMemory === undefined ? 128 * 1024 * 1024 : options.keyframeMemory,
        fuseAfterStrokes = options.fuseAfterStrokes !== false,
        keyframes = [],
        keyframeBytes = 0,
        workSinceKeyframe = 0,
        /**
         * When replaying from a keyframe: {keyframe, redoCleared}
         */
        restored = null,

        /**
         * True between a stroke's begin and end events (no keyframes there: the stroke's buffers aren't in them)
         */
        inStroke = false;

    /**
     * The document being replayed (replaced at sessions that start from a new document).
     *
     * @type {?CPArtwork}
     */
    this.artwork = null;

    /**
     * Total playback time (ms).
     *
     * @type {number}
     */
    this.duration = 0;

    /**
     * Time of the last replayed step.
     *
     * @type {number}
     */
    this.currentTime = 0;

    /**
     * Mismatches between the replay and the hashes stored in the recording.
     *
     * @type {Object[]}
     */
    this.drift = [];

    /**
     * @type {Object[]}
     */
    this.sessions = file.sessions;

    /**
     * The rotation (multiples of 90 degrees clockwise) the most recent session's image was saved with.
     *
     * @type {int}
     */
    this.rotation = 0;

    function reportDrift(info) {
        that.drift.push(info);
        if (options.onDrift && !driftReported) {
            driftReported = true;
            try {
                options.onDrift(info);
            } catch (e) {
                console.error(e);
            }
        }
    }

    /**
     * Lay out the playback timeline (events are decoded later, as the replay reaches them) and fetch any referenced
     * files. Must complete before replaying.
     *
     * @returns {Promise}
     */
    this.prepare = function() {
        let
            time = 0,
            loads = [],
            times = [];

        stepCount = 0;
        segments = [];

        file.sessions.forEach((session, sessionIndex) => {
            if (sessionIndex > 0) {
                time += sessionGap;
            }

            segments.push({first: stepCount, count: 1, session: session, payload: null, inflated: null, events: null});
            times.push(Float64Array.of(time));
            stepCount++;

            for (let payload of session.eventChunks) {
                let
                    inflated = inflateEvents(payload),
                    dts = decodeEventTimes(inflated),
                    chunkTimes = new Float64Array(dts.length);

                for (let i = 0; i < dts.length; i++) {
                    time += Math.min(dts[i], maxIdle);
                    chunkTimes[i] = time;
                }

                segments.push({first: stepCount, count: dts.length, session: session, payload: payload, inflated: inflated, events: null});
                times.push(chunkTimes);
                stepCount += dts.length;
            }

            if (session.snapshot) {
                session.bitmaps = decodeSnapshot(session.snapshot);
            } else if (session.start.kind === START_REFERENCE && session.start.sourceUrl) {
                loads.push(loadReference(session));
            }
        });

        stepTimes = new Float64Array(stepCount);
        for (let i = 0, offset = 0; i < times.length; offset += times[i].length, i++) {
            stepTimes.set(times[i], offset);
        }

        this.duration = time;

        return Promise.all(loads).then(() => this);
    };

    const
        DECODED_SEGMENTS_KEPT = 2;

    /**
     * @param {int} index - Step index
     */
    function segmentAt(index) {
        if (lastSegment && index >= lastSegment.first && index < lastSegment.first + lastSegment.count) {
            return lastSegment;
        }

        let
            low = 0, high = segments.length - 1;

        // Last segment with first <= index
        while (low < high) {
            let
                mid = (low + high + 1) >> 1;

            if (segments[mid].first <= index) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }

        lastSegment = segments[low];
        return lastSegment;
    }

    /**
     * @param {int} index - Step index
     * @returns {?Object} The step's event (null for a session start)
     */
    function eventAt(index) {
        let
            segment = segmentAt(index);

        if (!segment.payload) {
            return null;
        }

        if (!segment.events) {
            try {
                segment.events = decodeEvents(segment.payload, segment.inflated);
            } catch (e) {
                // Replay what we can (nothing, for these events), and show the saved drawing at the end
                reportDrift({session: segment.session.start.index, time: stepTimes[segment.first], at: "event", error: e});
                segment.events = new Array(segment.count).fill({op: 0, dt: 0});
            }

            decodedSegments.push(segment);
            while (decodedSegments.length > DECODED_SEGMENTS_KEPT) {
                decodedSegments.shift().events = null;
            }
        } else if (decodedSegments[decodedSegments.length - 1] !== segment) {
            decodedSegments.splice(decodedSegments.indexOf(segment), 1);
            decodedSegments.push(segment);
        }

        return segment.events[index - segment.first];
    }

    function loadReference(session) {
        let
            start = session.start,
            fetchBytes = options.fetch || (url => fetch(url, {mode: "cors", credentials: "omit"}).then(response => {
                if (!response.ok) {
                    throw new Error("HTTP " + response.status);
                }
                return response.arrayBuffer();
            }).then(buffer => new Uint8Array(buffer)));

        return fetchBytes(start.sourceUrl)
            .then(data => {
                if (start.sourceFormat === SOURCE_CHI) {
                    return chiLoad(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
                        .then(artwork => layerBitmaps(artwork));
                }

                let
                    image = decodeColorPNG(data);

                return [image.data];
            })
            .then(bitmaps => {
                session.bitmaps = bitmaps;
            }, error => {
                session.referenceError = error;
            });
    }

    // == Layer ids (as CPRecorder assigns them) =======================================================================

    function resetIds() {
        ids = new WeakMap();
        layersById = new Map();
        layersById.set(0, that.artwork.getLayersRoot());
        nextId = 1;
        assignIds();
    }

    function assignIds() {
        forEachLayer(that.artwork.getLayersRoot(), layer => {
            if (!ids.has(layer)) {
                ids.set(layer, nextId);
                layersById.set(nextId, layer);
                nextId++;
            }
        });
    }

    function layer(id) {
        let
            result = layersById.get(id);

        if (!result) {
            throw new Error("Unknown layer " + id);
        }
        return result;
    }

    // == Sessions =====================================================================================================

    function newArtwork(width, height) {
        return new CPArtwork(width, height);
    }

    function startSession(session) {
        let
            start = session.start,
            artwork = null;

        currentSession = session;

        switch (start.kind) {
            case START_BLANK:
                artwork = newArtwork(start.width, start.height);
                artwork.addBackgroundLayer();
                break;
            case START_CONTINUE:
                artwork = that.artwork;
                break;
            case START_CONTINUE_FLAT:
                if (that.artwork) {
                    let
                        fusion = that.artwork.fusionLayers(),
                        rotated = rotateRGBA(fusion.width, fusion.height, fusion.data, that.rotation),
                        layer = new CPImageLayer(0, 0, "");

                    artwork = newArtwork(rotated.width, rotated.height);
                    layer.image = colorBmpFromRGBA(rotated.width, rotated.height, rotated.data);
                    artwork.addLayerObject(artwork.getLayersRoot(), layer);
                }
                break;
            case START_REFERENCE:
            case START_SNAPSHOT:
                break;
            default:
                throw new Error("Unknown session start " + start.kind);
        }

        function matches(artwork) {
            return artwork && artwork.width === start.width && artwork.height === start.height
                && layerTableMatches(artwork, start) && hashLayers(artwork) === start.startHash;
        }

        let
            ok = matches(artwork);

        if (!ok && session.bitmaps) {
            // Start from the snapshot, or the file the editor opened
            artwork = newArtwork(start.width, start.height);
            buildLayersFromTable(artwork, start, session.bitmaps, CPGreyBmp);
            ok = matches(artwork);
        }

        if (!artwork) {
            // Nothing to start from, carry on from a blank document
            artwork = newArtwork(start.width, start.height);
            artwork.addBackgroundLayer();
        }

        if (!ok) {
            reportDrift({session: start.index, time: that.currentTime, at: "start", error: session.referenceError});
        }

        if (layerTableMatches(artwork, start)) {
            let
                layers = layerList(artwork);

            layers.forEach((layer, i) => applyLayerTableEntry(layer, start.layers[i]));
            artwork.setActiveLayer(layers[start.activeLayer] || layers[0], start.editingMask);
        }

        setArtwork(artwork);

        if (start.selection.right > start.selection.left && start.selection.bottom > start.selection.top) {
            artwork.setSelection(toCPRect(start.selection));
        } else {
            artwork.emptySelection();
        }
        artwork.clearHistory();
        // Replay as the engine that made the recording behaved
        artwork.setLegacyCutUndo((start.engine || 0) < 1);
        artwork.setClipboard(null);
        artwork.setBrushTexture(null);
        restored = null;
        inStroke = false;

        brush = new CPBrushInfo({});

        resetIds();

        if (session.end) {
            that.rotation = session.end.rotation;
        }

        if (that.onArtworkChange) {
            that.onArtworkChange(artwork);
        }
    }

    function onAddUndo() {
        if (restored) {
            // The original's redo list (from before the keyframe) is now gone too
            restored.redoCleared = true;
        }
    }

    function setArtwork(artwork) {
        if (that.artwork && that.artwork !== artwork) {
            that.artwork.off("addUndo", onAddUndo);
        }
        if (artwork && that.artwork !== artwork) {
            artwork.on("addUndo", onAddUndo);
        }
        that.artwork = artwork;
    }

    function endSession(session) {
        let
            end = session.end;

        if (!end || end.truncated) {
            // The recording stops before the end of the session, so we can't have reached the saved drawing
            reportDrift({session: session.start.index, time: that.currentTime, at: end ? "truncated" : "incomplete"});
        } else if (hashLayers(that.artwork) !== end.layersHash) {
            reportDrift({session: session.start.index, time: that.currentTime, at: "end"});
        }
    }

    // == Events =======================================================================================================

    function bitmapFor(png, grey) {
        return grey ? decodeGreyPNG(png) : decodeColorPNG(png);
    }

    function applyEvent(event) {
        let
            artwork = that.artwork;

        switch (event.op) {
            case OP.STROKE_BEGIN:
                inStroke = true;
                artwork.setBrush(brush);
                artwork.setRandomSeed(event.seed);
                if (artwork.getSampleAllLayers()) {
                    artwork.fusionLayers();
                }
                artwork.beginStroke(event.x / COORD_SCALE, event.y / COORD_SCALE, event.p / 255);
                break;
            case OP.STROKE_POINT:
                artwork.continueStroke(event.x / COORD_SCALE, event.y / COORD_SCALE, event.p / 255);
                break;
            case OP.STROKE_END:
                inStroke = false;
                artwork.endStroke();
                if (fuseAfterStrokes) {
                    /*
                     * The composite's dirty area is one rectangle, so compositing several strokes at once (several
                     * strokes per frame at high speed, or at a checkpoint) would redraw the whole box around them.
                     * Compositing after each stroke redraws far less (the composite doesn't depend on how it was
                     * redrawn).
                     */
                    artwork.fusionLayers();
                }
                break;

            case OP.TOOL:
                if (event.field === TOOL_COLOR) {
                    artwork.setForegroundColor(event.value);
                } else if (event.field === TOOL_SAMPLE_ALL_LAYERS) {
                    artwork.setSampleAllLayers(!!event.value);
                } else if (BRUSH_FIELDS[event.field]) {
                    let
                        name = BRUSH_FIELDS[event.field];

                    brush[name] = BOOLEAN_BRUSH_FIELDS.has(name) ? !!event.value : event.value;
                }
                break;
            case OP.TEXTURE:
                artwork.setBrushTexture(event.png ? decodeGreyPNG(event.png) : null);
                break;

            case OP.SELECT_LAYER:
                artwork.setActiveLayer(layer(event.layer), event.mask);
                break;
            case OP.EXPAND_GROUP:
                artwork.expandLayerGroup(layer(event.layer), event.expand);
                break;
            case OP.ADD_LAYER:
                artwork.addLayer(event.group ? "group" : "layer");
                break;
            case OP.REMOVE_LAYER:
                artwork.removeLayer();
                break;
            case OP.DUPLICATE_LAYER:
                artwork.duplicateLayer();
                break;
            case OP.MERGE_DOWN:
                artwork.mergeDown();
                break;
            case OP.MERGE_GROUP:
                artwork.mergeGroup();
                break;
            case OP.MERGE_ALL:
                artwork.mergeAllLayers();
                break;
            case OP.RELOCATE_LAYER:
                artwork.relocateLayer(layer(event.layer), layer(event.group), event.index);
                break;
            case OP.ADD_MASK:
                artwork.addLayerMask();
                break;
            case OP.REMOVE_MASK:
                artwork.removeLayerMask();
                break;
            case OP.APPLY_MASK:
                artwork.applyLayerMask();
                break;
            case OP.LAYER_VISIBLE:
                artwork.setLayerVisibility(layer(event.layer), event.value);
                break;
            case OP.LAYER_ALPHA:
                artwork.setLayerAlpha(event.value);
                break;
            case OP.LAYER_BLEND:
                artwork.setLayerBlendMode(event.value);
                break;
            case OP.LAYER_NAME:
                artwork.setLayerName(layer(event.layer), event.name);
                break;
            case OP.MASK_LINKED:
                artwork.setLayerMaskLinked(event.value);
                break;
            case OP.MASK_VISIBLE:
                artwork.setLayerMaskVisible(layer(event.layer), event.value);
                break;
            case OP.CLIP_CREATE:
                artwork.createClippingMask();
                break;
            case OP.CLIP_RELEASE:
                artwork.releaseClippingMask();
                break;
            case OP.LOCK_ALPHA:
                artwork.setLayerLockAlpha(event.value);
                break;

            case OP.RECT_SELECTION:
                artwork.rectangleSelection(toCPRect(event.rect));
                break;
            case OP.SET_SELECTION:
                artwork.setSelection(toCPRect(event.rect));
                break;
            case OP.MOVE:
                artwork.move(event.dx, event.dy, event.copy);
                break;
            case OP.CUT:
                artwork.cutSelection();
                break;
            case OP.COPY:
                artwork.copySelection();
                break;
            case OP.COPY_MERGED:
                artwork.copySelectionMerged();
                break;
            case OP.PASTE:
                if (event.png) {
                    artwork.setClipboard(new CPClip(bitmapFor(event.png, event.grey), event.x, event.y));
                }
                artwork.pasteClipboard();
                break;
            case OP.TRANSFORM:
                artwork.applyRecordedChange(
                    event.changes.map(change => ({
                        layer: layer(change.layer),
                        rect: toCPRect(change.rect),
                        image: change.image ? decodeColorPNG(change.image) : null,
                        mask: change.mask ? decodeGreyPNG(change.mask) : null
                    })),
                    toCPRect(event.selection),
                    layer(event.layer),
                    event.mask
                );
                break;

            case OP.FILL:
                artwork.fill(event.color | 0);
                break;
            case OP.CLEAR:
                artwork.clear();
                break;
            case OP.FLOOD_FILL:
                artwork.floodFill(event.x, event.y);
                break;
            case OP.GRADIENT_FILL:
                artwork.gradientFill(event.fromX, event.fromY, event.toX, event.toY, event.colors.map(color => color | 0));
                break;
            case OP.FLIP_H:
                artwork.hFlip();
                break;
            case OP.FLIP_V:
                artwork.vFlip();
                break;
            case OP.NOISE_MONO:
                artwork.setRandomSeed(event.seed);
                artwork.monochromaticNoise();
                break;
            case OP.NOISE_COLOR:
                artwork.setRandomSeed(event.seed);
                artwork.colorNoise();
                break;
            case OP.INVERT:
                artwork.invert();
                break;
            case OP.BOX_BLUR:
                artwork.boxBlur(event.radiusX, event.radiusY, event.iterations);
                break;

            case OP.UNDO:
                artwork.undo();
                break;
            case OP.REDO:
                artwork.redo();
                break;
            case OP.CLEAR_HISTORY:
                artwork.clearHistory();
                break;

            case OP.CHECKPOINT:
                if (hashComposite(artwork) !== event.hash) {
                    reportDrift({session: currentSession.start.index, time: that.currentTime, at: "checkpoint"});
                }
                break;
        }

        assignIds();
    }

    // == Keyframes ====================================================================================================

    const
        KEYFRAME_BAND_BYTES = 64 * 1024,
        RUN_FLAG = 0x80000000;

    /*
     * Keyframe bitmaps are kept in bands of KEYFRAME_BAND_BYTES, each run-length encoded as 32-bit words (layers are
     * mostly runs of transparent or of one color): a token word with RUN_FLAG set is a run of (token & ~RUN_FLAG)
     * copies of the next word, otherwise it's followed by that many literal words. A band that hasn't changed since the
     * previous keyframe is shared with it.
     */
    function encodeBand(words) {
        let
            out = new Uint32Array(words.length + 2),
            o = 0,
            literalStart = 0,
            i = 0,
            n = words.length;

        function flushLiterals(end) {
            if (end > literalStart) {
                out[o++] = end - literalStart;
                for (let j = literalStart; j < end; j++) {
                    out[o++] = words[j];
                }
            }
        }

        while (i < n) {
            let
                value = words[i],
                runEnd = i + 1;

            while (runEnd < n && words[runEnd] === value) {
                runEnd++;
            }
            if (runEnd - i >= 3) {
                flushLiterals(i);
                out[o++] = (RUN_FLAG | (runEnd - i)) >>> 0;
                out[o++] = value;
                literalStart = runEnd;
            }
            i = runEnd;
        }
        flushLiterals(n);

        return out.slice(0, o);
    }

    function decodeBand(encoded, dest, destIndex) {
        for (let i = 0; i < encoded.length;) {
            let
                token = encoded[i++];

            if (token & RUN_FLAG) {
                let
                    count = token & ~RUN_FLAG;

                dest.fill(encoded[i++], destIndex, destIndex + count);
                destIndex += count;
            } else {
                dest.set(encoded.subarray(i, i + token), destIndex);
                i += token;
                destIndex += token;
            }
        }
        return destIndex;
    }

    function bandEquals(encoded, words) {
        let
            w = 0;

        for (let i = 0; i < encoded.length;) {
            let
                token = encoded[i++];

            if (token & RUN_FLAG) {
                let
                    end = w + (token & ~RUN_FLAG),
                    value = encoded[i++];

                if (end > words.length) {
                    return false;
                }
                for (; w < end; w++) {
                    if (words[w] !== value) {
                        return false;
                    }
                }
            } else {
                if (w + token > words.length) {
                    return false;
                }
                for (let end = i + token; i < end; i++, w++) {
                    if (words[w] !== encoded[i]) {
                        return false;
                    }
                }
            }
        }
        return w === words.length;
    }

    /**
     * @returns {{length: int, bands: Uint32Array[]}}
     */
    function keepBitmap(data, previous, keyframe) {
        let
            // Greyscale masks may not be a multiple of 4 bytes long, so pad a copy of the tail
            padded = data.length % 4 === 0 && data.byteOffset % 4 === 0 ? data : (() => {
                let
                    copy = new Uint8Array((data.length + 3) & ~3);

                copy.set(data);
                return copy;
            })(),
            words = new Uint32Array(padded.buffer, padded.byteOffset, padded.length >> 2),
            bandWords = KEYFRAME_BAND_BYTES >> 2,
            bands = [];

        for (let offset = 0, i = 0; offset < words.length; offset += bandWords, i++) {
            let
                band = words.subarray(offset, Math.min(words.length, offset + bandWords));

            if (previous && previous.length === data.length && previous.bands[i] && bandEquals(previous.bands[i], band)) {
                bands.push(previous.bands[i]);
            } else {
                let
                    encoded = encodeBand(band);

                bands.push(encoded);
                keyframe.bytes += encoded.byteLength;
            }
        }
        return {length: data.length, bands: bands};
    }

    function joinBands(bitmap) {
        let
            words = new Uint32Array((bitmap.length + 3) >> 2),
            offset = 0;

        for (let band of bitmap.bands) {
            offset = decodeBand(band, words, offset);
        }
        return new Uint8Array(words.buffer, 0, bitmap.length);
    }

    function canTakeKeyframe() {
        let
            artwork = that.artwork;

        return artwork && currentSession && !inStroke && position < stepCount && segmentAt(position).payload
            && !artwork.getHistoryInfo().topMergeable;
    }

    function takeKeyframe() {
        let
            artwork = that.artwork,
            previous = keyframes.length > 0 ? keyframes[keyframes.length - 1] : null,
            layers = layerList(artwork),
            history = artwork.getHistoryInfo(),
            keyframe = {
                position: position,
                time: that.currentTime,
                session: currentSession,
                width: artwork.width,
                height: artwork.height,
                table: getLayerTable(artwork),
                rootChildren: artwork.getLayersRoot().layers.length,
                bitmaps: [],
                layerBitmaps: new Map(),
                ids: layers.map(layer => ids.get(layer)),
                nextId: nextId,
                activeLayer: layers.indexOf(artwork.getActiveLayer()),
                editingMask: artwork.isEditingMask(),
                selection: artwork.getSelection(),
                clipboard: artwork.getClipboard(),
                texture: artwork.getBrushTexture(),
                color: artwork.getForegroundColor(),
                sampleAllLayers: artwork.getSampleAllLayers(),
                brush: brush.clone(),
                rotation: that.rotation,
                drift: that.drift.slice(),
                driftReported: driftReported,
                undoDepth: history.undoDepth,
                redoDepth: history.redoDepth,
                // The first step that can't be replayed from this keyframe (found out when it's tried)
                validBefore: Infinity,
                bytes: 0
            };

        for (let layer of layers) {
            let
                // By layer id, so that keyframes don't keep the replaced documents' layers alive
                old = previous && previous.session === currentSession && previous.layerBitmaps.get(ids.get(layer)),
                kept = {};

            if (!(layer instanceof CPLayerGroup)) {
                kept.image = keepBitmap(layer.image.data, old && old.image, keyframe);
                keyframe.bitmaps.push(kept.image);
            }
            if (layer.mask) {
                kept.mask = keepBitmap(layer.mask.data, old && old.mask, keyframe);
                keyframe.bitmaps.push(kept.mask);
            }
            keyframe.layerBitmaps.set(ids.get(layer), kept);
        }

        keyframes.push(keyframe);
        keyframeBytes += keyframe.bytes;

        // Over budget: drop every other keyframe (keeping the first and the newest), so that they stay evenly spread,
        // and take them half as often from now on
        while (keyframeBytes > keyframeMemory && keyframes.length > 2) {
            keyframes = keyframes.filter((k, i) => i % 2 === 0 || i === keyframes.length - 1);
            keyframeBytes = countKeyframeBytes();
            keyframeInterval *= 2;
        }

        // Even two don't fit (a big drawing on a small budget): keep just the newest, or none if it doesn't fit either,
        // in which case stop taking them (seeking backwards replays from the start, as without keyframes)
        if (keyframeBytes > keyframeMemory && keyframes.length > 1) {
            keyframes = keyframes.slice(-1);
            keyframeBytes = countKeyframeBytes();
        }
        if (keyframeBytes > keyframeMemory) {
            keyframes = [];
            keyframeBytes = 0;
            keyframeInterval = Infinity;
        }
    }

    /**
     * Memory used by the keyframes (bands shared between keyframes count once).
     */
    function countKeyframeBytes() {
        let
            seen = new Set(),
            total = 0;

        for (let keyframe of keyframes) {
            for (let bitmap of keyframe.bitmaps) {
                for (let band of bitmap.bands) {
                    if (!seen.has(band)) {
                        seen.add(band);
                        total += band.byteLength;
                    }
                }
            }
        }
        return total;
    }

    function restoreKeyframe(keyframe) {
        let
            artwork = new CPArtwork(keyframe.width, keyframe.height);

        buildLayersFromTable(artwork, {layers: keyframe.table, rootChildren: keyframe.rootChildren}, keyframe.bitmaps.map(joinBands), CPGreyBmp);

        let
            layers = layerList(artwork);

        artwork.setActiveLayer(layers[keyframe.activeLayer] || layers[0], keyframe.editingMask);
        artwork.setSelection(keyframe.selection);
        artwork.setClipboard(keyframe.clipboard);
        artwork.setBrushTexture(keyframe.texture);
        artwork.setForegroundColor(keyframe.color);
        artwork.setSampleAllLayers(keyframe.sampleAllLayers);
        artwork.clearHistory();
        artwork.setLegacyCutUndo((keyframe.session.start.engine || 0) < 1);

        brush = keyframe.brush.clone();

        ids = new WeakMap();
        layersById = new Map();
        layersById.set(0, artwork.getLayersRoot());
        layers.forEach((layer, i) => {
            ids.set(layer, keyframe.ids[i]);
            layersById.set(keyframe.ids[i], layer);
        });
        nextId = keyframe.nextId;

        position = keyframe.position;
        currentSession = keyframe.session;
        that.currentTime = keyframe.time;
        that.rotation = keyframe.rotation;
        that.drift = keyframe.drift.slice();
        driftReported = keyframe.driftReported;
        workSinceKeyframe = 0;

        setArtwork(artwork);
        restored = {keyframe: keyframe, redoCleared: false};
        inStroke = false;

        if (that.onArtworkChange) {
            that.onArtworkChange(artwork);
        }
    }

    /**
     * When replaying from a keyframe, check that the event doesn't need the history from before the keyframe.
     */
    function keyframeCanReplay(event) {
        let
            artwork = that.artwork,
            keyframe = restored.keyframe;

        switch (event.op) {
            case OP.UNDO:
                return artwork.isUndoAllowed() || keyframe.undoDepth === 0;
            case OP.REDO:
                return artwork.isRedoAllowed() || keyframe.redoDepth === 0 || restored.redoCleared;
            case OP.CLEAR_HISTORY:
                restored = null;
                return true;
        }
        return true;
    }

    /**
     * @param {int} target - Index of the step to reach
     * @returns {?Object} The latest keyframe that can be replayed up to the target
     */
    function keyframeFor(target) {
        for (let i = keyframes.length - 1; i >= 0; i--) {
            let
                keyframe = keyframes[i];

            if (keyframe.position <= target && keyframe.validBefore >= target) {
                return keyframe;
            }
        }
        return null;
    }

    function stepIndexAfter(time) {
        let
            low = 0, high = stepCount;

        // First step with stepTimes[step] > time
        while (low < high) {
            let
                mid = (low + high) >> 1;

            if (stepTimes[mid] <= time) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low;
    }

    let
        seekTarget = 0;

    /**
     * Go to the given time, from the nearest keyframe before it if that's quicker than replaying from where we are
     * (and from the start if we have to go backwards and there's no keyframe). Call advanceTo(time) afterwards to
     * finish the replay up to the time.
     *
     * @param {number} time
     */
    this.seek = function(time) {
        let
            target = stepIndexAfter(time),
            keyframe = keyframeFor(target);

        seekTarget = target;

        if (keyframe && (target < position || keyframe.position > position)) {
            restoreKeyframe(keyframe);
        } else if (target < position) {
            this.reset();
        }
    };

    /**
     * @returns {{count: int, bytes: int}} The keyframes held in memory
     */
    this.getKeyframeStats = function() {
        return {count: keyframes.length, bytes: keyframeBytes};
    };

    function retryFromEarlierKeyframe() {
        let
            target = Math.max(seekTarget, position + 1),
            keyframe;

        restored.keyframe.validBefore = position;
        keyframe = keyframeFor(target);
        if (keyframe) {
            restoreKeyframe(keyframe);
        } else {
            that.reset();
        }
    }

    function applyStep(index) {
        let
            event = eventAt(index);

        that.currentTime = stepTimes[index];

        if (!event) {
            let
                session = segmentAt(index).session;

            if (currentSession && currentSession !== session) {
                endSession(currentSession);
            }
            startSession(session);
        } else {
            if (restored && !keyframeCanReplay(event)) {
                retryFromEarlierKeyframe();
                return;
            }
            try {
                applyEvent(event);
            } catch (e) {
                reportDrift({session: currentSession.start.index, time: that.currentTime, at: "event", error: e});
            }
        }

        position++;

        if (position === stepCount && currentSession) {
            endSession(currentSession);
        }
    }

    /**
     * Replay all the steps up to the given playback time.
     *
     * @param {number} time
     * @param {number} [budget] - Stop after this many milliseconds of work (to keep the page responsive)
     * @returns {boolean} True if the replay reached the requested time
     */
    this.advanceTo = function(time, budget) {
        let
            deadline = budget === undefined || budget === Infinity ? Infinity : Date.now() + budget;

        while (position < stepCount && stepTimes[position] <= time) {
            let
                started = keyframeInterval > 0 ? performance.now() : 0;

            applyStep(position);

            if (keyframeInterval > 0) {
                workSinceKeyframe += performance.now() - started;
                if (workSinceKeyframe >= keyframeInterval && canTakeKeyframe()
                        && !(keyframes.length && keyframes[keyframes.length - 1].position >= position)) {
                    workSinceKeyframe = 0;
                    takeKeyframe();
                }
            }

            if (Date.now() > deadline) {
                return position >= stepCount || stepTimes[position] > time;
            }
        }
        return true;
    };

    /**
     * Replay everything.
     */
    this.finish = function() {
        this.advanceTo(Infinity);
    };

    /**
     * @returns {boolean} True when every step has been replayed
     */
    this.isDone = function() {
        return position >= stepCount;
    };

    /**
     * Restart from the beginning (to seek backwards).
     */
    this.reset = function() {
        position = 0;
        currentSession = null;
        restored = null;
        inStroke = false;
        workSinceKeyframe = 0;
        setArtwork(null);
        this.currentTime = 0;
        this.drift = [];
        driftReported = false;
    };

    /**
     * The width and height of the image the final session saved (rotated).
     *
     * @returns {{width: int, height: int, rotation: int}}
     */
    this.getFinalSize = function() {
        let
            last = file.sessions[file.sessions.length - 1],
            end = last && last.end,
            width = end ? end.width : last ? last.start.width : 0,
            height = end ? end.height : last ? last.start.height : 0,
            rotation = end ? end.rotation : 0;

        return rotation % 2 ? {width: height, height: width, rotation} : {width, height, rotation};
    };
}
