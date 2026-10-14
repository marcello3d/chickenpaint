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
 * A small exact PNG encoder/decoder (8 bits per channel, no interlacing on encode).
 *
 * Unlike canvas.toDataURL() and drawing an <img> to a canvas, this never premultiplies alpha, so the pixels round-trip
 * exactly, and it works the same in every browser and in Node. Drawing recordings store their bitmaps with it.
 */

import pako from "pako";
import {crc32, concatBytes} from "./CPByteStream.js";

const
    PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function chunk(type, data) {
    let
        out = new Uint8Array(12 + data.length),
        view = new DataView(out.buffer);

    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) {
        out[4 + i] = type.charCodeAt(i);
    }
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));

    return out;
}

function paeth(a, b, c) {
    let
        p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);

    if (pa <= pb && pa <= pc) {
        return a;
    }
    return pb <= pc ? b : c;
}

/**
 * Encode 8-bit pixels as a PNG.
 *
 * @param {int} width
 * @param {int} height
 * @param {Uint8Array|Uint8ClampedArray} data - Pixels, row-major, `channels` bytes per pixel
 * @param {int} channels - 1 for greyscale, 4 for RGBA
 *
 * @returns {Uint8Array}
 */
export function encodePNG(width, height, data, channels) {
    let
        stride = width * channels,
        raw = new Uint8Array((stride + 1) * height),
        candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride)),
        zeroRow = new Uint8Array(stride);

    for (let y = 0; y < height; y++) {
        let
            row = data.subarray(y * stride, (y + 1) * stride),
            prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : zeroRow,
            bestFilter = 0,
            bestScore = Infinity;

        // Adaptive filtering: pick the filter with the smallest sum of absolute (signed) residuals
        for (let filter = 0; filter < 5; filter++) {
            let
                out = candidates[filter],
                score = 0;

            for (let x = 0; x < stride; x++) {
                let
                    a = x >= channels ? row[x - channels] : 0,
                    b = prev[x],
                    c = x >= channels ? prev[x - channels] : 0,
                    v;

                switch (filter) {
                    case 0: v = row[x]; break;
                    case 1: v = row[x] - a; break;
                    case 2: v = row[x] - b; break;
                    case 3: v = row[x] - ((a + b) >> 1); break;
                    default: v = row[x] - paeth(a, b, c);
                }

                v &= 0xff;
                out[x] = v;
                score += v < 128 ? v : 256 - v;
            }

            if (score < bestScore) {
                bestScore = score;
                bestFilter = filter;
            }
        }

        raw[y * (stride + 1)] = bestFilter;
        raw.set(candidates[bestFilter], y * (stride + 1) + 1);
    }

    let
        header = new Uint8Array(13),
        headerView = new DataView(header.buffer);

    headerView.setUint32(0, width);
    headerView.setUint32(4, height);
    header[8] = 8; // bit depth
    header[9] = channels === 1 ? 0 : 6; // greyscale or RGBA
    header[10] = 0; // deflate
    header[11] = 0; // adaptive filtering
    header[12] = 0; // no interlace

    return concatBytes([
        PNG_SIGNATURE,
        chunk("IHDR", header),
        chunk("IDAT", pako.deflate(raw, {level: 6})), // level 9 is ~5-8x slower on large images for ~5% smaller files
        chunk("IEND", new Uint8Array(0))
    ]);
}

/**
 * Decode a non-interlaced, 8 bits per channel PNG (greyscale, RGB, palette, grey+alpha or RGBA).
 *
 * @param {Uint8Array} bytes
 * @returns {{width: int, height: int, channels: int, data: Uint8Array}} - Greyscale images decode to one channel,
 *                                                                           everything else to RGBA.
 */
