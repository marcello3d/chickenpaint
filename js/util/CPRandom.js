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

import {log} from "./CPMath.js";

/**
 * A seedable pseudo-random number generator (mulberry32), so that operations which use randomness (brush scattering,
 * noise fills) can be replayed exactly by a drawing recording.
 *
 * @param {int} [seed] - Initial seed, or omit to seed from Math.random()
 * @constructor
 */
export default function CPRandom(seed) {
    var
        state = 0,
        nextNextGaussian,
        haveNextNextGaussian = false;

    /**
     * Restart the sequence from the given seed.
     *
     * @param {int} seed - 32-bit integer
     */
    this.setSeed = function(seed) {
        state = seed | 0;
        haveNextNextGaussian = false;
    };

    /**
     * @returns {number} A number in the range [0, 1)
     */
    this.nextDouble = function() {
        state = (state + 0x6D2B79F5) | 0;

        var
            t = Math.imul(state ^ (state >>> 15), 1 | state);

        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    /**
     * Definition from Java, mean of 0.0 and standard deviation 1.0.
     */
    this.nextGaussian = function() {
        if (haveNextNextGaussian) {
            haveNextNextGaussian = false;
            return nextNextGaussian;
        } else {
            
            var
                v1, v2, s;
            
            do {
                v1 = 2 * this.nextDouble() - 1; // between -1.0 and 1.0
                v2 = 2 * this.nextDouble() - 1; // between -1.0 and 1.0
                s = v1 * v1 + v2 * v2;
            } while (s >= 1 || s == 0);
            
            var
                multiplier = Math.sqrt(-2 * log(s) / s);
            
            nextNextGaussian = v2 * multiplier;
            haveNextNextGaussian = true;
            
            return v1 * multiplier;
        }
    };

    this.setSeed(seed === undefined ? (Math.random() * 0x100000000) | 0 : seed);
}
