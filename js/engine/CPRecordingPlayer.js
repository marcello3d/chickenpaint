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
import {load as chiLoad} from "./CPChibiFile.js";
import CPRect from "../util/CPRect.js";
import {decodePNG} from "../util/CPPNG.js";
import {
    OP, TOOL_COLOR, TOOL_SAMPLE_ALL_LAYERS, BRUSH_FIELDS, COORD_SCALE,
    START_BLANK, START_CONTINUE, START_CONTINUE_FLAT, START_REFERENCE, START_SNAPSHOT, SOURCE_CHI,
    ENGINE_REVISION,
    parseRecording, decodeEvents, decodeSnapshot, layerBitmaps, buildLayersFromTable, applyLayerTableEntry,
    layerTableMatches, layerList, forEachLayer, hashLayers, hashComposite, rotateRGBA
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
         * Every step of the replay in order: {time, session, event} (event null for a session start)
         */
        steps = [],
        position = 0,

        brush = null,
        ids = new WeakMap(),
        layersById = new Map(),
        nextId = 1,
        currentSession = null,
        driftReported = false;

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
     * Decode the events and fetch any referenced files. Must complete before replaying.
     *
     * @returns {Promise}
     */
    this.prepare = function() {
        let
            time = 0,
            loads = [];

        file.sessions.forEach((session, sessionIndex) => {
            if (sessionIndex > 0) {
                time += sessionGap;
            }

            steps.push({time: time, session: session, event: null});

            for (let payload of session.eventChunks) {
                for (let event of decodeEvents(payload)) {
                    time += Math.min(event.dt, maxIdle);
                    steps.push({time: time, session: session, event: event});
                }
            }

            if (session.snapshot) {
                session.bitmaps = decodeSnapshot(session.snapshot);
            } else if (session.start.kind === START_REFERENCE && session.start.sourceUrl) {
                loads.push(loadReference(session));
            }
        });

        this.duration = time;

        return Promise.all(loads).then(() => this);
    };

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

        that.artwork = artwork;

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

        brush = new CPBrushInfo({});

        resetIds();

        if (session.end) {
            that.rotation = session.end.rotation;
        }

        if (that.onArtworkChange) {
            that.onArtworkChange(artwork);
        }
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
                artwork.endStroke();
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

    function applyStep(step) {
        that.currentTime = step.time;

        if (!step.event) {
            if (currentSession && currentSession !== step.session) {
                endSession(currentSession);
            }
            startSession(step.session);
        } else {
            try {
                applyEvent(step.event);
            } catch (e) {
                reportDrift({session: currentSession.start.index, time: step.time, at: "event", error: e});
            }
        }

        position++;

        if (position === steps.length && currentSession) {
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

        while (position < steps.length && steps[position].time <= time) {
            applyStep(steps[position]);

            if (Date.now() > deadline) {
                return position >= steps.length || steps[position].time > time;
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
        return position >= steps.length;
    };

    /**
     * Restart from the beginning (to seek backwards).
     */
    this.reset = function() {
        position = 0;
        currentSession = null;
        this.artwork = null;
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
