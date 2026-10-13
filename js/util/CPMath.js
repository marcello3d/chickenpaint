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
 * Deterministic replacements for Math.sin, Math.cos and Math.log.
 *
 * The ECMAScript spec lets every browser approximate these functions differently, so the same brush stroke could
 * produce different pixels in Chrome and in Safari. That would break drawing recordings, which are replayed by
 * running the brush engine again. These are JavaScript ports of the fdlibm 5.3 routines (the ones V8 itself uses),
 * built only from IEEE-754 double arithmetic, which every engine performs identically.
 *
 * fdlibm: Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 * Developed at SunPro, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice
 * is preserved.
 */

const
    float64 = new Float64Array(1),
    uint32 = new Uint32Array(float64.buffer),
    LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1,
    HI = LITTLE_ENDIAN ? 1 : 0,
    LO = LITTLE_ENDIAN ? 0 : 1;

function highWord(x) {
    float64[0] = x;
    return uint32[HI] | 0;
}

function lowWord(x) {
    float64[0] = x;
    return uint32[LO] | 0;
}

function fromWords(hi, lo) {
    uint32[HI] = hi;
    uint32[LO] = lo;
    return float64[0];
}

function withHighWord(x, hi) {
    float64[0] = x;
    uint32[HI] = hi;
    return float64[0];
}

const
    S1 = -1.66666666666666324348e-01,
    S2 = 8.33333333332248946124e-03,
    S3 = -1.98412698298579493134e-04,
    S4 = 2.75573137070700676789e-06,
    S5 = -2.50507602534068634195e-08,
    S6 = 1.58969099521155010221e-10,

    C1 = 4.16666666666666019037e-02,
    C2 = -1.38888888888741095749e-03,
    C3 = 2.48015872894767294178e-05,
    C4 = -2.75573143513906633035e-07,
    C5 = 2.08757232129817482790e-09,
    C6 = -1.13596475577881948265e-11,

    INV_PIO2 = 6.36619772367581382433e-01,
    PIO2_1 = 1.57079632673412561417e+00,
    PIO2_1T = 6.07710050650619224932e-11,
    PIO2_2 = 6.07710050630396597660e-11,
    PIO2_2T = 2.02226624879595063154e-21,
    PIO2_3 = 2.02226624871116645580e-21,
    PIO2_3T = 8.47842766036889956997e-32;

function kernelSin(x, y, iy) {
    let
        ix = highWord(x) & 0x7fffffff;

    if (ix < 0x3e400000 && (x | 0) === 0) {
        return x;
    }

    let
        z = x * x,
        v = z * x,
        r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));

    if (iy === 0) {
        return x + v * (S1 + z * r);
    }
    return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

function kernelCos(x, y) {
    let
        ix = highWord(x) & 0x7fffffff;

    if (ix < 0x3e400000 && (x | 0) === 0) {
        return 1.0;
    }

    let
        z = x * x,
        r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));

    if (ix < 0x3fd33333) {
        return 1.0 - (0.5 * z - (z * r - x * y));
    }

    let
        qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0),
        hz = 0.5 * z - qx,
        a = 1.0 - qx;

    return a - (hz - (z * r - x * y));
}

const
    reduced = [0, 0];

/**
 * Reduce x into [-pi/4, pi/4], storing the result as the sum reduced[0] + reduced[1], and return the quadrant.
 *
 * Uses fdlibm's medium-size Cody-Waite reduction, which is exact for |x| < 2^19 * pi/2 (far beyond any angle a brush
 * uses) and still deterministic, if less accurate, beyond that.
 */
function remPio2(x) {
    let
        hx = highWord(x),
        ix = hx & 0x7fffffff;

    if (ix < 0x4002d97c) {
        // |x| < 3pi/4, special case with n = +-1
        let
            z;

        if (hx > 0) {
            z = x - PIO2_1;
            if (ix !== 0x3ff921fb) {
                reduced[0] = z - PIO2_1T;
                reduced[1] = (z - reduced[0]) - PIO2_1T;
            } else {
                z -= PIO2_2;
                reduced[0] = z - PIO2_2T;
                reduced[1] = (z - reduced[0]) - PIO2_2T;
            }
            return 1;
        } else {
            z = x + PIO2_1;
            if (ix !== 0x3ff921fb) {
                reduced[0] = z + PIO2_1T;
                reduced[1] = (z - reduced[0]) + PIO2_1T;
            } else {
                z += PIO2_2;
                reduced[0] = z + PIO2_2T;
                reduced[1] = (z - reduced[0]) + PIO2_2T;
            }
            return -1;
        }
    }

    let
        t = Math.abs(x),
        n = (t * INV_PIO2 + 0.5) | 0,
        fn = n,
        r = t - fn * PIO2_1,
        w = fn * PIO2_1T,
        j = ix >> 20,
        y0 = r - w,
        i = j - ((highWord(y0) >> 20) & 0x7ff);

    if (i > 16) {
        // 2nd iteration needed, good to 118 bits
        t = r;
        w = fn * PIO2_2;
        r = t - w;
        w = fn * PIO2_2T - ((t - r) - w);
        y0 = r - w;
        i = j - ((highWord(y0) >> 20) & 0x7ff);

        if (i > 49) {
            // 3rd iteration, 151 bits
            t = r;
            w = fn * PIO2_3;
            r = t - w;
            w = fn * PIO2_3T - ((t - r) - w);
            y0 = r - w;
        }
    }

    let
        y1 = (r - y0) - w;

    if (hx < 0) {
        reduced[0] = -y0;
        reduced[1] = -y1;
        return -n;
    }

    reduced[0] = y0;
    reduced[1] = y1;
    return n;
}

