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


import CPPlaybackLoop, {clamp, clampSpeed} from "./player/CPPlaybackLoop.js";
import CPPlaybackWorkerClient from "./player/CPPlaybackWorkerClient.js";

/**
 * The URL of this script, while it's being run (to find the worker script next to it).
 */
const
    PLAYER_SCRIPT_URL = typeof document !== "undefined" && document.currentScript && document.currentScript.src || "";

/**
 * How much memory the replay's keyframes (copies of the drawing kept for seeking) may use on this device.
 *
 * Keyframes come on top of the drawing itself (a 1200x1200 drawing with 10 layers is ~60MB plus composite and undo
 * buffers), and phone browsers close tabs that use much more than a few hundred MB, so phones get a small budget. Over
 * budget the player keeps fewer, evenly spread keyframes (seeking replays a little more), so a small budget costs
 * seek speed, never correctness.
 *
 * @returns {number} bytes
 */
function defaultKeyframeMemory() {
    const
        MB = 1024 * 1024;

    let
        budget = 128 * MB,
        nav = typeof navigator !== "undefined" ? navigator : {};

    // Chromium tells us the RAM (GB, rounded down to a power of two, at most 8): 16MB per GB, so 32MB on a 2GB phone,
    // 64MB with 4GB and 128MB with 8GB or more
    if (nav.deviceMemory > 0) {
        budget = clamp(nav.deviceMemory * 16 * MB, 16 * MB, 128 * MB);
    }

    // Safari and Firefox don't, so go by the screen: phones (touch, and a short side under 600 CSS px) get 32MB,
    // tablets 64MB
    if (typeof matchMedia === "function" && typeof screen !== "undefined" && matchMedia("(pointer: coarse)").matches) {
        budget = Math.min(budget, Math.min(screen.width, screen.height) < 600 ? 32 * MB : 64 * MB);
    }

    return budget;
}


/**
 * The worker script next to this one: chickenpaint-player(.min).js -> chickenpaint-player-worker(.min).js (with the same
 * query string).
 *
 * @returns {?string}
 */
