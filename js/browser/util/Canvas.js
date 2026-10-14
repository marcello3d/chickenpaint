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
 * Create a canvas (an OffscreenCanvas in a worker, where there's no document).
 *
 * @param {int} width
 * @param {int} height
 * @returns {HTMLCanvasElement|OffscreenCanvas}
 */
export function createCanvas(width, height) {
	if (typeof document === "undefined" && typeof OffscreenCanvas === "function") {
		return new OffscreenCanvas(width, height);
	}

	let
		canvas = document.createElement("canvas");
	
	canvas.width = width;
	canvas.height = height;
	
	return canvas;
}

let
	supportsImageDataConstructor = typeof ImageData === "function",
	scratchContext = null;

/**
 * Create a blank ImageData (pixel storage for a bitmap).
 *
 * @param {int} width
 * @param {int} height
 * @returns {ImageData}
 */
export function createImageData(width, height) {
	if (supportsImageDataConstructor) {
		try {
			// No canvas and context to allocate (and garbage collect) for each bitmap
			return new ImageData(width, height);
		} catch (e) {
			// Old browsers (IE) have ImageData but can't construct it. Invalid sizes throw from both.
			if (!(e instanceof TypeError)) {
				throw e;
			}
			supportsImageDataConstructor = false;
		}
	}

	if (!scratchContext) {
		scratchContext = createCanvas(1, 1).getContext("2d");
	}

	return scratchContext.createImageData(width, height);
}
