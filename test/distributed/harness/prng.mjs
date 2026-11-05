// @ts-check
/**
 * The run's seeded choices. `mulberry32` is a 32-bit PRNG; the same seed and the same sequence of calls give the same
 * targets, parameters and orderings, which is what a replay reproduces. It cannot reproduce Azure scheduling or
 * packet timing.
 */

export const PRNG_NAME = "mulberry32/v1";

/**
 * @param {number} seed
 */
export function createRandom(seed) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		/** @param {number} min @param {number} max */
		integer: (min, max) => min + Math.floor(next() * (max - min + 1)),
		/** @template T @param {readonly T[]} items @returns {T} */
		pick: (items) => {
			if (items.length === 0) throw new RangeError("pick needs at least one item");
			return items[Math.floor(next() * items.length)];
		},
	};
}