/**
 * Deterministic sine (fdlibm s_sin.c).
 *
 * @param {number} x
 * @returns {number}
 */
export function sin(x) {
    let
        ix = highWord(x) & 0x7fffffff;

    if (ix <= 0x3fe921fb) {
        return kernelSin(x, 0, 0);
    }
    if (ix >= 0x7ff00000) {
        return NaN;
    }

    let
        n = remPio2(x);

    switch (n & 3) {
        case 0:
            return kernelSin(reduced[0], reduced[1], 1);
        case 1:
            return kernelCos(reduced[0], reduced[1]);
        case 2:
            return -kernelSin(reduced[0], reduced[1], 1);
        default:
            return -kernelCos(reduced[0], reduced[1]);
    }
}

/**
 * Deterministic cosine (fdlibm s_cos.c).
 *
 * @param {number} x
 * @returns {number}
 */
export function cos(x) {
    let
        ix = highWord(x) & 0x7fffffff;

    if (ix <= 0x3fe921fb) {
        return kernelCos(x, 0);
    }
    if (ix >= 0x7ff00000) {
        return NaN;
    }

    let
        n = remPio2(x);

    switch (n & 3) {
        case 0:
            return kernelCos(reduced[0], reduced[1]);
        case 1:
            return -kernelSin(reduced[0], reduced[1], 1);
        case 2:
            return -kernelCos(reduced[0], reduced[1]);
        default:
            return kernelSin(reduced[0], reduced[1], 1);
    }
}

const
    LN2_HI = 6.93147180369123816490e-01,
    LN2_LO = 1.90821492927058770002e-10,
    TWO54 = 1.80143985094819840000e+16,
    LG1 = 6.666666666666735130e-01,
    LG2 = 3.999999999940941908e-01,
    LG3 = 2.857142874366239149e-01,
    LG4 = 2.222219843214978396e-01,
    LG5 = 1.818357216161805012e-01,
    LG6 = 1.531383769920937332e-01,
    LG7 = 1.479819860511658591e-01;

/**
 * Deterministic natural logarithm (fdlibm e_log.c).
 *
 * @param {number} x
 * @returns {number}
 */
export function log(x) {
    let
        hx = highWord(x),
        lx = lowWord(x),
        k = 0;

    if (hx < 0x00100000) {
        // x < 2^-1022
        if (((hx & 0x7fffffff) | lx) === 0) {
            return -Infinity;
        }
        if (hx < 0) {
            return NaN;
        }
        // subnormal, scale up x
        k -= 54;
        x *= TWO54;
        hx = highWord(x);
    }
    if (hx >= 0x7ff00000) {
        return x + x;
    }

    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;

    let
        i = (hx + 0x95f64) & 0x100000;

    x = withHighWord(x, hx | (i ^ 0x3ff00000)); // normalize x or x/2
    k += i >> 20;

    let
        f = x - 1.0;

    if ((0x000fffff & (2 + hx)) < 3) {
        // |f| < 2^-20
        if (f === 0) {
            return k === 0 ? 0 : k * LN2_HI + k * LN2_LO;
        }

        let
            R = f * f * (0.5 - 0.33333333333333333 * f);

        return k === 0 ? f - R : k * LN2_HI - ((R - k * LN2_LO) - f);
    }

    let
        s = f / (2.0 + f),
        dk = k,
        z = s * s,
        w = z * z,
        t1 = w * (LG2 + w * (LG4 + w * LG6)),
        t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7))),
        R = t2 + t1;

    i = (hx - 0x6147a) | (0x6b851 - hx);

    if (i > 0) {
        let
            hfsq = 0.5 * f * f;

        if (k === 0) {
            return f - (hfsq - s * (hfsq + R));
        }
        return dk * LN2_HI - ((hfsq - (s * (hfsq + R) + dk * LN2_LO)) - f);
    }

    if (k === 0) {
        return f - s * (f - R);
    }
    return dk * LN2_HI - ((s * (f - R) - dk * LN2_LO) - f);
}
