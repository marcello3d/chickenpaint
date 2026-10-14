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

import CPRecordingPlayer from "./engine/CPRecordingPlayer.js";
import CPRect from "./util/CPRect.js";

const
    FRAME_BUDGET_MS = 12,
    MIN_SPEED = 0.25,
    MAX_SPEED = 256;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

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
 * @param {function(Object)} [options.onTimeUpdate] - Called with {currentTime, duration, isPlaying, progress}
 * @param {function(Error)} [options.onError]
 * @param {function()} [options.onEnd]
 * @param {function(Object)} [options.onDrift] - Called (once) if the replay doesn't match the recorded drawing
 * @param {number} [options.keyframeMemory] - Memory for seeking keyframes (bytes, default: by device, see
 *                                            defaultKeyframeMemory())
 *
 * @property {Promise} ready - Resolves when the recording is loaded
 * @property {number} duration - Playback length in ms
 * @property {number} currentTime - Position in ms
 * @property {boolean} isPlaying
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
        stage = document.createElement("div"),
        canvas = document.createElement("canvas"),
        context = canvas.getContext("2d"),
        surface = document.createElement("canvas"),
        surfaceContext = surface.getContext("2d"),
        dirty = new CPRect(0, 0, 0, 0);

    let
        player = null,
        speed = clamp(Number(options.speed) || 1, MIN_SPEED, MAX_SPEED),
        time = 0,
        playing = false,
        caughtUp = true,
        destroyed = false,
        raf = 0,
        lastTick = 0,
        artwork = null,
        rotation = -1,
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
    canvas.style.cssText = "position:absolute;display:block;";
    stage.appendChild(canvas);
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
        duration: {get: () => player ? player.duration : 0},
        currentTime: {get: () => time},
        isPlaying: {get: () => playing}
    });

    function emitTime() {
        updateControls();
        if (options.onTimeUpdate) {
            let
                duration = that.duration;

            options.onTimeUpdate({
                currentTime: time,
                duration: duration,
                isPlaying: playing,
                progress: duration ? time / duration : 0
            });
        }
    }

    function onUpdateRegion(region) {
        dirty.union(region);
    }

    function onArtworkChange(newArtwork) {
        if (artwork) {
            artwork.off("updateRegion", onUpdateRegion);
        }
        artwork = newArtwork;
        artwork.on("updateRegion", onUpdateRegion);
        dirty.set(artwork.getBounds());
    }

    function layout() {
        if (!canvas.width) {
            return;
        }

        let
            boxWidth = stage.clientWidth || canvas.width,
            boxHeight = stage.clientHeight || canvas.height,
            scale = Math.min(boxWidth / canvas.width, boxHeight / canvas.height);

        if (!isFinite(scale) || scale <= 0) {
            scale = 1;
        }

        let
            cssWidth = canvas.width * scale,
            cssHeight = canvas.height * scale;

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

    function render() {
        if (!artwork) {
            return;
        }

        let
            rotationChanged = player.rotation !== rotation || surface.width !== artwork.width || surface.height !== artwork.height;

        if (rotationChanged) {
            rotation = player.rotation;
            surface.width = artwork.width;
            surface.height = artwork.height;
            canvas.width = rotation % 2 ? artwork.height : artwork.width;
            canvas.height = rotation % 2 ? artwork.width : artwork.height;
            dirty.set(artwork.getBounds());
            layout();
        }

        dirty.clipTo(artwork.getBounds());
        if (dirty.isEmpty()) {
            return;
        }

        let
            fusion = artwork.fusionLayers();

        surfaceContext.putImageData(fusion.imageData, 0, 0, dirty.left, dirty.top, dirty.getWidth(), dirty.getHeight());
        dirty.makeEmpty();

        context.save();
        context.clearRect(0, 0, canvas.width, canvas.height);
        switch (rotation) {
            case 1:
                context.setTransform(0, 1, -1, 0, canvas.width, 0);
                break;
            case 2:
                context.setTransform(-1, 0, 0, -1, canvas.width, canvas.height);
                break;
            case 3:
                context.setTransform(0, -1, 1, 0, 0, canvas.height);
                break;
        }
        context.imageSmoothingEnabled = false;
        context.drawImage(surface, 0, 0);
        context.restore();
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

    function advance(budget) {
        if (player) {
            caughtUp = player.advanceTo(time, budget === undefined ? FRAME_BUDGET_MS : budget);
        }
    }

    function finished() {
        return player && caughtUp && time >= player.duration && player.isDone();
    }

    function schedule() {
        if (raf || destroyed) {
            return;
        }

        lastTick = performance.now();
        raf = requestAnimationFrame(function tick(now) {
            raf = 0;
            if (destroyed) {
                return;
            }

            let
                elapsed = now - lastTick;

            lastTick = now;

            if (playing && caughtUp && player) {
                time = Math.min(player.duration, time + elapsed * speed);
            }

            advance();
            render();

            if (playing) {
                emitTime();
            }

            if (finished()) {
                showFinalImage(player.drift.length > 0);

                if (playing) {
                    playing = false;
                    emitTime();
                    if (options.onEnd) {
                        options.onEnd();
                    }
                }
            }

            if (playing || !caughtUp) {
                raf = requestAnimationFrame(tick);
            }
        });
    }

    this.play = function() {
        if (destroyed) {
            return;
        }
        if (player && time >= player.duration && player.duration > 0) {
            this.seek(0);
        }
        playing = true;
        emitTime();
        schedule();
    };

    this.pause = function() {
        playing = false;
        emitTime();
    };

    /**
     * @param {number} ms
     */
    this.seek = function(ms) {
        if (destroyed || !player) {
            return;
        }

        ms = clamp(Number(ms) || 0, 0, player.duration);

        // Restores the nearest keyframe (or the start) if that's quicker than replaying from where we are
        player.seek(ms);

        time = ms;
        caughtUp = false;
        showFinalImage(false);
        emitTime();
        schedule();
    };

    /**
     * @param {number} multiplier - Playback rate
     */
    this.setSpeed = function(multiplier) {
        speed = clamp(Number(multiplier) || 1, MIN_SPEED, MAX_SPEED);
    };

    this.destroy = function() {
        destroyed = true;
        playing = false;
        if (raf) {
            cancelAnimationFrame(raf);
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
        button.onclick = () => playing ? that.pause() : that.play();

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
        updateControls();
    }

    function updateControls() {
        if (!controls) {
            return;
        }
        controls.button.textContent = playing ? "Pause" : "Play";
        if (document.activeElement !== controls.range) {
            let
                duration = that.duration;

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

    this.ready = load().then(bytes => {
        player = new CPRecordingPlayer(bytes, {
            maxIdle: options.maxIdle,
            keyframeMemory: options.keyframeMemory === undefined ? defaultKeyframeMemory() : options.keyframeMemory,
            onDrift: drift => {
                if (options.onDrift) {
                    options.onDrift(drift);
                }
            }
        });
        player.onArtworkChange = onArtworkChange;

        return player.prepare();
    }).then(() => {
        let
            size = player.getFinalSize();

        canvas.width = size.width;
        canvas.height = size.height;
        layout();

        advance(Infinity);
        render();
        emitTime();

        if (options.autoplay) {
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
