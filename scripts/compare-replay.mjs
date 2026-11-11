// Replays recordings with two copies of the engine and checks that they rebuild exactly the same drawing: every layer's
// pixels and mask, the layer table, the composite, and the undo history (each undo step's pixels too).
//
//   node scripts/compare-replay.mjs <oldRoot> <newRoot> [file.chiani ...]
//
// <oldRoot> and <newRoot> are checkouts of this repository (each with js/engine/CPBlend.js generated, e.g. by
// `make all`, and node_modules: link the same one). <oldRoot> replays as rebuildFromRecording did before
// (keyframeMemory 0), <newRoot> as it does now (no keyframes, verify off, the composite merged at the end in bands).
// Besides the files given, it records
// synthetic drawings (several sizes, with layers, masks, blend modes, textures, all brush tips, flood fills, undo and
// redo) with <newRoot>'s recorder. Exits 1 on any difference.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [oldRoot, newRoot, ...files] = process.argv.slice(2);
if (!oldRoot || !newRoot) {
	console.error("usage: node scripts/compare-replay.mjs <oldRoot> <newRoot> [file.chiani ...]");
	process.exit(2);
}

async function loadEngine(root) {
	const load = (p) => import(pathToFileURL(path.resolve(root, p)).href);
	return {
		CPArtwork: (await load("js/engine/CPArtwork.js")).default,
		CPBrushInfo: (await load("js/engine/CPBrushInfo.js")).default,
		CPGreyBmp: (await load("js/engine/CPGreyBmp.js")).default,
		CPRecorder: (await load("js/engine/CPRecorder.js")).default,
		CPRecordingPlayer: (await load("js/engine/CPRecordingPlayer.js")).default,
		CPBlend: (await load("js/engine/CPBlend.js")).default,
		fmt: await load("js/engine/CPRecordingFormat.js"),
	};
}

const OLD = await loadEngine(oldRoot), NEW = await loadEngine(newRoot);

