/** Pure, seeded selection math for the probabilistic pivot tournament. */
import { VERIFICATION_SCALE } from "./verification-criteria.js";

export interface DirectedPair {
	a: number;
	b: number;
}

export interface ScoringJob {
	a: number;
	b: number;
	criterionId: string;
	rep: number;
	swapped: boolean;
}

export interface ComparisonPlan {
	ring: DirectedPair[];
	pivotRounds: (pivots: number[]) => DirectedPair[];
	jobs: (pairs: readonly DirectedPair[], criterionIds: readonly string[]) => ScoringJob[];
}

export interface Preference {
	a: number;
	b: number;
	p: number;
}

export interface RankingEntry {
	index: number;
	meanPreference: number;
}

export type Ranking = RankingEntry[];

const UINT32_RANGE = 0x1_0000_0000;
const MULBERRY_INCREMENT = 0x6d2b79f5;

/** Return a deterministic Mulberry32-class random-float generator. */
export function seeded_rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + MULBERRY_INCREMENT) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
	};
}

function ring_cycle(n: number, rng: () => number): DirectedPair[] {
	const permutation = Array.from({ length: n }, (_, index) => index);
	for (let index = n - 1; index > 0; index -= 1) {
		const other = Math.floor(rng() * (index + 1));
		[permutation[index], permutation[other]] = [permutation[other]!, permutation[index]!];
	}
	return permutation.map((a, index) => ({ a, b: permutation[(index + 1) % n]! }));
}

function pair_key(a: number, b: number): string {
	return a < b ? `${a}:${b}` : `${b}:${a}`;
}


/** Build a deterministic ring and expose the later pivot/job phases as pure closures. */
export function plan_comparisons(input: {
	n: number;
	pivots: number;
	repeats: number;
	seed: number;
}): ComparisonPlan {
	const { n, pivots: pivotCount, repeats, seed } = input;
	if (n < 2) throw new RangeError("n must be at least 2");
	if (pivotCount < 1) throw new RangeError("pivots must be at least 1");
	if (repeats < 1) throw new RangeError("repeats must be at least 1");

	const ring = ring_cycle(n, seeded_rng(seed));
	return {
		ring,
		pivotRounds: (pivots) => {
			const scheduled = new Set(ring.map(({ a, b }) => pair_key(a, b)));
			const pivotSet = new Set(pivots);
			const pairs: DirectedPair[] = [];
			const add = (a: number, b: number): void => {
				if (a === b) return;
				const key = pair_key(a, b);
				if (scheduled.has(key)) return;
				scheduled.add(key);
				pairs.push({ a, b });
			};
			for (let candidate = 0; candidate < n; candidate += 1) {
				if (pivotSet.has(candidate)) continue;
				for (const pivot of pivots) add(candidate, pivot);
			}
			for (let first = 0; first < pivots.length; first += 1) {
				for (let second = first + 1; second < pivots.length; second += 1) {
					add(pivots[first]!, pivots[second]!);
				}
			}
			return pairs;
		},
		jobs: (pairs, criterionIds) => {
			const jobs: ScoringJob[] = [];
			for (const pair of pairs) {
				for (const criterionId of criterionIds) {
					for (let rep = 0; rep < repeats; rep += 1) {
						jobs.push({ a: pair.a, b: pair.b, criterionId, rep, swapped: rep % 2 === 1 });
					}
				}
			}
			return jobs;
		},
	};
}

/** Convert a verification score to the reward range used by Bradley-Terry. */
function normalize_score(score: number): number {
	return (score - VERIFICATION_SCALE.min) / (VERIFICATION_SCALE.max - VERIFICATION_SCALE.min);
}

/** Return the Bradley-Terry soft preference for the first score. */
export function soft_win(scoreA: number, scoreB: number): number {
	const difference = normalize_score(scoreA) - normalize_score(scoreB);
	return 1 / (1 + Math.exp(-difference));
}

/** Add each preference to both candidates' win mass and comparison count. */
export function accumulate(prefs: readonly Preference[], w: number[], c: number[]): void {
	for (const { a, b, p } of prefs) {
		w[a]! += p;
		c[a]! += 1;
		w[b]! += 1 - p;
		c[b]! += 1;
	}
}

function mean_preference(w: number[], c: number[], index: number): number {
	return c[index] === 0 ? 0 : w[index]! / c[index]!;
}

function candidate_order(w: number[], c: number[]): number[] {
	return Array.from({ length: w.length }, (_, index) => index).sort((left, right) => {
		const difference = mean_preference(w, c, right) - mean_preference(w, c, left);
		return difference === 0 ? left - right : difference;
	});
}

/** Return the top-k candidate indices, resolving equal means by index. */
export function select_pivots(w: number[], c: number[], k: number): number[] {
	return candidate_order(w, c).slice(0, k);
}

/** Return every candidate ordered by mean preference, including unscored ones. */
export function rank_candidates(w: number[], c: number[]): Ranking {
	return candidate_order(w, c).map((index) => ({ index, meanPreference: mean_preference(w, c, index) }));
}