function defaultWorkerUrl() {
    let
        match = /^(.*\/chickenpaint-player)((?:\.min)?\.js)(\?[^#]*)?(#.*)?$/.exec(PLAYER_SCRIPT_URL);

    return match ? match[1] + "-worker" + match[2] + (match[3] || "") : null;
}

/**
 * True if the browser can replay in a worker onto the page's canvas (not Safari before 16.4, for one).
 */
function supportsWorkerPlayback() {
    try {
        return typeof Worker === "function" && typeof OffscreenCanvas === "function"
            && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function"
            && !!new OffscreenCanvas(1, 1).getContext("2d");
    } catch (e) {
        return false;
    }
}

/**
 * Plays back a drawing recording made by ChickenPaint (with the recordDrawing option) as a timelapse, by replaying it
 * through the painting engine. See docs/recording-format.md.
 *
 * @param {Object} options
 * @param {HTMLElement} options.domRoot - Element to put the player in
 * @param {string} [options.url] - URL of the recording
 * @param {Uint8Array|ArrayBuffer} [options.recording] - The recording itself (instead of url)
 * @param {string} [options.finalImageUrl] - The finished drawing. Shown at the end of playback if the replay didn't
 *                                           reproduce it exactly (e.g. the recording was cut short).
 * @param {int} [options.width] - Size of the player box for fit "box" (defaults to the drawing's size)
 * @param {int} [options.height]
 * @param {"box"|"contain"} [options.fit] - "box" sizes the player to width x height, "contain" fills domRoot
 * @param {boolean} [options.autoplay]
 * @param {number} [options.speed] - Playback rate multiplier (default 1)
 * @param {boolean} [options.controls] - Show a play button and a seek bar
 * @param {number} [options.maxIdle] - Pauses in the recording longer than this many ms are shortened (default 500)
 * @param {function(Object)} [options.onTimeUpdate] - Called with {currentTime, duration, isPlaying, progress, seeking}
 * @param {function(Error)} [options.onError]
 * @param {function()} [options.onEnd]
 * @param {function(Object)} [options.onDrift] - Called (once) if the replay doesn't match the recorded drawing
 * @param {number} [options.keyframeMemory] - Memory for seeking keyframes (bytes, default: by device, see
 *                                            defaultKeyframeMemory())
 * @param {boolean} [options.worker] - Replay in a worker where the browser can (default true): the page stays responsive
 *                                     however much replaying there is to do
 * @param {string} [options.workerUrl] - URL of chickenpaint-player-worker.min.js (default: next to this script)
 *
 * @property {Promise} ready - Resolves when the recording is loaded
 * @property {number} duration - Playback length in ms
 * @property {number} currentTime - Position in ms
 * @property {boolean} isPlaying
 * @property {boolean} seeking - A seek is on its way to its target. Meanwhile the canvas keeps showing the frame from
 *                               before it (double buffering); onTimeUpdate reports when it lands.
 *
 * @constructor
 */
export default function ChickenPaintPlayer(options) {
    if (!(this instanceof ChickenPaintPlayer)) {
        return new ChickenPaintPlayer(options);
    }

    options = options || {};

    const
        that = this,
        root = options.domRoot,
        container = document.createElement("div"),
        stage = document.createElement("div");

    let
        canvas = null,
        /**
         * The canvas's size in pixels (it may belong to a worker, which can't tell us otherwise)
         */
        canvasWidth = 0,
        canvasHeight = 0,
        /**
         * The CPPlaybackLoop, or the CPPlaybackWorkerClient running one in a worker
         */
        engine = null,
        speed = clampSpeed(options.speed),
        /**
         * Commands given before the recording is loaded
         */
        pendingPlay = false,
        pendingSeek = null,
        destroyed = false,
        controls = null,
        finalImage = null,
        resizeObserver = null;

    if (!root) {
        throw new Error("ChickenPaintPlayer: domRoot is required");
    }

    container.className = "chickenpaint-player";
    container.style.cssText = "position:relative;overflow:hidden;width:100%;height:100%;";
    if (options.fit === "box" && options.width && options.height) {
        container.style.width = options.width + "px";
        container.style.height = options.height + "px";
    }
    stage.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0;";
    newCanvas();
    container.appendChild(stage);

    if (options.controls) {
        buildControls();
    }

    root.appendChild(container);

    if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(layout);
        resizeObserver.observe(container);
    }

    Object.defineProperties(this, {
        duration: {get: () => engine ? engine.duration : 0},
        currentTime: {get: () => engine ? engine.currentTime : pendingSeek || 0},
        isPlaying: {get: () => engine ? engine.isPlaying : pendingPlay},
        seeking: {get: () => engine ? engine.seeking : pendingSeek !== null}
    });

    /**
     * Put a new canvas on the stage (replacing the old one, if any).
     */
    function newCanvas() {
        let
            replacement = document.createElement("canvas");

        replacement.style.cssText = "position:absolute;display:block;";
        if (canvas) {
            stage.replaceChild(replacement, canvas);
        } else {
            stage.appendChild(replacement);
        }
        canvas = replacement;
    }

    function emitTime(info) {
        updateControls(info);
        if (options.onTimeUpdate) {
            options.onTimeUpdate(info);
        }
    }

    function onCanvasSize(width, height) {
        canvasWidth = width;
        canvasHeight = height;
        layout();
    }

    function layout() {
        if (!canvasWidth || !canvasHeight) {
            return;
        }

        let
            boxWidth = stage.clientWidth || canvasWidth,
            boxHeight = stage.clientHeight || canvasHeight,
            scale = Math.min(boxWidth / canvasWidth, boxHeight / canvasHeight);

        if (!isFinite(scale) || scale <= 0) {
            scale = 1;
        }

        let
            cssWidth = canvasWidth * scale,
            cssHeight = canvasHeight * scale;

        for (let element of [canvas, finalImage]) {
            if (element) {
                element.style.width = cssWidth + "px";
                element.style.height = cssHeight + "px";
                element.style.left = (boxWidth - cssWidth) / 2 + "px";
                element.style.top = (boxHeight - cssHeight) / 2 + "px";
            }
        }
        canvas.style.imageRendering = scale >= 1 ? "pixelated" : "auto";
    }

    function showFinalImage(show) {
        if (show && !finalImage && options.finalImageUrl) {
            finalImage = document.createElement("img");
            finalImage.alt = "";
            finalImage.style.cssText = "position:absolute;display:block;";
            finalImage.src = options.finalImageUrl;
            stage.appendChild(finalImage);
            layout();
        }
        if (finalImage) {
            finalImage.style.visibility = show ? "visible" : "hidden";
        }
    }

    function engineOptions() {
        return {
            speed: speed,
            maxIdle: options.maxIdle,
            keyframeMemory: options.keyframeMemory === undefined ? defaultKeyframeMemory() : options.keyframeMemory,
            baseUrl: typeof document !== "undefined" ? document.baseURI : undefined,
            onTimeUpdate: emitTime,
            onEnd: () => {
                if (options.onEnd) {
                    options.onEnd();
                }
            },
            onDrift: drift => {
                if (options.onDrift) {
                    options.onDrift(drift);
                }
            },
            onCanvasSize: onCanvasSize,
            onFinalImage: showFinalImage,
            onError: error => {
                if (options.onError) {
                    options.onError(error);
                } else {
                    console.error(error);
                }
            }
        };
    }

    function startOnPage(bytes) {
        engine = new CPPlaybackLoop(canvas, engineOptions());
        return engine.load(bytes);
    }

    function start(bytes) {
        let
            workerUrl = options.workerUrl || defaultWorkerUrl();

        if (options.worker === false || !workerUrl || !supportsWorkerPlayback()) {
            return startOnPage(bytes);
        }

        let
            client = new CPPlaybackWorkerClient(canvas, workerUrl, engineOptions());

        engine = client;

        return client.load(bytes).catch(error => {
            client.destroy();
            if (!error.workerUnsupported || destroyed) {
                throw error;
            }
            // The canvas is the worker's now, so replay on the page onto a new one
            console.warn(error.message + ", replaying on the page instead");
            newCanvas();
            return startOnPage(bytes);
        });
    }

    this.play = function() {
        if (destroyed) {
            return;
        }
        if (engine) {
            engine.play();
        } else {
            pendingPlay = true;
        }
    };

    this.pause = function() {
        if (engine) {
            engine.pause();
        } else {
            pendingPlay = false;
        }
    };

    /**
     * @param {number} ms
     */
    this.seek = function(ms) {
        if (destroyed) {
            return;
        }
        if (engine) {
            engine.seek(ms);
        } else {
            pendingSeek = Math.max(0, Number(ms) || 0);
        }
    };

    /**
     * @param {number} multiplier - Playback rate
     */
    this.setSpeed = function(multiplier) {
        speed = clampSpeed(multiplier);
        if (engine) {
            engine.setSpeed(speed);
        }
    };

    this.destroy = function() {
        destroyed = true;
        if (engine) {
            engine.destroy();
        }
        if (resizeObserver) {
            resizeObserver.disconnect();
        }
        container.remove();
    };

    function buildControls() {
        let
            bar = document.createElement("div"),
            button = document.createElement("button"),
            range = document.createElement("input");

        bar.style.cssText = "position:absolute;left:0;right:0;bottom:0;height:28px;display:flex;align-items:center;gap:6px;padding:0 6px;background:rgba(240,240,240,0.95);font:12px sans-serif;box-sizing:border-box;";
        stage.style.bottom = "28px";

        button.type = "button";
        button.style.cssText = "min-width:56px;";
        button.onclick = () => that.isPlaying ? that.pause() : that.play();

        range.type = "range";
        range.min = "0";
        range.max = "1000";
        range.value = "0";
        range.style.cssText = "flex:1;min-width:0;";
        range.oninput = () => that.seek(Number(range.value) / 1000 * that.duration);

        bar.appendChild(button);
        bar.appendChild(range);
        container.appendChild(bar);

        controls = {button, range};
        updateControls(null);
    }

    function updateControls(info) {
        if (!controls) {
            return;
        }

        let
            playing = info ? info.isPlaying : that.isPlaying;

        controls.button.textContent = playing ? "Pause" : "Play";
        if (document.activeElement !== controls.range) {
            let
                duration = info ? info.duration : that.duration,
                time = info ? info.currentTime : that.currentTime;

            controls.range.value = String(duration ? Math.round(time / duration * 1000) : 0);
        }
    }

    function load() {
        if (options.recording) {
            let
                bytes = options.recording instanceof Uint8Array ? options.recording : new Uint8Array(options.recording);

            return Promise.resolve(bytes);
        }

        return fetch(options.url, {mode: "cors", credentials: "omit"}).then(response => {
            if (!response.ok) {
                throw new Error("Failed to load the recording (HTTP " + response.status + ")");
            }
            return response.arrayBuffer();
        }).then(buffer => new Uint8Array(buffer));
    }

    this.ready = load().then(start).then(() => {
        if (destroyed) {
            return;
        }
        if (pendingSeek !== null) {
            engine.seek(pendingSeek);
        }
        if (options.autoplay || pendingPlay) {
            that.play();
        }
    });

    this.ready.catch(error => {
        if (options.onError) {
            options.onError(error instanceof Error ? error : new Error(String(error)));
        } else {
            console.error(error);
        }
    });
}

// For hosts that want to know (the module has only a default export, so that the browserify bundle is the function)
ChickenPaintPlayer.defaultKeyframeMemory = defaultKeyframeMemory;
