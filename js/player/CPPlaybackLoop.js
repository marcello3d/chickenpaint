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


import CPRecordingPlayer from "../engine/CPRecordingPlayer.js";
import CPRect from "../util/CPRect.js";
import {createCanvas} from "../util/Canvas.js";

const
    FRAME_BUDGET_MS = 12,
    /**
     * Replay time per frame while seeking: nothing is drawn meanwhile, so it can be longer
     */
    SEEK_BUDGET_MS = 30,
    MIN_SPEED = 0.25,
    MAX_SPEED = 256;

export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export function clampSpeed(speed) {
    return clamp(Number(speed) || 1, MIN_SPEED, MAX_SPEED);
}

function now() {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// Workers have requestAnimationFrame in most browsers that have OffscreenCanvas, but not all
const
    nextFrame = typeof requestAnimationFrame === "function"
        ? callback => requestAnimationFrame(callback)
        : callback => setTimeout(() => callback(now()), 16),
    cancelFrame = typeof cancelAnimationFrame === "function" ? handle => cancelAnimationFrame(handle) : handle => clearTimeout(handle);

/**
 * Plays a drawing recording onto a canvas: the playback clock, replaying (CPRecordingPlayer) up to it a frame at a time,
 * and drawing the replay. It has no DOM of its own, so it runs on the page (ChickenPaintPlayer) or in a worker onto an
 * OffscreenCanvas (ChickenPaintPlayerWorker).
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {Object} options
 * @param {number} [options.speed]
 * @param {number} [options.maxIdle]
 * @param {number} [options.keyframeMemory]
 * @param {function(string):Promise<Uint8Array>} [options.fetch] - Loads files the recording refers to
 * @param {function(Object)} [options.onTimeUpdate] - {currentTime, duration, isPlaying, progress, seeking}
 * @param {function()} [options.onEnd]
 * @param {function(Object)} [options.onDrift]
 * @param {function(int, int)} [options.onCanvasSize] - The canvas was resized (width, height)
 * @param {function(boolean)} [options.onFinalImage] - Show (true) or hide the saved drawing over the replay
 * @param {function(Error)} [options.onError] - Replaying failed
 *
 * @constructor
 */
export default function CPPlaybackLoop(canvas, options) {
    const
        that = this,
        context = canvas.getContext("2d"),
        dirty = new CPRect(0, 0, 0, 0);

    let
        player = null,
        speed = clampSpeed(options.speed),
        time = 0,
        playing = false,
        caughtUp = true,
        /**
         * A seek is on its way to its target. Double buffering: the canvas keeps the last frame drawn before the seek
         * until the replay reaches the target, so seeking (backwards especially, from a keyframe or the start) never
         * shows a keyframe, a blank canvas or a half-replayed one.
         */
        seeking = false,
        /**
         * The saved drawing is shown over the replay (onFinalImage(true))
         */
        finalShown = false,
        destroyed = false,
        frame = 0,
        lastTick = 0,
        artwork = null,
        rotation = -1,
        drawnWidth = 0,
        drawnHeight = 0,
        /**
         * Where the drawing is rotated, it's drawn here then onto the canvas
         */
        surface = null,
        surfaceContext = null;

    Object.defineProperties(this, {
        duration: {get: () => player ? player.duration : 0},
        currentTime: {get: () => time},
        isPlaying: {get: () => playing},
        seeking: {get: () => seeking}
    });

    function emitTime() {
        if (options.onTimeUpdate) {
            let
                duration = that.duration;

            options.onTimeUpdate({
                currentTime: time,
                duration: duration,
                isPlaying: playing,
                progress: duration ? time / duration : 0,
                seeking: seeking
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

    function setCanvasSize(width, height) {
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        if (options.onCanvasSize) {
            options.onCanvasSize(width, height);
        }
    }

    function render() {
        if (!artwork) {
            return;
        }

        if (player.rotation !== rotation || drawnWidth !== artwork.width || drawnHeight !== artwork.height) {
            rotation = player.rotation;
            drawnWidth = artwork.width;
            drawnHeight = artwork.height;
            setCanvasSize(rotation % 2 ? artwork.height : artwork.width, rotation % 2 ? artwork.width : artwork.height);
            if (rotation !== 0) {
                if (!surface) {
                    surface = createCanvas(artwork.width, artwork.height);
                    surfaceContext = surface.getContext("2d");
                }
                surface.width = artwork.width;
                surface.height = artwork.height;
            }
            dirty.set(artwork.getBounds());
        }

        dirty.clipTo(artwork.getBounds());
        if (dirty.isEmpty()) {
            return;
        }

        let
            fusion = artwork.fusionLayers();

        if (rotation === 0) {
            // Straight onto the canvas
            context.putImageData(fusion.imageData, 0, 0, dirty.left, dirty.top, dirty.getWidth(), dirty.getHeight());
            dirty.makeEmpty();
            return;
        }

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

    function advance(budget) {
        if (player) {
            caughtUp = player.advanceTo(time, budget === undefined ? (seeking ? SEEK_BUDGET_MS : FRAME_BUDGET_MS) : budget);
        }
    }

    function showFinalImage(show) {
        if (show !== finalShown) {
            finalShown = show;
            if (options.onFinalImage) {
                options.onFinalImage(show);
            }
        }
    }

    function finished() {
        return player && caughtUp && time >= player.duration && player.isDone();
    }

    function fail(error) {
        playing = false;
        destroyed = true;
        if (options.onError) {
            options.onError(error instanceof Error ? error : new Error(String(error)));
        }
    }

    function tick(timestamp) {
        frame = 0;
        if (destroyed) {
            return;
        }

        let
            elapsed = Math.max(0, timestamp - lastTick);

        lastTick = timestamp;

        try {
            if (playing && caughtUp && player) {
                time = Math.min(player.duration, time + elapsed * speed);
            }

            advance();

            let
                seeked = seeking && caughtUp;

            if (seeked) {
                seeking = false;
            }

            // Only a frame at the playback time reaches the canvas (see seeking)
            if (!seeking) {
                render();
            }

            if (playing || seeked) {
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
            } else if (seeked) {
                showFinalImage(false);
            }
        } catch (e) {
            fail(e);
            return;
        }

        if (playing || !caughtUp) {
            frame = nextFrame(tick);
        }
    }

    function schedule() {
        if (frame || destroyed) {
            return;
        }

        lastTick = now();
        frame = nextFrame(tick);
    }

    /**
     * @param {Uint8Array} bytes - The recording
     * @returns {Promise} Resolves once the start of the recording is drawn
     */
    this.load = function(bytes) {
        player = new CPRecordingPlayer(bytes, {
            maxIdle: options.maxIdle,
            keyframeMemory: options.keyframeMemory,
            fetch: options.fetch,
            onDrift: drift => {
                if (options.onDrift) {
                    options.onDrift(drift);
                }
            }
        });
        player.onArtworkChange = onArtworkChange;

        return player.prepare().then(() => {
            let
                size = player.getFinalSize();

            setCanvasSize(size.width, size.height);

            advance(Infinity);
            render();
            emitTime();
        });
    };

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
        seeking = true;
        // The saved drawing (if shown) stays until the replay gets there, as the canvas does
        emitTime();
        schedule();
    };

    /**
     * @param {number} multiplier - Playback rate
     */
    this.setSpeed = function(multiplier) {
        speed = clampSpeed(multiplier);
    };

    this.destroy = function() {
        destroyed = true;
        playing = false;
        if (frame) {
            cancelFrame(frame);
            frame = 0;
        }
    };
}
