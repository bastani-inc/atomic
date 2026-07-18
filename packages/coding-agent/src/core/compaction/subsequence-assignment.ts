/** Return the earliest ordinary monotone source assignment, or undefined. */
export function earliestSubsequenceAssignment(source: readonly string[], output: readonly string[]): number[] | undefined {
	const assigned: number[] = [];
	let pointer = 0;
	for (const line of output) {
		while (pointer < source.length && source[pointer] !== line) pointer++;
		if (pointer === source.length) return undefined;
		assigned.push(pointer + 1);
		pointer++;
	}
	return assigned;
}

function hasProtected(protectedLines: ReadonlySet<number>, start: number, end: number): boolean {
	for (const line of protectedLines) if (line > start && line <= end) return true;
	return false;
}

/**
 * Feasibility by consumed output length for one source slice. Memory is O(m).
 * Reverse traversal produces suffix feasibility for Hirschberg reconstruction.
 */
function feasibilityVector(
	source: readonly string[], sourceStart: number, sourceEnd: number,
	output: readonly string[], outputStart: number, outputEnd: number,
	protectedLines: ReadonlySet<number>, reverse = false,
): Uint8Array {
	const outputLength = outputEnd - outputStart;
	let prior = new Uint8Array(outputLength + 1);
	prior[0] = 1;
	for (let offset = 0; offset < sourceEnd - sourceStart; offset++) {
		const sourceIndex = reverse ? sourceEnd - 1 - offset : sourceStart + offset;
		const required = protectedLines.has(sourceIndex + 1);
		const next = new Uint8Array(outputLength + 1);
		if (!required) next[0] = prior[0];
		for (let consumed = 1; consumed <= outputLength; consumed++) {
			const outputIndex = reverse ? outputEnd - consumed : outputStart + consumed - 1;
			const matches = source[sourceIndex] === output[outputIndex] && prior[consumed - 1] === 1;
			next[consumed] = required ? Number(matches) : Number(prior[consumed] === 1 || matches);
		}
		prior = next;
	}
	return prior;
}

/** O(m)-memory exact assignment; maximum feasible split gives lexicographically earliest source indices. */
function assignProtected(
	source: readonly string[], sourceStart: number, sourceEnd: number,
	output: readonly string[], outputStart: number, outputEnd: number,
	protectedLines: ReadonlySet<number>,
): number[] | undefined {
	const sourceLength = sourceEnd - sourceStart;
	const outputLength = outputEnd - outputStart;
	if (outputLength === 0) return hasProtected(protectedLines, sourceStart, sourceEnd) ? undefined : [];
	if (sourceLength === 0 || outputLength > sourceLength) return undefined;
	if (sourceLength === 1) {
		return outputLength === 1 && source[sourceStart] === output[outputStart] ? [sourceStart + 1] : undefined;
	}

	const sourceMiddle = sourceStart + Math.floor(sourceLength / 2);
	const left = feasibilityVector(source, sourceStart, sourceMiddle, output, outputStart, outputEnd, protectedLines);
	const right = feasibilityVector(source, sourceMiddle, sourceEnd, output, outputStart, outputEnd, protectedLines, true);
	let split = -1;
	for (let consumed = outputLength; consumed >= 0; consumed--) {
		if (left[consumed] === 1 && right[outputLength - consumed] === 1) { split = consumed; break; }
	}
	if (split < 0) return undefined;
	const leftAssignment = assignProtected(
		source, sourceStart, sourceMiddle, output, outputStart, outputStart + split, protectedLines,
	);
	if (!leftAssignment) return undefined;
	const rightAssignment = assignProtected(
		source, sourceMiddle, sourceEnd, output, outputStart + split, outputEnd, protectedLines,
	);
	return rightAssignment ? [...leftAssignment, ...rightAssignment] : undefined;
}

/** Fast O(n+m) assignment for the production full-collapse protected suffix. */
function protectedSuffixAssignment(
	source: readonly string[], output: readonly string[], protectedLines: readonly number[],
): number[] | undefined {
	const first = protectedLines[0];
	if (protectedLines.length === 0 || first + protectedLines.length - 1 !== source.length) return undefined;
	for (let index = 0; index < protectedLines.length; index++) {
		if (protectedLines[index] !== first + index) return undefined;
	}
	if (output.length < protectedLines.length) return undefined;
	const outputSuffixStart = output.length - protectedLines.length;
	for (let index = 0; index < protectedLines.length; index++) {
		if (output[outputSuffixStart + index] !== source[first - 1 + index]) return undefined;
	}
	const prefix = earliestSubsequenceAssignment(source.slice(0, first - 1), output.slice(0, outputSuffixStart));
	return prefix ? [...prefix, ...protectedLines] : undefined;
}

/** Exact deterministic monotone assignment that includes every protected source occurrence. */
export function earliestProtectedSubsequenceAssignment(
	source: readonly string[], output: readonly string[], protectedLines: ReadonlySet<number>,
): number[] | undefined {
	if (protectedLines.size === 0) return earliestSubsequenceAssignment(source, output);
	const protectedSorted = [...protectedLines].sort((left, right) => left - right);
	if (protectedSorted.some((line) => !Number.isSafeInteger(line) || line < 1 || line > source.length)) return undefined;
	const suffix = protectedSuffixAssignment(source, output, protectedSorted);
	if (suffix) return suffix;
	return assignProtected(source, 0, source.length, output, 0, output.length, protectedLines);
}