export function decodePNG(bytes) {
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
        if (bytes[i] !== PNG_SIGNATURE[i]) {
            throw new Error("Not a PNG");
        }
    }

    let
        view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        pos = PNG_SIGNATURE.length,
        width = 0, height = 0, colorType = -1,
        palette = null, transparency = null,
        idat = [];

    while (pos + 8 <= bytes.length) {
        let
            length = view.getUint32(pos),
            type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]),
            data = bytes.subarray(pos + 8, pos + 8 + length);

        if (pos + 12 + length > bytes.length) {
            throw new Error("Truncated PNG");
        }

        switch (type) {
            case "IHDR":
                width = view.getUint32(pos + 8);
                height = view.getUint32(pos + 12);
                colorType = data[9];
                if (data[8] !== 8 || data[12] !== 0) {
                    throw new Error("Unsupported PNG (bit depth " + data[8] + ", interlace " + data[12] + ")");
                }
                break;
            case "PLTE":
                palette = data;
                break;
            case "tRNS":
                transparency = data;
                break;
            case "IDAT":
                idat.push(data);
                break;
        }

        pos += 12 + length;

        if (type === "IEND") {
            break;
        }
    }

    let
        srcChannels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colorType];

    if (!srcChannels || width <= 0 || height <= 0) {
        throw new Error("Unsupported PNG color type " + colorType);
    }

    let
        raw = pako.inflate(concatBytes(idat)),
        stride = width * srcChannels,
        pixels = new Uint8Array(stride * height),
        zeroRow = new Uint8Array(stride);

    if (raw.length < (stride + 1) * height) {
        throw new Error("Truncated PNG data");
    }

    for (let y = 0; y < height; y++) {
        let
            filter = raw[y * (stride + 1)],
            src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)),
            row = pixels.subarray(y * stride, (y + 1) * stride),
            prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : zeroRow;

        for (let x = 0; x < stride; x++) {
            let
                a = x >= srcChannels ? row[x - srcChannels] : 0,
                b = prev[x],
                c = x >= srcChannels ? prev[x - srcChannels] : 0,
                v = src[x];

            switch (filter) {
                case 0: break;
                case 1: v += a; break;
                case 2: v += b; break;
                case 3: v += (a + b) >> 1; break;
                case 4: v += paeth(a, b, c); break;
                default:
                    throw new Error("Bad PNG filter " + filter);
            }
            row[x] = v;
        }
    }

    if (colorType === 0 && !transparency) {
        return {width, height, channels: 1, data: pixels};
    }

    let
        n = width * height,
        rgba = new Uint8Array(n * 4);

    for (let i = 0; i < n; i++) {
        let
            r, g, b, alpha = 255;

        switch (colorType) {
            case 0:
                r = g = b = pixels[i];
                if (transparency.length >= 2 && ((transparency[0] << 8) | transparency[1]) === r) {
                    alpha = 0;
                }
                break;
            case 2:
                r = pixels[i * 3];
                g = pixels[i * 3 + 1];
                b = pixels[i * 3 + 2];
                if (transparency && transparency.length >= 6 && ((transparency[0] << 8) | transparency[1]) === r
                        && ((transparency[2] << 8) | transparency[3]) === g && ((transparency[4] << 8) | transparency[5]) === b) {
                    alpha = 0;
                }
                break;
            case 3: {
                let
                    index = pixels[i];

                if (!palette || index * 3 + 2 >= palette.length) {
                    throw new Error("Bad PNG palette index");
                }
                r = palette[index * 3];
                g = palette[index * 3 + 1];
                b = palette[index * 3 + 2];
                if (transparency && index < transparency.length) {
                    alpha = transparency[index];
                }
                break;
            }
            case 4:
                r = g = b = pixels[i * 2];
                alpha = pixels[i * 2 + 1];
                break;
            default:
                r = pixels[i * 4];
                g = pixels[i * 4 + 1];
                b = pixels[i * 4 + 2];
                alpha = pixels[i * 4 + 3];
        }

        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = alpha;
    }

    return {width, height, channels: 4, data: rgba};
}