function mulberry32(seed) {
	return function () {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A synthetic drawing, recorded with E's recorder. */
function synthetic(E, { width, height, strokes, seed }) {
	const random = mulberry32(seed);
	let time = 0;
	const clock = () => time;
	const art = new E.CPArtwork(width, height);
	art.addBackgroundLayer();
	const recorder = new E.CPRecorder(art, { clock, checkpointInterval: 50 });
	const B = E.CPBlend;
	const layers = [art.getLayersRoot().layers[0]];
	const add = (kind) => {
		const l = art.addLayer(kind);
		art.setActiveLayer(l, false);
		layers.push(l);
		return l;
	};
	add("layer");
	add("group");
	art.setLayerBlendMode(B.LM_MULTIPLY);
	art.setLayerAlpha(80);
	art.addLayerMask();
	add("layer");
	art.addLayerMask();
	add("layer");
	art.setLayerBlendMode(B.LM_SCREEN);
	art.createClippingMask();
	add("layer");
	art.setLayerBlendMode(B.LM_OVERLAY);
	art.setLayerAlpha(70);
	add("layer");
	art.setLayerBlendMode(B.LM_SOFTLIGHT);
	const paintable = layers.filter((l) => l.image);

	const texture = new E.CPGreyBmp(37, 23, 8);
	for (let i = 0; i < texture.data.length; i++) texture.data[i] = Math.floor(random() * 256);

	for (let s = 0; s < strokes; s++) {
		time += 300 + Math.floor(random() * 500);
		if (random() < 0.1) {
			const l = paintable[Math.floor(random() * paintable.length)];
			art.setActiveLayer(l, !!l.mask && random() < 0.25);
		}
		if (random() < 0.3) art.setForegroundColor(Math.floor(random() * 0x1000000));
		if (random() < 0.05) art.setBrushTexture(random() < 0.6 ? texture : null);
		if (random() < 0.03) {
			art.floodFill(Math.floor(random() * width), Math.floor(random() * height));
			continue;
		}
		const size = 1 + Math.floor(random() ** 2 * 90);
		art.setBrush(new E.CPBrushInfo({
			size, alpha: 40 + Math.floor(random() * 216), spacing: 0.05 + random() * 0.2,
			tip: Math.floor(random() * 5), isAA: random() < 0.8, brushMode: [0, 0, 0, 1, 4, 5, 6][Math.floor(random() * 7)],
			paintMode: random() < 0.5 ? 0 : 1, pressureSize: random() < 0.5, pressureAlpha: random() < 0.3,
			texture: random() < 0.5 ? random() : 1, resat: random(), bleed: random(), alphaScale: 1,
			squeeze: random() < 0.2 ? random() * 0.8 : 0, angle: random() * 2 * Math.PI,
		}));
		let x = width * random(), y = height * random(), a = random() * 2 * Math.PI, p = 0.3 + random() * 0.7;
		const n = 5 + Math.floor(random() * 40);
		if (art.beginStroke(x, y, p)) {
			for (let i = 1; i < n; i++) {
				time += 8;
				a += (random() - 0.5) * 0.6;
				x += Math.cos(a) * (2 + size * 0.2);
				y += Math.sin(a) * (2 + size * 0.2);
				p = Math.max(0.05, Math.min(1, p + (random() - 0.5) * 0.2));
				art.continueStroke(x, y, p);
			}
			art.endStroke();
			art.fusionLayers();
		}
		if (random() < 0.05) {
			art.undo();
			if (random() < 0.5) art.redo();
		}
	}
	return recorder.getRecording({ rotation: 0 });
}

async function rebuild(E, bytes, isNew) {
	const options = isNew ? { keyframeMemory: 0, keyframeInterval: 0, verify: false, fuseAfterStrokes: false } : { keyframeMemory: 0 };
	const player = new E.CPRecordingPlayer(bytes, options);
	// The new code lays the timeline out in slices, as ChickenPaint does
	await (isNew ? player.prepare((callback) => setImmediate(callback)) : player.prepare());
	const started = performance.now();
	if (isNew) {
		// As ChickenPaint replays it now: in slices
		while (!player.advanceTo(Infinity, 12)) {}
	}
	const artwork = player.finishForEditing();
	// The composite: the new code merges it at the end, in bands of rows; the old one kept it up to date
	if (isNew) await artwork.fusionLayersInSlices(12, (callback) => setImmediate(callback));
	return { artwork, ms: performance.now() - started };
}

/** Every layer's pixels, mask and properties, as one string to compare */
function describe(E, artwork) {
	const parts = [artwork.width + "x" + artwork.height];
	E.fmt.forEachLayer(artwork.getLayersRoot(), (layer) => {
		parts.push(JSON.stringify([layer.name, layer.alpha, layer.blendMode, layer.visible, layer.clip, layer.lockAlpha, layer.maskLinked, layer.maskVisible, layer.expanded]));
		if (layer.image) parts.push("i" + E.fmt.hashImage(layer.image.width, layer.image.height, layer.image.data) + ":" + layer.image.data.length);
		if (layer.mask) parts.push("m" + E.fmt.hashImage(layer.mask.width, layer.mask.height, layer.mask.data) + ":" + layer.mask.data.length);
	});
	const fusion = artwork.fusionLayers();
	parts.push("fusion " + E.fmt.hashImage(fusion.width, fusion.height, fusion.data));
	const active = artwork.getActiveLayer();
	parts.push("active " + (active && active.name) + " " + artwork.isEditingMask());
	return parts.join("|");
}

/** The drawing, then after each undo (up to 40), then after redoing them all */
function history(E, artwork) {
	const info = artwork.getHistoryInfo(), states = [describe(E, artwork) + " undo " + info.undoDepth + " redo " + info.redoDepth];
	let undone = 0;
	while (undone < 40 && artwork.getHistoryInfo().undoDepth > 0) {
		artwork.undo();
		undone++;
		states.push(describe(E, artwork));
	}
	for (let i = 0; i < undone; i++) artwork.redo();
	states.push(describe(E, artwork));
	return states;
}

const cases = files.map((file) => ({ name: path.basename(file), bytes: new Uint8Array(fs.readFileSync(file)) }));
for (const [width, height, strokes, seed] of [[400, 300, 60, 1], [800, 600, 300, 2], [1200, 1000, 600, 3], [1100, 900, 1500, 4], [640, 480, 200, 5]]) {
	cases.push({ name: `synthetic ${width}x${height} ${strokes} strokes`, bytes: synthetic(NEW, { width, height, strokes, seed }) });
}

let failures = 0;
for (const c of cases) {
	const before = await rebuild(OLD, c.bytes, false);
	const after = await rebuild(NEW, c.bytes, true);
	const a = history(OLD, before.artwork), b = history(NEW, after.artwork);
	const diff = a.findIndex((s, i) => s !== b[i]);
	const same = a.length === b.length && diff < 0;
	if (!same) failures++;
	console.log(`${same ? "same" : "DIFFERENT"}  ${c.name}  (${a.length - 2} undo steps checked; old ${Math.round(before.ms)} ms, new ${Math.round(after.ms)} ms)${same ? "" : " first difference at state " + diff}`);
}
console.log(failures ? `${failures} differ` : "all identical");
process.exit(failures ? 1 : 0);
