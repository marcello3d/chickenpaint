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

import assert from "assert";

import CPArtwork from "../js/engine/CPArtwork.js";
import CPBrushInfo from "../js/engine/CPBrushInfo.js";
import CPImageLayer from "../js/engine/CPImageLayer.js";
import CPLayerGroup from "../js/engine/CPLayerGroup.js";
import CPGreyBmp from "../js/engine/CPGreyBmp.js";
import CPColorBmp from "../js/engine/CPColorBmp.js";
import CPClip from "../js/engine/CPClip.js";
import CPBlend from "../js/engine/CPBlend.js";
import CPRecorder from "../js/engine/CPRecorder.js";
import CPRecordingPlayer from "../js/engine/CPRecordingPlayer.js";
import CPPlaybackLoop from "../js/player/CPPlaybackLoop.js";
import {save as chiSave, load as chiLoad} from "../js/engine/CPChibiFile.js";
import {
	parseRecording, decodeEvents, layerList, rotateRGBA, hashImage, hashLayers, buildLayersFromTable, getLayerTable, layerBitmaps,
	START_BLANK, START_CONTINUE, START_CONTINUE_FLAT, START_SNAPSHOT, START_REFERENCE, SOURCE_CHI, SOURCE_PNG, OP,
	ENGINE_REVISION, writeChunk
} from "../js/engine/CPRecordingFormat.js";
import {encodePNG, decodePNG} from "../js/util/CPPNG.js";
import {ByteReader, ByteWriter} from "../js/util/CPByteStream.js";
import * as CPMath from "../js/util/CPMath.js";
import CPRect from "../js/util/CPRect.js";
import CPTransform from "../js/util/CPTransform.js";

