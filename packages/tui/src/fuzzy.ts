/**
 * Fuzzy matching utilities.
 * Matches if all query characters appear in order (not necessarily consecutive).
 * Lower score = better match.
 */

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

/** Score each position of a match earns when it starts a word. */
const WORD_BOUNDARY_BONUS = 10;
/** Score each position of a match costs per character it lies into the text. */
const POSITION_PENALTY = 0.1;
/**
 * Characters after the first contiguous occurrence of the query beyond which no occurrence scores better. Each of the
 * query's positions costs `POSITION_PENALTY` more per character later it starts, and can win back at most
 * `WORD_BOUNDARY_BONUS`, so an occurrence starting more than this many characters after the first scores worse.
 */
const BETTER_OCCURRENCE_SPAN = WORD_BOUNDARY_BONUS / POSITION_PENALTY;

function scorePositions(textLower: string, positions: readonly number[]): number {
	let score = 0;
	let lastMatchIndex = -1;
	let consecutiveMatches = 0;

	for (const i of positions) {
		// Reward consecutive matches
		if (lastMatchIndex === i - 1) {
			consecutiveMatches++;
			score -= consecutiveMatches * 5;
		} else {
			consecutiveMatches = 0;
			// Penalize gaps
			if (lastMatchIndex >= 0) {
				score += (i - lastMatchIndex - 1) * 2;
			}
		}

		// Reward word boundary matches
		if (i === 0 || /[\s\-_./:]/.test(textLower[i - 1]!)) {
			score -= WORD_BOUNDARY_BONUS;
		}

		// Slight penalty for later matches
		score += i * POSITION_PENALTY;

		lastMatchIndex = i;
	}

	return score;
}

function matchQuery(normalizedQuery: string, textLower: string): FuzzyMatch {
	if (normalizedQuery.length === 0) {
		return { matches: true, score: 0 };
	}

	if (normalizedQuery.length > textLower.length) {
		return { matches: false, score: 0 };
	}

	// Greedy alignment: each query character at its first occurrence after the previous one.
	const positions: number[] = [];
	let lastMatchIndex = -1;
	for (let queryIndex = 0; queryIndex < normalizedQuery.length; queryIndex++) {
		const i = textLower.indexOf(normalizedQuery[queryIndex]!, lastMatchIndex + 1);
		if (i === -1) {
			return { matches: false, score: 0 };
		}
		positions.push(i);
		lastMatchIndex = i;
	}

	let score = scorePositions(textLower, positions);

	// The greedy alignment can scatter the query over an earlier, unrelated part of the text,
	// e.g. "opus" in "openrouter openrouter/anthropic/claude-opus" takes o, p, u from "openrouter".
	// Also score the contiguous occurrences that can beat the first one, and keep the best alignment.
	const firstStart = textLower.indexOf(normalizedQuery);
	for (
		let start = firstStart;
		start !== -1 && start - firstStart <= BETTER_OCCURRENCE_SPAN;
		start = textLower.indexOf(normalizedQuery, start + 1)
	) {
		for (let k = 0; k < positions.length; k++) {
			positions[k] = start + k;
		}
		score = Math.min(score, scorePositions(textLower, positions));
	}

	if (normalizedQuery === textLower) {
		score -= 100;
	}

	return { matches: true, score };
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();

	const primaryMatch = matchQuery(queryLower, textLower);
	if (primaryMatch.matches) {
		return primaryMatch;
	}

	const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
	const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
	const swappedQuery = alphaNumericMatch
		? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
		: numericAlphaMatch
			? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
			: "";

	if (!swappedQuery) {
		return primaryMatch;
	}

	const swappedMatch = matchQuery(swappedQuery, textLower);
	if (!swappedMatch.matches) {
		return primaryMatch;
	}

	return { matches: true, score: swappedMatch.score + 5 };
}

/**
 * Filter and sort items by fuzzy match quality (best matches first).
 * Supports whitespace- and slash-separated tokens: all tokens must match.
 */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	if (!query.trim()) {
		return items;
	}

	const tokens = query
		.trim()
		.split(/[\s/]+/)
		.filter((t) => t.length > 0);

	if (tokens.length === 0) {
		return items;
	}

	const results: { item: T; totalScore: number }[] = [];

	for (const item of items) {
		const text = getText(item);
		let totalScore = 0;
		let allMatch = true;

		for (const token of tokens) {
			const match = fuzzyMatch(token, text);
			if (match.matches) {
				totalScore += match.score;
			} else {
				allMatch = false;
				break;
			}
		}

		if (allMatch) {
			results.push({ item, totalScore });
		}
	}

	results.sort((a, b) => a.totalScore - b.totalScore);
	return results.map((r) => r.item);
}
