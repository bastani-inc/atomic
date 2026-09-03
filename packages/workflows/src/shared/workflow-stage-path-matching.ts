/**
 * Shared glob semantics for workflow stage path targets (slice 3, D2/D5/D6).
 *
 * This module is mirrored verbatim in `packages/intercom/workflow-stage-path-matching.ts`
 * (the broker cannot import from `packages/workflows`, amendment A1). A parity test runs
 * both implementations over one fixture table and asserts identical results; keep the two
 * files byte-identical in behavior.
 */

/** Glob-match `candidateSegments` against `patternSegments`. */
export function matchStagePathSegments(
	patternSegments: readonly string[],
	candidateSegments: readonly string[],
): boolean {
	return matchSegmentsFrom(patternSegments, 0, candidateSegments, 0);
}

/** Split an unprefixed stage path into its `/` segments. */
export function splitStagePathSegments(path: string): string[] {
	return path.split("/");
}

/** D4 membership (advisory, bidirectional) of a target path inside the persisted possible-stage set. */
export function targetSegmentsInPossibleStages(
	targetSegments: readonly string[],
	possibleStages: readonly string[],
): boolean {
	return possibleStages.some((entry) => {
		const entrySegments = splitStagePathSegments(entry);
		return (
			matchStagePathSegments(entrySegments, targetSegments) || matchStagePathSegments(targetSegments, entrySegments)
		);
	});
}

function matchSegmentsFrom(
	pattern: readonly string[],
	patternIndex: number,
	candidate: readonly string[],
	candidateIndex: number,
): boolean {
	let p = patternIndex;
	let c = candidateIndex;
	while (p < pattern.length) {
		const segment = pattern[p]!;
		if (segment === "**") {
			for (let skip = c; skip <= candidate.length; skip += 1) {
				if (matchSegmentsFrom(pattern, p + 1, candidate, skip)) return true;
			}
			return false;
		}
		if (c >= candidate.length) return false;
		if (!matchSegmentGlob(segment, candidate[c]!)) return false;
		p += 1;
		c += 1;
	}
	return c === candidate.length;
}

function matchSegmentGlob(pattern: string, value: string): boolean {
	if (!pattern.includes("*")) return pattern === value;
	let p = 0;
	let v = 0;
	let star = -1;
	let mark = -1;
	while (v < value.length) {
		if (p < pattern.length && pattern[p] === "*") {
			star = p;
			mark = v;
			p += 1;
			continue;
		}
		if (p < pattern.length && pattern[p] === value[v]) {
			p += 1;
			v += 1;
			continue;
		}
		if (star >= 0) {
			p = star + 1;
			mark += 1;
			v = mark;
			continue;
		}
		return false;
	}
	while (p < pattern.length && pattern[p] === "*") p += 1;
	return p === pattern.length;
}
