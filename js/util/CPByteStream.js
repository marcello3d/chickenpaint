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
 * Growable byte writer and reader with the primitives of the drawing recording format (docs/recording-format.md):
 * big-endian fixed-width integers, unsigned LEB128 varints, zigzag signed varints, and length-prefixed blobs and UTF-8
 * strings.
 *
 * Ported from the Lascaux animation format's web/src/anim/bytes.ts (by Marcello Bastéa-Forte, contributed here under
 * ChickenPaint's licence), so that the two formats share their encodings.
 */

const
    utf8Encoder = new TextEncoder(),
    utf8Decoder = new TextDecoder("utf-8");

export class ByteWriter {
    /**
     * @param {int} [initial] - Initial capacity in bytes
     */
    constructor(initial) {
        this.buf = new Uint8Array(initial || 1024);
        this.length = 0;
    }

    ensure(n) {
        if (this.length + n <= this.buf.length) {
            return;
        }

        let
            size = this.buf.length * 2;

        while (size < this.length + n) {
            size *= 2;
        }

        let
            next = new Uint8Array(size);

        next.set(this.buf.subarray(0, this.length));
        this.buf = next;
    }

    u8(v) {
        this.ensure(1);
        this.buf[this.length++] = v & 0xff;
    }

    /**
     * Big-endian 24-bit unsigned (e.g. an RGB color).
     */
    u24(v) {
        this.ensure(3);
        this.buf[this.length++] = v >>> 16;
        this.buf[this.length++] = v >>> 8;
        this.buf[this.length++] = v;
    }

    /**
     * Big-endian 32-bit unsigned.
     */
    u32(v) {
        this.ensure(4);

        let
            b = this.buf,
            o = this.length;

        b[o++] = v >>> 24;
        b[o++] = v >>> 16;
        b[o++] = v >>> 8;
        b[o++] = v;
        this.length = o;
    }

    /**
     * Unsigned LEB128 (any non-negative integer up to 2^53).
     */
    varint(v) {
        if (!(v >= 0) || !Number.isSafeInteger(v)) {
            throw new Error("varint out of range: " + v);
        }
        while (v >= 0x80) {
            this.u8((v & 0x7f) | 0x80);
            v = Math.floor(v / 128);
        }
        this.u8(v);
    }

    /**
     * Zigzag signed LEB128.
     */
    svarint(v) {
        this.varint(v < 0 ? -2 * v - 1 : 2 * v);
    }

    /**
     * Big-endian IEEE-754 double.
     */
    f64(v) {
        this.ensure(8);
        new DataView(this.buf.buffer, this.buf.byteOffset + this.length, 8).setFloat64(0, v);
        this.length += 8;
    }

    /**
     * A number: an integer below 2^40 in magnitude as one varint (zigzag value times 2), anything else as the varint
     * 1 followed by a double.
     */
    num(v) {
        if (Number.isSafeInteger(v) && Math.abs(v) < 2 ** 40 && !Object.is(v, -0)) {
            this.varint((v < 0 ? -2 * v - 1 : 2 * v) * 2);
        } else {
            this.varint(1);
            this.f64(v);
        }
    }

    bytes(b) {
        this.ensure(b.length);
        this.buf.set(b, this.length);
        this.length += b.length;
    }

    /**
     * Length-prefixed byte string.
     */
    blob(b) {
        this.varint(b.length);
        this.bytes(b);
    }

    /**
     * Length-prefixed UTF-8 string.
     */
    string(s) {
        this.blob(utf8Encoder.encode(s));
    }

    /**
     * A view of the bytes written so far (invalidated by further writes).
     *
     * @returns {Uint8Array}
     */
    view() {
        return this.buf.subarray(0, this.length);
    }

    /**
     * @returns {Uint8Array}
     */
    toBytes() {
        return this.buf.slice(0, this.length);
    }
}

export class ByteReader {
    /**
     * @param {Uint8Array} b
     */
    constructor(b) {
        this.b = b;
        this.pos = 0;
    }

    get remaining() {
        return this.b.length - this.pos;
    }

    need(n) {
        if (this.pos + n > this.b.length) {
            throw new Error("truncated data");
        }
    }

    u8() {
        this.need(1);
        return this.b[this.pos++];
    }

    u24() {
        this.need(3);

        let
            b = this.b,
            o = this.pos;

        this.pos += 3;
        return (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
    }

    u32() {
        this.need(4);

        let
            b = this.b,
            o = this.pos;

        this.pos += 4;
        return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    }

    varint() {
        let
            v = 0,
            scale = 1;

        for (let i = 0; i < 8; i++) {
            let
                byte = this.u8();

            v += (byte & 0x7f) * scale;
            if (!(byte & 0x80)) {
                return v;
            }
            scale *= 128;
        }
        throw new Error("varint too long");
    }

    svarint() {
        let
            v = this.varint();

        return v % 2 === 1 ? -(v + 1) / 2 : v / 2;
    }

    f64() {
        this.need(8);

        let
            v = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 8).getFloat64(0);

        this.pos += 8;
        return v;
    }

    num() {
        let
            tag = this.varint();

        if (tag === 1) {
            return this.f64();
        }

        let
            z = tag / 2;

        return z % 2 === 1 ? -(z + 1) / 2 : z / 2;
    }

    bytes(n) {
        this.need(n);

        let
            out = this.b.subarray(this.pos, this.pos + n);

        this.pos += n;
        return out;
    }

    blob() {
        return this.bytes(this.varint());
    }

    string() {
        return utf8Decoder.decode(this.blob());
    }
}

/**
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
export function concatBytes(parts) {
    let
        out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)),
        o = 0;

    for (let p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

let
    crcTable = null;

/**
 * CRC-32 (as used by PNG and zlib).
 *
 * @param {Uint8Array} bytes
 * @param {int} [crc] - Running CRC from a previous call, to continue over several arrays
 * @returns {int} unsigned 32-bit CRC
 */
export function crc32(bytes, crc) {
    if (!crcTable) {
        crcTable = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let
                c = n;

            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            crcTable[n] = c;
        }
    }

    let
        c = (crc === undefined ? 0 : crc) ^ -1;

    for (let i = 0; i < bytes.length; i++) {
        c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ -1) >>> 0;
}