function mulberry32(seed) {
	return function() {
		seed = (seed + 0x6D2B79F5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * A fake millisecond clock for the recorder.
 */
function makeClock() {
	let
		time = 0,
		clock = () => time;

	clock.advance = ms => { time += ms; };
	return clock;
}

function describeLayer(layer) {
	return {
		type: layer instanceof CPLayerGroup ? "group" : "image",
		name: layer.name,
		alpha: layer.alpha,
		blendMode: layer.blendMode,
		visible: layer.visible,
		lockAlpha: layer.lockAlpha,
		clip: !!layer.clip,
		hasMask: !!layer.mask,
		maskLinked: layer.maskLinked,
		maskVisible: layer.maskVisible,
		expanded: layer instanceof CPLayerGroup ? layer.expanded : null,
		children: layer instanceof CPLayerGroup ? layer.layers.length : 0
	};
}

function firstDifference(a, b) {
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return i;
		}
	}
	return -1;
}

/**
 * Assert that two artworks have identical layer trees, properties and pixels.
 */
function assertSameDocument(actual, expected, message) {
	assert.strictEqual(actual.width, expected.width, message + ": width");
	assert.strictEqual(actual.height, expected.height, message + ": height");

	let
		actualLayers = layerList(actual),
		expectedLayers = layerList(expected);

	assert.deepStrictEqual(actualLayers.map(describeLayer), expectedLayers.map(describeLayer), message + ": layers");

	expectedLayers.forEach((layer, i) => {
		if (layer instanceof CPImageLayer) {
			let
				diff = firstDifference(actualLayers[i].image.data, layer.image.data);

			assert.strictEqual(diff, -1, message + ": pixels of layer " + i + " (" + layer.name + ") differ at byte " + diff);
		}
		if (layer.mask) {
			let
				diff = firstDifference(actualLayers[i].mask.data, layer.mask.data);

			assert.strictEqual(diff, -1, message + ": mask of layer " + i + " (" + layer.name + ") differs at " + diff);
		}
	});

	assert.strictEqual(layerList(actual).indexOf(actual.getActiveLayer()), layerList(expected).indexOf(expected.getActiveLayer()), message + ": active layer");
	assert.strictEqual(!!actual.isEditingMask(), !!expected.isEditingMask(), message + ": mask editing");
	assert(actual.getSelection().equals(expected.getSelection()), message + ": selection");
}

/**
 * Drives a CPArtwork the way the GUI does, with random operations.
 */
function Driver(artwork, random, clock) {
	const
		brush = new CPBrushInfo({size: 8, alpha: 255, spacing: 0.15, tip: CPBrushInfo.TIP_ROUND_AA, isAA: true}),
		ops = [];

	artwork.setBrush(brush);
	artwork.setForegroundColor(0x000000);

	function int(n) {
		return Math.floor(random() * n);
	}

	function pick(list) {
		return list[int(list.length)];
	}

	function chance(p) {
		return random() < p;
	}

	function randomLayer(includeRoot) {
		let
			layers = layerList(artwork);

		if (includeRoot && chance(0.2)) {
			return artwork.getLayersRoot();
		}
		return pick(layers);
	}

	function randomGroup() {
		let
			groups = layerList(artwork).filter(layer => layer instanceof CPLayerGroup);

		groups.push(artwork.getLayersRoot());
		return pick(groups);
	}

	function randomRect() {
		let
			x1 = int(artwork.width + 10) - 5, y1 = int(artwork.height + 10) - 5,
			x2 = x1 + int(artwork.width), y2 = y1 + int(artwork.height);

		return new CPRect(x1, y1, x2, y2);
	}

	function tick(ms) {
		clock.advance(ms === undefined ? int(50) : ms);
	}

	const actions = [
		// Strokes are the most common
		[30, function stroke() {
			if (chance(0.3)) {
				brush.brushMode = pick([0, 0, 0, 1, 2, 3, 4, 5, 6, 7]);
				brush.tip = int(5);
				brush.isAA = chance(0.7);
				brush.size = 1 + int(chance(0.2) ? 60 : 16) + (chance(0.3) ? random() : 0);
				brush.alpha = 1 + int(255);
				brush.spacing = pick([0.05, 0.1, 0.15, 0.5]);
				brush.minSpacing = pick([0, 0, 0.5]);
				brush.pressureSize = chance(0.5);
				brush.pressureAlpha = chance(0.5);
				brush.pressureScattering = chance(0.3);
				brush.scattering = chance(0.3) ? random() * 2 : 0;
				brush.squeeze = chance(0.3) ? random() : 0;
				brush.angle = chance(0.3) ? random() * Math.PI * 2 : Math.PI;
				brush.resat = random();
				brush.bleed = random();
				brush.texture = chance(0.3) ? random() : 1.0;
				brush.paintMode = int(2);
				brush.alphaScale = pick([1.0, 0.5]);
			}
			if (chance(0.3)) {
				artwork.setForegroundColor(int(0x1000000));
			}
			if (chance(0.1)) {
				artwork.setSampleAllLayers(chance(0.5));
			}
			if (chance(0.05)) {
				let
					texture = null;

				if (chance(0.7)) {
					texture = new CPGreyBmp(4 + int(8), 4 + int(8), 8);
					for (let i = 0; i < texture.data.length; i++) {
						texture.data[i] = int(256);
					}
				}
				artwork.setBrushTexture(texture);
			}

			let
				x = random() * artwork.width * 1.2 - artwork.width * 0.1,
				y = random() * artwork.height * 1.2 - artwork.height * 0.1,
				p = random();

			tick();
			if (artwork.beginStroke(x, y, p)) {
				let
					n = int(30);

				for (let i = 0; i < n; i++) {
					x += (random() - 0.5) * 12;
					y += (random() - 0.5) * 12;
					p = Math.max(0, Math.min(1, p + (random() - 0.5) * 0.2));
					tick(int(20));
					artwork.continueStroke(x, y, p);
					if (chance(0.1)) {
						// The GUI repaints at arbitrary times
						artwork.fusionLayers();
					}
					if (chance(0.05)) {
						// Duplicate point
						artwork.continueStroke(x, y, p);
					}
				}
				tick(int(20));
				artwork.endStroke();
			}
		}],
		[3, function addLayer() { artwork.addLayer(chance(0.25) ? "group" : "layer"); }],
		[1, function removeLayer() { if (artwork.isRemoveLayerAllowed()) artwork.removeLayer(); }],
		[1, function duplicateLayer() { artwork.duplicateLayer(); }],
		[1, function mergeDown() { artwork.mergeDown(); }],
		[1, function mergeGroup() { artwork.mergeGroup(); }],
		[0.3, function mergeAll() { artwork.mergeAllLayers(); }],
		[1, function relocate() {
			let
				layer = randomLayer(false),
				group = randomGroup();

			artwork.relocateLayer(layer, group, int(group.layers.length + 1));
		}],
		[1, function addMask() { artwork.addLayerMask(); }],
		[0.5, function removeMask() { artwork.removeLayerMask(); }],
		[0.5, function applyMask() { artwork.applyLayerMask(); }],
		[5, function selectLayer() { artwork.setActiveLayer(randomLayer(false), chance(0.3)); }],
		[1, function visibility() { artwork.setLayerVisibility(randomLayer(false), chance(0.6)); }],
		[1, function alpha() {
			// Slider drags make many merged changes
			for (let i = int(4) + 1; i > 0; i--) {
				artwork.setLayerAlpha(int(101));
				tick(10);
			}
		}],
		[1, function blendMode() { artwork.setLayerBlendMode(int(CPBlend.LM_LAST_CHIBIPAINT + 1)); }],
		[0.5, function rename() { artwork.setLayerName(randomLayer(false), "Name " + int(100) + (chance(0.2) ? " é✓" : "")); }],
		[0.5, function maskLinked() { artwork.setLayerMaskLinked(chance(0.5)); }],
		[0.5, function maskVisible() { artwork.setLayerMaskVisible(randomLayer(false), chance(0.5)); }],
		[0.5, function clip() { if (chance(0.5)) artwork.createClippingMask(); else artwork.releaseClippingMask(); }],
		[0.5, function lockAlpha() { artwork.setLayerLockAlpha(chance(0.5)); }],
		[0.5, function expand() {
			let
				group = randomGroup();

			if (group !== artwork.getLayersRoot()) {
				artwork.expandLayerGroup(group, chance(0.5));
			}
		}],
		[3, function select() {
			if (chance(0.2)) {
				artwork.rectangleSelection(new CPRect(0, 0, 0, 0));
			} else {
				artwork.rectangleSelection(randomRect());
			}
		}],
		[2, function move() {
			let
				copy = chance(0.2);

			for (let i = int(5) + 1; i > 0; i--) {
				artwork.move(int(21) - 10, int(21) - 10, copy);
				tick(15);
			}
		}],
		[1, function cut() { if (artwork.isActiveLayerDrawable() && artwork.isCutSelectionAllowed()) artwork.cutSelection(); }],
		[1, function copy() { if (artwork.isActiveLayerDrawable() && artwork.isCopySelectionAllowed()) artwork.copySelection(); }],
		[0.5, function copyMerged() { if (artwork.isCopySelectionMergedAllowed()) artwork.copySelectionMerged(); }],
		[1, function paste() { artwork.pasteClipboard(); }],
		[0.3, function externalPaste() {
			let
				w = 1 + int(20), h = 1 + int(20),
				bmp = chance(0.8) ? new CPColorBmp(w, h) : new CPGreyBmp(w, h, 8);

			for (let i = 0; i < bmp.data.length; i++) {
				bmp.data[i] = int(256);
			}
			artwork.setClipboard(new CPClip(bmp, int(artwork.width), int(artwork.height)));
			artwork.pasteClipboard();
		}],
		[1.5, function transform() {
			if (!artwork.isActiveLayerDrawable() && !(artwork.getActiveLayer() instanceof CPLayerGroup)) {
				return;
			}
			if (artwork.transformAffineBegin()) {
				for (let i = int(3); i >= 0; i--) {
					let
						t = new CPTransform();

					t.translate(int(11) - 5, int(11) - 5);
					if (chance(0.5)) {
						t.rotateAroundPoint(random() * 0.5, artwork.width / 2, artwork.height / 2);
					}
					if (chance(0.3)) {
						t.scaleAroundPoint(0.5 + random(), 0.5 + random(), artwork.width / 2, artwork.height / 2);
					}
					artwork.transformAffineAmend(t);
					tick(20);
				}
				if (chance(0.15)) {
					artwork.transformAffineAbort();
				} else {
					artwork.transformAffineFinish();
				}
			}
		}],
		[1, function fill() { if (artwork.isActiveLayerDrawable()) artwork.fill((int(0x1000000) | (int(256) << 24)) >>> 0); }],
		[0.5, function clear() { if (artwork.isActiveLayerDrawable()) artwork.clear(); }],
		[1, function floodFill() {
			if (artwork.isActiveLayerDrawable()) {
				artwork.setForegroundColor(int(0x1000000));
				artwork.floodFill(random() * artwork.width, random() * artwork.height);
			}
		}],
		[1, function gradient() {
			if (artwork.isActiveLayerDrawable()) {
				artwork.gradientFill(int(artwork.width), int(artwork.height), int(artwork.width), int(artwork.height),
					[(int(0x1000000) | (pick([255, int(256)]) << 24)) >>> 0, (int(0x1000000) | (pick([255, int(256)]) << 24)) | 0]);
			}
		}],
		[0.5, function flip() { if (chance(0.5)) artwork.hFlip(); else artwork.vFlip(); }],
		[0.5, function noise() {
			if (artwork.isActiveLayerDrawable()) {
				if (chance(0.5)) artwork.monochromaticNoise(); else if (artwork.isColorNoiseAllowed()) artwork.colorNoise();
			}
		}],
		[0.5, function invert() { if (artwork.isActiveLayerDrawable()) artwork.invert(); }],
		[0.5, function blur() { if (artwork.isActiveLayerDrawable()) artwork.boxBlur(1 + int(3), 1 + int(3), 1 + int(2)); }],
		[6, function undo() {
			for (let i = int(3) + 1; i > 0; i--) {
				artwork.undo();
			}
		}],
		[4, function redo() {
			for (let i = int(3) + 1; i > 0; i--) {
				artwork.redo();
			}
		}],
		[0.1, function clearHistory() { artwork.clearHistory(); }]
	];

	const
		totalWeight = actions.reduce((total, action) => total + action[0], 0);

	this.step = function() {
		let
			r = random() * totalWeight;

		if (chance(0.5)) {
			// The GUI repaints at arbitrary times
			artwork.fusionLayers();
		}

		for (let [weight, action] of actions) {
			r -= weight;
			if (r < 0) {
				ops.push(action.name);
				action();
				tick(int(chance(0.05) ? 3000 : 200));
				return;
			}
		}
	};

	this.run = function(steps) {
		for (let i = 0; i < steps; i++) {
			this.step();
		}
	};

	this.ops = ops;
}

function newBlankArtwork(width, height) {
	let
		artwork = new CPArtwork(width, height);

	artwork.addBackgroundLayer();
	return artwork;
}

function replay(bytes, options) {
	let
		player = new CPRecordingPlayer(bytes, options);

	return player.prepare().then(() => {
		player.finish();
		return player;
	});
}

/**
 * Undo everything on both artworks, comparing after each step.
 */
function assertSameUndoHistory(actual, expected, message) {
	let
		steps = 0;

	while (expected.isUndoAllowed()) {
		assert(actual.isUndoAllowed(), message + ": undo allowed after " + steps + " undos");
		expected.undo();
		actual.undo();
		steps++;
		assertSameDocument(actual, expected, message + " after " + steps + " undos");
	}
	assert(!actual.isUndoAllowed(), message + ": extra undo history");

	while (expected.isRedoAllowed()) {
		expected.redo();
		actual.redo();
		assertSameDocument(actual, expected, message + " after redo");
	}
}

async function chiRoundTrip(artwork) {
	let
		result = await chiSave(artwork),
		bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(await result.bytes.arrayBuffer());

	return chiLoad(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/**
 * Reopen a drawing from the flat image CPResourceSaver would upload (rotated by rotation).
 */
function flatRoundTrip(artwork, rotation) {
	let
		fusion = artwork.fusionLayers(),
		rotated = rotateRGBA(fusion.width, fusion.height, fusion.data, rotation),
		png = decodePNG(encodePNG(rotated.width, rotated.height, rotated.data, 4)),
		result = new CPArtwork(png.width, png.height),
		layer = new CPImageLayer(0, 0, "Layer 1");

	layer.image = new CPColorBmp(png.width, png.height);
	layer.image.data.set(png.data);
	result.addLayerObject(result.getLayersRoot(), layer);
	return result;
}

describe("CPMath", function() {
	it("should agree with Math.sin, Math.cos and Math.log to within an ulp", function() {
		let
			random = mulberry32(1);

		for (let i = 0; i < 100000; i++) {
			let
				x = (random() - 0.5) * (i % 2 ? 20 : 2000),
				y = random() * 100 + 1e-10;

			assert(Math.abs(CPMath.sin(x) - Math.sin(x)) <= 2.3e-16, "sin(" + x + ")");
			assert(Math.abs(CPMath.cos(x) - Math.cos(x)) <= 2.3e-16, "cos(" + x + ")");
			assert(Math.abs(CPMath.log(y) - Math.log(y)) <= Math.abs(Math.log(y)) * 2.3e-16 + 1e-300, "log(" + y + ")");
		}
		assert.strictEqual(CPMath.sin(0), 0);
		assert.strictEqual(CPMath.cos(0), 1);
		assert.strictEqual(CPMath.log(1), 0);
		assert(Number.isNaN(CPMath.sin(Infinity)));
	});
});

describe("CPByteStream", function() {
	it("should round-trip varints, zigzag varints, numbers and strings", function() {
		let
			w = new ByteWriter(4),
			ints = [0, 1, 127, 128, 300, 2 ** 31, 2 ** 40, 2 ** 53 - 1],
			sints = [0, -1, 1, -64, 64, -(2 ** 31), 2 ** 40],
			nums = [0, 1, -1, 0.5, Math.PI, -1e300, 2 ** 45, -0, NaN],
			strings = ["", "Layer 1", "日本語 ✓"];

		ints.forEach(v => w.varint(v));
		sints.forEach(v => w.svarint(v));
		nums.forEach(v => w.num(v));
		strings.forEach(v => w.string(v));
		w.u24(0x123456);
		w.u32(0xdeadbeef);

		let
			r = new ByteReader(w.toBytes());

		ints.forEach(v => assert.strictEqual(r.varint(), v));
		sints.forEach(v => assert.strictEqual(r.svarint(), v));
		nums.forEach(v => assert(Object.is(r.num(), v)));
		strings.forEach(v => assert.strictEqual(r.string(), v));
		assert.strictEqual(r.u24(), 0x123456);
		assert.strictEqual(r.u32(), 0xdeadbeef);
		assert.strictEqual(r.remaining, 0);
	});
});

describe("CPPNG", function() {
	it("should round-trip RGBA and greyscale pixels exactly", function() {
		let
			random = mulberry32(2);

		for (let channels of [1, 4]) {
			let
				width = 37, height = 23,
				data = new Uint8Array(width * height * channels);

			for (let i = 0; i < data.length; i++) {
				data[i] = i % 7 === 0 ? Math.floor(random() * 256) : (i * 13) & 0xff;
			}

			let
				decoded = decodePNG(encodePNG(width, height, data, channels));

			assert.strictEqual(decoded.width, width);
			assert.strictEqual(decoded.height, height);
			assert.strictEqual(decoded.channels, channels);
			assert.deepStrictEqual(Array.from(decoded.data), Array.from(data));
		}
	});
});

/**
 * The composite of a new artwork with the same layers (so with nothing cached).
 */
function freshComposite(artwork) {
	let
		copy = new CPArtwork(artwork.width, artwork.height);

	buildLayersFromTable(copy, {layers: getLayerTable(artwork), rootChildren: artwork.getLayersRoot().layers.length},
		layerBitmaps(artwork), CPGreyBmp);

	return copy.fusionLayers();
}

function fillRandom(bmp, random, opaque) {
	for (let i = 0; i < bmp.data.length; i++) {
		bmp.data[i] = opaque && bmp instanceof CPColorBmp && i % 4 === 3 ? 255 : Math.floor(random() * 256);
	}
}

function assertCompositeIsFresh(artwork, message) {
	assert.strictEqual(firstDifference(artwork.fusionLayers().data, freshComposite(artwork).data), -1, message);
}

describe("CPBlendTree", function() {
	this.timeout(120000);

	it("should blend a pass-through group at the bottom onto transparency, not the last composite", function() {
		let
			random = mulberry32(1),
			artwork = new CPArtwork(16, 16),
			group = new CPLayerGroup("Group", CPBlend.LM_PASSTHROUGH),
			bottom = new CPImageLayer(16, 16, "Bottom"),
			middle = new CPImageLayer(16, 16, "Middle"),
			top = new CPImageLayer(16, 16, "Top");

		fillRandom(bottom.image, random, false);
		fillRandom(middle.image, random, false);
		fillRandom(top.image, random, false);
		middle.blendMode = CPBlend.LM_SCREEN;
		group.alpha = 50;
		artwork.addLayerObject(artwork.getLayersRoot(), group);
		artwork.addLayerObject(group, bottom);
		artwork.addLayerObject(group, middle);
		artwork.addLayerObject(artwork.getLayersRoot(), top);

		artwork.fusionLayers();
		artwork.setActiveLayer(bottom, false);
		artwork.invert();
		assertCompositeIsFresh(artwork, "after redrawing part of the group");
	});

	it("should update the composite when a clipping base's blend mode changes", function() {
		let
			random = mulberry32(2),
			artwork = newBlankArtwork(16, 16),
			base = artwork.addLayer("layer"),
			clipped;

		fillRandom(base.image, random, false);
		clipped = artwork.addLayer("layer");
		fillRandom(clipped.image, random, false);
		artwork.createClippingMask();

		artwork.fusionLayers();
		artwork.setActiveLayer(base, false);
		artwork.setLayerBlendMode(CPBlend.LM_SCREEN);
		assertCompositeIsFresh(artwork, "after changing the base's blend mode");
	});

	it("should update the composite when the blend mode of a group's only layer changes", function() {
		let
			random = mulberry32(3),
			artwork = newBlankArtwork(16, 16),
			group = artwork.addLayer("group"),
			layer;

		artwork.setLayerBlendMode(CPBlend.LM_SCREEN);
		layer = artwork.addLayer("layer");
		fillRandom(layer.image, random, false);

		artwork.fusionLayers();
		artwork.setLayerBlendMode(CPBlend.LM_MULTIPLY2);
		assertCompositeIsFresh(artwork, "after changing the layer's blend mode");
		assert(group.layers[0] === layer);
	});

	it("should give the same composite when only part of a partly transparent canvas is redrawn", function() {
		let
			random = mulberry32(4),
			artwork = new CPArtwork(16, 16),
			bottom = new CPImageLayer(16, 16, "Bottom"),
			top = new CPImageLayer(16, 16, "Top");

		// Transparent left half, opaque right half
		fillRandom(bottom.image, random, true);
		bottom.image.clearRect(new CPRect(0, 0, 8, 16), 0);
		fillRandom(top.image, random, false);
		top.blendMode = CPBlend.LM_MULTIPLY;
		top.alpha = 70;
		artwork.addLayerObject(artwork.getLayersRoot(), bottom);
		artwork.addLayerObject(artwork.getLayersRoot(), top);

		artwork.fusionLayers();
		// Redraw just the opaque half
		artwork.setActiveLayer(top, false);
		artwork.setSelection(new CPRect(8, 0, 16, 16));
		artwork.invert();
		artwork.invert();
		assertCompositeIsFresh(artwork, "after redrawing the opaque half");
	});

	it("should give the same composite whichever parts of it were redrawn before (random editing)", function() {

		for (let seed = 1; seed <= 8; seed++) {
			let
				random = mulberry32(seed * 1013),
				clock = makeClock(),
				artwork = newBlankArtwork(30 + seed * 5, 40),
				driver = new Driver(artwork, random, clock);

			for (let step = 1; step <= 200; step++) {
				driver.step();

				let
					diff = firstDifference(artwork.fusionLayers().data, freshComposite(artwork).data);

				assert.strictEqual(diff, -1, "seed " + seed + " step " + step + " (" + driver.ops.slice(-3).join(", ") + ")");
			}
		}
	});
});

describe("CPArtwork determinism", function() {
	it("should paint the same 'sample all layers' stroke however often the composite is redrawn", function() {
		let
			results = [false, true].map(redraw => {
				let
					random = mulberry32(5),
					artwork = newBlankArtwork(40, 40),
					layer = artwork.addLayer("layer"),
					brush = new CPBrushInfo({size: 9, alpha: 200, spacing: 0.1, tip: CPBrushInfo.TIP_ROUND_AA, isAA: true,
						brushMode: CPBrushInfo.BRUSH_MODE_WATER, resat: 0.3, bleed: 0.6});

				fillRandom(layer.image, random, false);
				artwork.setBrush(brush);
				artwork.setForegroundColor(0x3366cc);
				artwork.setSampleAllLayers(true);
				artwork.fusionLayers();

				artwork.beginStroke(5, 5, 1);
				for (let i = 1; i < 30; i++) {
					artwork.continueStroke(5 + i, 5 + i * 0.7, 1);
					if (redraw) {
						artwork.fusionLayers();
					}
				}
				artwork.endStroke();

				return layer.image.data;
			});

		assert.strictEqual(firstDifference(results[0], results[1]), -1);
	});

	it("should give a free transform of a mask the same result however it was amended", function() {
		let
			results = [[0.4], [0.1, 0.25, 0.4]].map(angles => {
				let
					random = mulberry32(6),
					artwork = newBlankArtwork(32, 32),
					layer = artwork.addLayer("layer");

				fillRandom(layer.image, random, false);
				artwork.addLayerMask();
				fillRandom(layer.mask, random, false);
				artwork.rectangleSelection(new CPRect(10, 10, 22, 22));

				artwork.transformAffineBegin();
				for (let angle of angles) {
					let
						transform = new CPTransform();

					transform.rotateAroundPoint(angle, 16, 16);
					artwork.transformAffineAmend(transform);
				}
				artwork.transformAffineFinish();

				return layer.mask.data;
			});

		assert.strictEqual(firstDifference(results[0], results[1]), -1);
	});
});

const
	// Set CP_RECORDING_FUZZ_SEEDS to fuzz harder
	FUZZ_SEEDS = Number(typeof process !== "undefined" && process.env.CP_RECORDING_FUZZ_SEEDS) || 12;

/**
 * Record random editing, replay it, and check the replay's document and undo history match the editor's.
 */
async function fuzzReplay(seed) {
	let
		random = mulberry32(seed),
		clock = makeClock(),
		artwork = newBlankArtwork(64 + (seed % 3) * 7, 48 + (seed % 2) * 9),
		recorder = new CPRecorder(artwork, {clock: clock, checkpointInterval: 20}),
		driver = new Driver(artwork, random, clock);

	assert.strictEqual(recorder.startKind, START_BLANK);

	driver.run(150);

	let
		bytes = recorder.getRecording(),
		player = await replay(bytes);

	assert.deepStrictEqual(player.drift.slice(0, 1).map(d => d.at + " " + d.time + (d.error ? ": " + d.error.stack : "")), [], "no drift");
	assertSameDocument(player.artwork, artwork, "seed " + seed);
	assert(!recorder.isTruncated());

	// Also check that the undo histories are equivalent
	assertSameUndoHistory(player.artwork, artwork, "seed " + seed);
}

/**
 * Rewrite the engine revision of every session of a recording, as an older recorder would have written it (0 means
 * the field is absent).
 */
function withEngineRevision(bytes, revision) {
	let
		r = new ByteReader(bytes),
		out = new ByteWriter(bytes.length + 64);

	out.bytes(bytes.subarray(0, 8));
	r.pos = 8;
	while (r.remaining > 0) {
		let
			length = r.u32(),
			type = String.fromCharCode(...r.bytes(4)),
			payload = r.bytes(length);

		r.u32();
		if (type === "SESS") {
			// The revision is the last field, a one-byte varint
			assert.strictEqual(payload[payload.length - 1], ENGINE_REVISION);
			payload = revision === 0 ? payload.subarray(0, payload.length - 1) : Uint8Array.of(...payload.subarray(0, payload.length - 1), revision);
		}
		writeChunk(out, type, payload);
	}
	return out.toBytes();
}

/**
 * Cut from a layer mask, undo back to before "add layer mask", and redo it all (which makes a new mask).
 */
function cutFromReAddedMask(artwork) {
	artwork.addLayerMask();
	artwork.rectangleSelection(new CPRect(4, 4, 20, 12));
	artwork.cutSelection();
	// Undo the cut, the selection and the mask
	for (let i = 0; i < 3; i++) {
		artwork.undo();
	}
	for (let i = 0; i < 3; i++) {
		artwork.redo();
	}
}

describe("CPRecorder and CPRecordingPlayer", function() {
	this.timeout(600000);

	for (let seed = 1; seed <= FUZZ_SEEDS; seed++) {
		it("should replay random editing bit-exactly (seed " + seed + ")", () => fuzzReplay(seed));
	}

	// Seeds that once found bugs
	for (let seed of [369, 815].filter(seed => seed > FUZZ_SEEDS)) {
		it("should replay random editing bit-exactly (seed " + seed + ")", () => fuzzReplay(seed));
	}

	it("should redo a cut from a layer mask onto the mask the layer has now", function() {
		let
			artwork = newBlankArtwork(32, 24),
			mask;

		cutFromReAddedMask(artwork);
		mask = artwork.getActiveLayer().mask;
		assert.strictEqual(mask.getPixel(10, 8), 0, "cut area");
		assert.strictEqual(mask.getPixel(2, 2), 255, "outside the cut");

		artwork.undo();
		assert.strictEqual(artwork.getActiveLayer().mask.getPixel(10, 8), 255, "after undo");
	});

	it("should replay recordings made before that fix as they were made", async function() {
		for (let legacy of [false, true]) {
			let
				clock = makeClock(),
				artwork = newBlankArtwork(32, 24),
				recorder = new CPRecorder(artwork, {clock: clock, checkpointInterval: 1});

			artwork.setLegacyCutUndo(legacy);
			cutFromReAddedMask(artwork);
			assert.strictEqual(artwork.getActiveLayer().mask.getPixel(10, 8), legacy ? 255 : 0);

			let
				bytes = recorder.getRecording(),
				asRecorded = await replay(legacy ? withEngineRevision(bytes, 0) : bytes),
				misread = await replay(withEngineRevision(bytes, legacy ? ENGINE_REVISION : 0));

			assert.strictEqual(parseRecording(bytes).sessions[0].start.engine, ENGINE_REVISION);
			assert.deepStrictEqual(asRecorded.drift, [], "legacy " + legacy);
			assertSameDocument(asRecorded.artwork, artwork, "legacy " + legacy);
			// Shows the revision matters
			assert(misread.drift.length > 0, "legacy " + legacy + " replayed with the other behaviour");
		}
	});

	it("should seek with keyframes to the same document as a replay from the start, whatever the memory budget", async function() {
		function describeState(player) {
			let
				a = player.artwork;

			return JSON.stringify([hashLayers(a), getLayerTable(a), layerList(a).indexOf(a.getActiveLayer()), !!a.isEditingMask(),
				a.getSelection(), player.drift.length]);
		}

		for (let seed = 1; seed <= 6; seed++) {
			let
				random = mulberry32(seed),
				clock = makeClock(),
				artwork = newBlankArtwork(50, 40),
				recorder = new CPRecorder(artwork, {clock: clock, checkpointInterval: 20}),
				driver = new Driver(artwork, random, clock);

			driver.run(120);

			let
				bytes = recorder.getRecording();

			for (let keyframeMemory of [1, 20000, 128 * 1024 * 1024]) {
				let
					player = new CPRecordingPlayer(bytes, {keyframeInterval: 1e-9, keyframeMemory: keyframeMemory});

				await player.prepare();
				player.finish();
				assert(player.getKeyframeStats().bytes <= keyframeMemory);
				if (keyframeMemory === 1) {
					assert.strictEqual(player.getKeyframeStats().count, 0);
				}

				for (let i = 0; i < 12; i++) {
					let
						time = Math.floor(random() * (player.duration + 1)),
						straight = new CPRecordingPlayer(bytes, {keyframeInterval: 0});

					await straight.prepare();
					straight.advanceTo(time);
					player.seek(time);
					player.advanceTo(time);
					assert.strictEqual(describeState(player), describeState(straight), "seed " + seed + " budget " + keyframeMemory + " seek to " + time);
				}
			}
		}
	});

	it("should only draw frames at the playback time onto the player's canvas, never one on the way to a seek", async function() {
		this.timeout(20000);

		for (let seed = 1; seed <= 3; seed++) {
			let
				random = mulberry32(seed + 900),
				clock = makeClock(),
				artwork = newBlankArtwork(50, 40),
				recorder = new CPRecorder(artwork, {clock: clock, checkpointInterval: 20}),
				driver = new Driver(artwork, random, clock);

			driver.run(120);

			let
				bytes = recorder.getRecording(),
				loop = null,
				pixels = new Uint8ClampedArray(50 * 40 * 4),
				drawnWhileSeeking = 0,
				context = {
					putImageData(imageData, x, y, dx, dy, dw, dh) {
						if (loop.seeking) {
							drawnWhileSeeking++;
						}
						for (let row = dy; row < dy + dh; row++) {
							let
								offset = (row * imageData.width + dx) * 4;

							pixels.set(imageData.data.subarray(offset, offset + dw * 4), (row * 50 + dx) * 4);
						}
					}
				},
				canvas = {width: 0, height: 0, getContext: () => context},
				reports = [];

			loop = new CPPlaybackLoop(canvas, {speed: 256, keyframeMemory: 1 << 20, onTimeUpdate: info => reports.push(info)});
			await loop.load(bytes);

			let
				settle = () => new Promise(resolve => {
					let
						poll = () => loop.seeking || loop.isPlaying ? setTimeout(poll, 1) : resolve();

					poll();
				});

			loop.play();
			await settle();

			for (let i = 0; i < 8; i++) {
				let
					time = Math.floor(random() * (loop.duration + 1)),
					straight = new CPRecordingPlayer(bytes, {keyframeInterval: 0});

				reports.length = 0;
				loop.seek(time);
				assert(loop.seeking, "seeking until the replay gets there");
				await settle();
				assert.strictEqual(reports[0].seeking, true);
				assert.strictEqual(reports[reports.length - 1].seeking, false, "a report when the seek lands");

				await straight.prepare();
				straight.advanceTo(time);
				assert(Buffer.from(pixels).equals(Buffer.from(straight.artwork.fusionLayers().data)),
					"seed " + seed + ": the canvas shows the drawing at " + time);
			}
			loop.destroy();
			assert.strictEqual(drawnWhileSeeking, 0);
		}
	});

	it("should take checkpoints when the editor is idle, and skip them if the drawing changed first", async function() {
		let
			totalSkipped = 0;

		for (let seed = 1; seed <= 6; seed++) {
			let
				random = mulberry32(seed + 500),
				clock = makeClock(),
				artwork = newBlankArtwork(50, 40),
				pending = [],
				recorder = new CPRecorder(artwork, {
					clock: clock,
					checkpointInterval: 5,
					idle: callback => {
						let
							entry = {callback: callback, cancelled: false};

						pending.push(entry);
						return () => { entry.cancelled = true; };
					}
				}),
				driver = new Driver(artwork, random, clock),
				run = 0, skipped = 0;

			for (let i = 0; i < 150; i++) {
				driver.step();
				// The editor is idle sometimes right after a stroke, sometimes only after more editing
				if (random() < 0.5) {
					for (let entry of pending.splice(0)) {
						if (!entry.cancelled) {
							entry.callback();
							run++;
						}
					}
				}
			}

			let
				bytes = recorder.getRecording(),
				checkpoints = 0,
				player = await replay(bytes);

			for (let payload of parseRecording(bytes).sessions[0].eventChunks) {
				checkpoints += decodeEvents(payload).filter(event => event.op === OP.CHECKPOINT).length;
			}
			skipped = run - checkpoints;
			totalSkipped += skipped;
			assert(checkpoints > 0, "seed " + seed + ": some checkpoints");
			assert.deepStrictEqual(player.drift, [], "seed " + seed);
			assertSameDocument(player.artwork, artwork, "seed " + seed);
		}
		assert(totalSkipped > 0, "some checkpoints skipped");
	});

	it("should continue a recording across sessions (layers file, flat image, and mismatch)", async function() {
		let
			random = mulberry32(100),
			clock = makeClock(),
			artwork = newBlankArtwork(60, 50),
			recorder = new CPRecorder(artwork, {clock: clock}),
			driver = new Driver(artwork, random, clock);

		driver.run(80);
		// Make sure it isn't a simple drawing
		artwork.addLayer("layer");
		let
			bytes = recorder.getRecording({rotation: 0});

		// Session 2: reopened from the .chi
		artwork = await chiRoundTrip(artwork);
		recorder = new CPRecorder(artwork, {previous: bytes, clock: clock});
		assert.strictEqual(recorder.startKind, START_CONTINUE);
		driver = new Driver(artwork, random, clock);
		driver.run(80);
		artwork.mergeAllLayers();
		if (!artwork.isSimpleDrawing()) {
			artwork.setLayerAlpha(100);
			artwork.setLayerVisibility(artwork.getActiveLayer(), true);
			artwork.removeLayerMask();
		}
		assert(artwork.isSimpleDrawing());
		bytes = recorder.getRecording({rotation: 1});

		// Session 3: a simple drawing, reopened from its (rotated) flat PNG
		let
			expectedFlat = flatRoundTrip(artwork, 1);

		artwork = flatRoundTrip(artwork, 1);
		recorder = new CPRecorder(artwork, {previous: bytes, clock: clock});
		assert.strictEqual(recorder.startKind, START_CONTINUE_FLAT);
		driver = new Driver(artwork, random, clock);
		driver.run(60);
		artwork.addLayer("layer");
		bytes = recorder.getRecording();

		let
			player = await replay(bytes);

		assert.deepStrictEqual(player.drift, []);
		assertSameDocument(player.artwork, artwork, "after three sessions");
		assert.strictEqual(parseRecording(bytes).sessions.length, 3);
		void expectedFlat;

		// Session 4: the drawing was changed by something that didn't record, so a snapshot is embedded
		artwork = await chiRoundTrip(artwork);
		artwork.getActiveLayer().image.data[0] ^= 0xff;
		recorder = new CPRecorder(artwork, {previous: bytes, clock: clock});
		assert.strictEqual(recorder.startKind, START_SNAPSHOT);
		driver = new Driver(artwork, random, clock);
		driver.run(60);
		bytes = recorder.getRecording();

		player = await replay(bytes);
		assert.deepStrictEqual(player.drift, []);
		assertSameDocument(player.artwork, artwork, "after a snapshot session");

		// Session 5: same, but with a source URL to reference instead of a snapshot
		let
			chi = await chiSave(artwork),
			chiBytes = new Uint8Array(await chi.bytes.arrayBuffer());

		artwork = await chiLoad(chiBytes.buffer);
		layerList(artwork).filter(layer => layer instanceof CPImageLayer)[0].image.data[5] ^= 0x10;
		let
			modifiedChi = new Uint8Array(await (await chiSave(artwork)).bytes.arrayBuffer());

		artwork = await chiLoad(modifiedChi.buffer);
		recorder = new CPRecorder(artwork, {previous: bytes, clock: clock, sourceUrl: "https://example.com/v5.chi", sourceFormat: SOURCE_CHI});
		assert.strictEqual(recorder.startKind, START_REFERENCE);
		driver = new Driver(artwork, random, clock);
		driver.run(40);
		bytes = recorder.getRecording();

		let
			fetched = [];

		player = await replay(bytes, {
			fetch: url => {
				fetched.push(url);
				return Promise.resolve(modifiedChi);
			}
		});
		assert.deepStrictEqual(fetched, ["https://example.com/v5.chi"]);
		assert.deepStrictEqual(player.drift, []);
		assertSameDocument(player.artwork, artwork, "after a reference session");
		assert.strictEqual(parseRecording(bytes).sessions.length, 5);

		// A referenced file that can't be fetched, or that isn't what the editor opened, is reported as drift (so the
		// page can show the finished picture at the end) and the rest still plays
		for (let fetchReference of [() => Promise.reject(new Error("404")), () => Promise.resolve(chiBytes)]) {
			let
				drifts = [];

			player = await replay(bytes, {fetch: fetchReference, onDrift: drift => drifts.push(drift)});
			assert.strictEqual(drifts.length, 1);
			assert.strictEqual(drifts[0].session, 4);
			assert.strictEqual(drifts[0].at, "start");
			assert(player.isDone());
		}
	});

	it("should refer to an opened flat image (PNG) instead of storing it", async function() {
		let
			random = mulberry32(12),
			clock = makeClock(),
			original = newBlankArtwork(40, 30),
			driver = new Driver(original, random, clock);

		driver.run(30);

		let
			fusion = original.fusionLayers(),
			png = encodePNG(fusion.width, fusion.height, fusion.data, 4),
			artwork = flatRoundTrip(original, 0),
			recorder = new CPRecorder(artwork, {clock: clock, sourceUrl: "https://example.com/v1.png", sourceFormat: SOURCE_PNG});

		assert.strictEqual(recorder.startKind, START_REFERENCE);
		driver = new Driver(artwork, random, clock);
		driver.run(30);

		let
			bytes = recorder.getRecording(),
			player = await replay(bytes, {fetch: () => Promise.resolve(png)});

		assert.strictEqual(parseRecording(bytes).sessions[0].snapshot, null);
		assert.deepStrictEqual(player.drift, []);
		assertSameDocument(player.artwork, artwork, "after a PNG reference session");
	});

	it("should start over with a snapshot when the drawing doesn't match a non-blank start", async function() {
		let
			random = mulberry32(7),
			clock = makeClock(),
			artwork = newBlankArtwork(40, 30);

		artwork.addLayer("group");
		artwork.addLayer("layer");
		artwork.addLayerMask();
		artwork.getActiveLayer().mask.data[3] = 7;
		artwork.getActiveLayer().image.data[3] = 9;

		let
			recorder = new CPRecorder(artwork, {clock: clock}),
			driver = new Driver(artwork, random, clock);

		assert.strictEqual(recorder.startKind, START_SNAPSHOT);
		driver.run(50);

		let
			player = await replay(recorder.getRecording());

		assert.deepStrictEqual(player.drift, []);
		assertSameDocument(player.artwork, artwork, "snapshot start");
	});

	it("should give the whole recording again on each send, without duplicating the session", async function() {
		let
			random = mulberry32(8),
			clock = makeClock(),
			artwork = newBlankArtwork(40, 30),
			recorder = new CPRecorder(artwork, {clock: clock}),
			driver = new Driver(artwork, random, clock);

		driver.run(30);
		let
			first = recorder.getRecording();

		driver.run(30);
		let
			second = recorder.getRecording(),
			parsed = parseRecording(second);

		assert.strictEqual(parsed.sessions.length, 1);
		assert(second.length > first.length);
		assert.strictEqual(parseRecording(first).sessions[0].end.eventCount < parsed.sessions[0].end.eventCount, true);

		let
			player = await replay(second);

		assertSameDocument(player.artwork, artwork, "second send");
	});

	it("should mark the session truncated when it gets too long, and not continue from it", async function() {
		let
			random = mulberry32(9),
			clock = makeClock(),
			artwork = newBlankArtwork(40, 30),
			recorder = new CPRecorder(artwork, {clock: clock, maxEvents: 50}),
			driver = new Driver(artwork, random, clock);

		driver.run(100);
		assert(recorder.isTruncated());

		let
			bytes = recorder.getRecording(),
			file = parseRecording(bytes);

		assert.strictEqual(file.sessions[0].end.truncated, true);
		assert.strictEqual(file.sessions[0].end.eventCount, 50);

		// The player plays what there is
		let
			player = await replay(bytes);

		assert(player.isDone());
		assert.deepStrictEqual(player.drift.map(drift => drift.at), ["truncated"], "a truncated session can't reach the saved drawing");

		// The next session can't continue from a truncated one
		artwork = await chiRoundTrip(artwork);
		recorder = new CPRecorder(artwork, {previous: bytes, clock: clock});
		assert.strictEqual(recorder.startKind, START_SNAPSHOT);

		// And a recording too large for the file limit isn't returned at all
		recorder = new CPRecorder(newBlankArtwork(40, 30), {maxBytes: 10});
		assert.strictEqual(recorder.getRecording(), null);
	});

	it("should report drift when the replay doesn't match", async function() {
		let
			random = mulberry32(10),
			clock = makeClock(),
			artwork = newBlankArtwork(40, 30),
			recorder = new CPRecorder(artwork, {clock: clock, checkpointInterval: 5}),
			driver = new Driver(artwork, random, clock);

		driver.run(40);

		// Sneak in a change the recorder can't see
		artwork.getActiveLayer().image && (artwork.getActiveLayer().image.data[0] ^= 1);
		layerList(artwork).filter(layer => layer instanceof CPImageLayer)[0].image.data[1] ^= 1;

		let
			drifts = [],
			player = await replay(recorder.getRecording(), {onDrift: drift => drifts.push(drift)});

		assert(player.drift.length > 0);
		assert.strictEqual(drifts.length, 1);
	});

	it("should use input only (no pixels) for ordinary painting", function() {
		let
			random = mulberry32(11),
			clock = makeClock(),
			artwork = newBlankArtwork(200, 150),
			recorder = new CPRecorder(artwork, {clock: clock}),
			driver = new Driver(artwork, random, clock);

		for (let i = 0; i < 200; i++) {
			driver.step();
		}

		let
			bytes = recorder.getRecording(),
			file = parseRecording(bytes),
			ops = new Set();

		for (let payload of file.sessions[0].eventChunks) {
			for (let event of decodeEvents(payload)) {
				ops.add(event.op);
			}
		}
		assert(ops.has(OP.STROKE_BEGIN));
		assert(ops.has(OP.CHECKPOINT));
	});
});
