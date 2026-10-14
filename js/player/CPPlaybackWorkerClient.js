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


/**
 * Runs a CPPlaybackLoop in a worker (ChickenPaintPlayerWorker), drawing onto the page's canvas through an
 * OffscreenCanvas, so that replaying doesn't keep the page busy. Same interface as CPPlaybackLoop; the time, duration and
 * playing state are the worker's latest report (and the effect of the latest command).
 *
 * @param {HTMLCanvasElement} canvas - Becomes the worker's: the page can't draw on it or resize it any more
 * @param {string} workerUrl - chickenpaint-player-worker(.min).js
 * @param {Object} options - As CPPlaybackLoop's, without fetch (the worker fetches files relative to options.baseUrl)
 *
 * @constructor
 */
export default function CPPlaybackWorkerClient(canvas, workerUrl, options) {
    let
        worker = new Worker(workerUrl),
        offscreen = canvas.transferControlToOffscreen(),
        duration = 0,
        time = 0,
        playing = false,
        /**
         * A seek is on its way to its target (the canvas still shows the frame from before it)
         */
        seeking = false,
        ready = false,
        destroyed = false,
        /**
         * Numbers the commands, so that reports from before the latest one (still on their way) are ignored
         */
        sequence = 0;

    Object.defineProperties(this, {
        duration: {get: () => duration},
        currentTime: {get: () => time},
        isPlaying: {get: () => playing},
        seeking: {get: () => seeking}
    });

    function send(message, transfer) {
        if (!destroyed) {
            message.sequence = ++sequence;
            worker.postMessage(message, transfer || []);
        }
    }

    /**
     * @param {Uint8Array} bytes - The recording (copied to the worker)
     * @returns {Promise} Rejects with an error that has workerUnsupported set if the worker couldn't start (then use
     *                    CPPlaybackLoop on a new canvas instead)
     */
    this.load = function(bytes) {
        return new Promise((resolve, reject) => {
            function unsupported(message) {
                let
                    error = new Error("ChickenPaintPlayer worker: " + message);

                error.workerUnsupported = true;
                return error;
            }

            worker.onmessage = function(e) {
                let
                    message = e.data;

                if (destroyed) {
                    return;
                }

                switch (message.type) {
                    case "ready":
                        ready = true;
                        duration = message.duration;
                        resolve();
                        break;
                    case "time":
                        if (message.sequence < sequence) {
                            // Out of date: a command is on its way
                            break;
                        }
                        time = message.info.currentTime;
                        duration = message.info.duration;
                        playing = message.info.isPlaying;
                        seeking = !!message.info.seeking;
                        if (options.onTimeUpdate) {
                            options.onTimeUpdate(message.info);
                        }
                        break;
                    case "end":
                        playing = false;
                        if (options.onEnd) {
                            options.onEnd();
                        }
                        break;
                    case "drift":
                        if (options.onDrift) {
                            options.onDrift(message.drift);
                        }
                        break;
                    case "size":
                        if (options.onCanvasSize) {
                            options.onCanvasSize(message.width, message.height);
                        }
                        break;
                    case "final":
                        if (options.onFinalImage) {
                            options.onFinalImage(message.show);
                        }
                        break;
                    case "unsupported":
                        reject(unsupported(message.message));
                        break;
                    case "error": {
                        let
                            error = new Error(message.message);

                        if (!ready) {
                            reject(error);
                        } else if (options.onError) {
                            options.onError(error);
                        }
                        break;
                    }
                }
            };

            worker.onerror = function(e) {
                // The script didn't load or run (e.g. it's missing), or threw outside the replay
                if (e.preventDefault) {
                    e.preventDefault();
                }
                if (!ready) {
                    reject(unsupported(e.message || "failed to start"));
                } else if (options.onError && !destroyed) {
                    options.onError(new Error(e.message || "ChickenPaintPlayer worker failed"));
                }
            };

            send({
                type: "init",
                canvas: offscreen,
                recording: bytes,
                baseUrl: options.baseUrl,
                speed: options.speed,
                maxIdle: options.maxIdle,
                keyframeMemory: options.keyframeMemory
            }, [offscreen]);
        });
    };

    this.play = function() {
        if (duration > 0 && time >= duration) {
            time = 0;
        }
        playing = true;
        send({type: "play"});
    };

    this.pause = function() {
        playing = false;
        send({type: "pause"});
    };

    this.seek = function(ms) {
        time = Math.max(0, Math.min(duration, Number(ms) || 0));
        seeking = true;
        send({type: "seek", ms: time});
    };

    this.setSpeed = function(multiplier) {
        send({type: "speed", speed: multiplier});
    };

    this.destroy = function() {
        if (!destroyed) {
            destroyed = true;
            worker.terminate();
        }
    };
}
