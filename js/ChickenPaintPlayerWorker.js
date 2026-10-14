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
 * The worker side of ChickenPaintPlayer (see CPPlaybackWorkerClient): replays the recording and draws it onto the
 * OffscreenCanvas of the page's canvas.
 */

import CPPlaybackLoop from "./player/CPPlaybackLoop.js";

let
    loop = null,
    sequence = 0;

function post(message) {
    message.sequence = sequence;
    self.postMessage(message);
}

/**
 * Drift reports with their errors as plain objects (not every browser can post an Error).
 */
function plainDrift(drift) {
    let
        result = {};

    for (let key of Object.keys(drift)) {
        let
            value = drift[key];

        result[key] = value instanceof Error ? {name: value.name, message: value.message, stack: value.stack} : value;
    }
    return result;
}

function init(message) {
    let
        canvas = message.canvas,
        baseUrl = message.baseUrl;

    if (!canvas || !canvas.getContext("2d")) {
        post({type: "unsupported", message: "no OffscreenCanvas 2D context"});
        return;
    }

    loop = new CPPlaybackLoop(canvas, {
        speed: message.speed,
        maxIdle: message.maxIdle,
        keyframeMemory: message.keyframeMemory,
        // As CPRecordingPlayer's, but relative to the page rather than to this script
        fetch: url => fetch(new URL(url, baseUrl).href, {mode: "cors", credentials: "omit"}).then(response => {
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }
            return response.arrayBuffer();
        }).then(buffer => new Uint8Array(buffer)),
        onTimeUpdate: info => post({type: "time", info: info}),
        onEnd: () => post({type: "end"}),
        onDrift: drift => post({type: "drift", drift: plainDrift(drift)}),
        onCanvasSize: (width, height) => post({type: "size", width: width, height: height}),
        onFinalImage: show => post({type: "final", show: show}),
        onError: error => post({type: "error", message: error.message})
    });

    loop.load(new Uint8Array(message.recording)).then(
        () => post({type: "ready", duration: loop.duration}),
        error => post({type: "error", message: error instanceof Error ? error.message : String(error)})
    );
}

self.onmessage = function(e) {
    let
        message = e.data;

    sequence = message.sequence;

    switch (message.type) {
        case "init":
            init(message);
            break;
        case "play":
            if (loop) {
                loop.play();
            }
            break;
        case "pause":
            if (loop) {
                loop.pause();
            }
            break;
        case "seek":
            if (loop) {
                loop.seek(message.ms);
            }
            break;
        case "speed":
            if (loop) {
                loop.setSpeed(message.speed);
            }
            break;
    }
};
