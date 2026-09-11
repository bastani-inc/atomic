import { homedir } from "node:os";
export const REDACTION_PLACEHOLDER = "[REDACTED]";
export const MAX_STACK_TRACE_LINES = 40;
export const MAX_DIAGNOSTIC_CHARS = 4_000;
export interface RedactionSummary {
	readonly category: RedactionCategory;
	readonly count: number;
}
export interface ScrubbedFeedback {
	readonly title: string;
	readonly body: string;
	readonly replacements: readonly RedactionSummary[];
}
function escaped(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
type CredentialScrubResult = {
	text: string;
	replacements: Array<{ category: "credential-assignment"; count: number }>;
};
type RedactionRule =
	| { readonly category: string; readonly pattern: RegExp; readonly replacement: string }
	| { readonly category: "credential-assignment"; readonly scrub: (text: string) => CredentialScrubResult };
const credentialAssignment =
	/(?<!\w)((?:[*_~`]{1,8})?((?:(?:api|access)[ \t]+)?[\w-]{0,127}(?:key|token|password|secret)\d*)[*_~`]{0,8})["']?([ \t]*)([:=])([ \t]*(?:[*_~`]{1,8})?[ \t]*)/giu;
function isStrongCredentialName(name: string): boolean {
	const normalized = name.toLowerCase().replaceAll(/[ -]/gu, "_");
	if (/^(?:key|token|password|secret)\d*$/u.test(normalized)) return false;
	return (
		normalized.includes("password") ||
		normalized.includes("token") ||
		normalized.includes("secret") ||
		/(?:api|access)_?key/u.test(normalized)
	);
}
function isLineLeadingCredentialName(name: string, input: string, assignmentStart: number): boolean {
	const normalized = name.toLowerCase();
	if (!/^(?:key|token|password|secret)\d*$/u.test(normalized)) return false;
	const lineStart = input.lastIndexOf("\n", assignmentStart - 1) + 1;
	const linePrefix = input.slice(lineStart, assignmentStart);
	return /^[ \t]*(?:(?:>|#|\/\/)[ \t]*)?(?:(?:[-*+])[ \t]+|(?:\d+[.)])[ \t]+)?[*_~`]*$/u.test(linePrefix);
}
function isLikelyCredentialValue(value: string): boolean {
	return /[\d@#$%^&*_=+/\\.-]/u.test(value) || /[a-z][A-Z]/u.test(value);
}
function isPathLikeValue(value: string): boolean {
	return /^\/(?:tmp|var|home|users|opt|etc|private|workspace|workspaces|dev|proc|sys)(?:\/|$)/iu.test(value);
}
function hasUnclosedQuoteBefore(input: string, start: number, quote: string): boolean {
	const lineStart = input.lastIndexOf("\n", start - 1) + 1;
	let open = false;
	for (let index = lineStart; index < start; index += 1) {
		if (input[index] !== quote || input[index - 1] === "\\") continue;
		open = !open;
	}
	return open;
}
function structuralQuoteBoundary(input: string, cursor: number, quote: string): number | undefined {
	const lineBreakEnd =
		input[cursor] === "\r" && input[cursor + 1] === "\n" ? cursor + 2 : input[cursor] === "\n" ? cursor + 1 : -1;
	if (lineBreakEnd < 0) return undefined;
	let nextLineStart = lineBreakEnd;
	while (nextLineStart <= input.length) {
		const nextLineEnd = input.indexOf("\n", nextLineStart);
		const nextLine = input.slice(nextLineStart, nextLineEnd < 0 ? input.length : nextLineEnd).replace(/\r$/u, "");
		if (/^[ \t]*$/u.test(nextLine)) {
			if (nextLineEnd < 0) return cursor;
			nextLineStart = nextLineEnd + 1;
			continue;
		}
		if (nextLine.startsWith("### ")) return cursor;
		for (let index = 0; index < nextLine.length; index += 1) {
			if (nextLine[index] !== quote || nextLine[index - 1] === "\\") continue;
			const previous = nextLine[index - 1] ?? "";
			const next = nextLine[index + 1] ?? "";
			if (previous && next && /\w/u.test(previous) && /\w/u.test(next)) continue;
			if (/^[ \t,.;:!?)}\]>*_~`-]*$/u.test(nextLine.slice(index + 1))) return undefined;
		}
		return cursor;
	}
	return cursor;
}
function completeTemplatePlaceholderEnd(input: string, start: number): number | undefined {
	if (input.startsWith("${", start)) {
		const close = input.indexOf("}", start + 2);
		return close < 0 ? undefined : close + 1;
	}
	if (input.startsWith("{{", start)) {
		const close = input.indexOf("}}", start + 2);
		return close < 0 ? undefined : close + 2;
	}
	return undefined;
}
function templatePlaceholderEnd(input: string, start: number): number | undefined {
	const end = completeTemplatePlaceholderEnd(input, start);
	if (end === undefined) return undefined;
	const next = input[end] ?? "";
	return next === "" || /[\s,;})\]&|<>('"`*_~]/u.test(next) ? end : undefined;
}
function unquotedValueEnd(input: string, start: number, assignmentStart: number): number {
	let end = start;
	while (end < input.length) {
		const character = input[end] ?? "";
		if (/\s/u.test(character) || /[,;})\]&|<>]/u.test(character)) break;
		if (
			(character === '"' || character === "'" || character === "`") &&
			hasUnclosedQuoteBefore(input, assignmentStart, character)
		)
			break;
		end += 1;
	}
	return end;
}
function consumedValueWrapper(prefix: string): string {
	const match = prefix.match(/([*_~`]+)$/u);
	if (!match || /[ \t]$/u.test(prefix)) return "";
	return match[1] ?? "";
}
function shouldRedactUnquotedValue(
	name: string,
	prefix: string,
	value: string,
	input: string,
	assignmentStart: number,
): boolean {
	if (value === REDACTION_PLACEHOLDER || value.length === 0) return false;
	const assignmentPrefix = prefix.replace(/[ \t]*[*_~`]+[ \t]*$/u, "");
	const compactAssignment = !/[=:][ \t]+[*_~`]+[ \t]*$/u.test(prefix) && assignmentPrefix.trim() === assignmentPrefix;
	const normalized = name.toLowerCase().replaceAll(/[ -]/gu, "_");
	const pathLikeName = normalized.includes("path");
	const strong = isStrongCredentialName(name);
	if (value.startsWith("/") && isPathLikeValue(value) && (!strong || pathLikeName)) return false;
	const lineLeading = isLineLeadingCredentialName(name, input, assignmentStart);
	return compactAssignment || strong || (lineLeading && (strong || isLikelyCredentialValue(value)));
}
function matchingTrailingWrapperLength(
	input: string,
	assignmentStart: number,
	valueStart: number,
	end: number,
	keyName: string,
): number {
	const lineStart = input.lastIndexOf("\n", assignmentStart - 1) + 1;
	const linePrefix = input.slice(lineStart, assignmentStart);
	const opening = linePrefix.match(/(?:^|[ \t])([*_~`]+)$/u)?.[1] ?? keyName.match(/^([*_~`]+)/u)?.[1];
	if (!opening) return 0;
	const value = input.slice(valueStart, end);
	return value.endsWith(opening) ? opening.length : 0;
}
function lineBreakStart(input: string, lineStart: number): number {
	if (lineStart === 0) return 0;
	return input[lineStart - 2] === "\r" ? lineStart - 2 : lineStart - 1;
}

function scrubCredentialAssignments(input: string): CredentialScrubResult {
	const matches: Array<{ start: number; end: number; replacement: string }> = [];
	const assignmentMatches = Array.from(input.matchAll(credentialAssignment));
	let coveredUntil = 0;
	for (const [assignmentIndex, match] of assignmentMatches.entries()) {
		const assignmentStart = match.index ?? 0;
		if (assignmentStart < coveredUntil) continue;
		const prefix = match[0];
		const keyName = match[2] ?? "";
		const valueStart = assignmentStart + prefix.length;
		const first = input[valueStart];
		if (first === '"' || first === "'") {
			const quote = first;
			let cursor = valueStart + 1;
			let hasContent = false;
			let closed = false;
			let stoppedAtBoundary = false;
			const assignmentLineStart = input.lastIndexOf("\n", assignmentStart - 1) + 1;
			const nextAssignmentStart = assignmentMatches
				.slice(assignmentIndex + 1)
				.map((item) => item.index ?? 0)
				.find((start) => {
					const lineStart = input.lastIndexOf("\n", start - 1) + 1;
					return lineStart > assignmentLineStart;
				});
			const nextAssignmentBoundary =
				nextAssignmentStart === undefined
					? undefined
					: lineBreakStart(input, input.lastIndexOf("\n", nextAssignmentStart - 1) + 1);
			while (cursor < input.length) {
				if (nextAssignmentBoundary !== undefined && cursor >= nextAssignmentBoundary) {
					cursor = nextAssignmentBoundary;
					stoppedAtBoundary = true;
					break;
				}
				const boundary = structuralQuoteBoundary(input, cursor, quote);
				if (boundary !== undefined) {
					cursor = boundary;
					stoppedAtBoundary = true;
					break;
				}
				const character = input[cursor];
				if (character === "\\") {
					const escapedCharacter = input[cursor + 1];
					if (escapedCharacter === undefined) {
						cursor += 1;
						break;
					}
					if (escapedCharacter !== "\\" && escapedCharacter !== "\r" && escapedCharacter !== "\n")
						hasContent = true;
					if (escapedCharacter === "\r" || escapedCharacter === "\n") {
						const escapedBoundary = structuralQuoteBoundary(input, cursor + 1, quote);
						if (escapedBoundary !== undefined) {
							cursor = escapedBoundary;
							stoppedAtBoundary = true;
							break;
						}
					}
					if (escapedCharacter === "\r" && input[cursor + 2] === "\n") cursor += 3;
					else cursor += 2;
					continue;
				}
				if (character === quote) {
					const previous = input[cursor - 1] ?? "";
					const next = input[cursor + 1] ?? "";
					if (previous && next && /\w/u.test(previous) && /\w/u.test(next)) {
						cursor += 1;
						continue;
					}
					closed = true;
					cursor += 1;
					break;
				}
				if (character !== "\r" && character !== "\n") hasContent = true;
				cursor += 1;
			}
			if (!closed && !stoppedAtBoundary) {
				const lineEnd = input.indexOf("\n", valueStart + 1);
				if (cursor <= lineEnd) cursor = lineEnd;
			}
			const value = input.slice(valueStart + 1, closed ? cursor - 1 : cursor);
			if (hasContent && value !== REDACTION_PLACEHOLDER) {
				matches.push({
					start: valueStart,
					end: cursor,
					replacement: `${quote}${REDACTION_PLACEHOLDER}${quote}`,
				});
				coveredUntil = cursor;
			}
			continue;
		}
		if (first === undefined || first === "\r" || first === "\n" || /\s/u.test(first)) continue;
		const completePlaceholderEnd = completeTemplatePlaceholderEnd(input, valueStart);
		if (templatePlaceholderEnd(input, valueStart) !== undefined) continue;
		if (completePlaceholderEnd !== undefined) {
			const redactedSuffixStart = completePlaceholderEnd + REDACTION_PLACEHOLDER.length;
			if (input.startsWith(REDACTION_PLACEHOLDER, completePlaceholderEnd)) {
				if (redactedSuffixStart >= input.length || /[\s,;})\]&|<>('"`]/u.test(input[redactedSuffixStart] ?? ""))
					continue;
				const suffixEnd = unquotedValueEnd(input, redactedSuffixStart, assignmentStart);
				const suffix = input.slice(redactedSuffixStart, suffixEnd);
				if (!shouldRedactUnquotedValue(keyName, prefix, suffix, input, assignmentStart)) continue;
				matches.push({ start: redactedSuffixStart, end: suffixEnd, replacement: REDACTION_PLACEHOLDER });
				coveredUntil = suffixEnd;
				continue;
			}
			const suffixEnd = unquotedValueEnd(input, completePlaceholderEnd, assignmentStart);
			const suffix = input.slice(completePlaceholderEnd, suffixEnd);
			if (!shouldRedactUnquotedValue(keyName, prefix, suffix, input, assignmentStart)) continue;
			matches.push({ start: completePlaceholderEnd, end: suffixEnd, replacement: REDACTION_PLACEHOLDER });
			coveredUntil = suffixEnd;
			continue;
		}
		const openingWrapper = consumedValueWrapper(prefix);
		if (input.startsWith(REDACTION_PLACEHOLDER, valueStart)) {
			const suffixStart = valueStart + REDACTION_PLACEHOLDER.length;
			if (suffixStart >= input.length || /[\s,;})\]&|<>('"`]/u.test(input[suffixStart] ?? "")) continue;
			const suffixEnd = unquotedValueEnd(input, suffixStart, assignmentStart);
			const closesWrapper =
				openingWrapper &&
				suffixEnd >= suffixStart + openingWrapper.length &&
				input.slice(suffixEnd - openingWrapper.length, suffixEnd) === openingWrapper;
			const wrapperLength = closesWrapper
				? openingWrapper.length
				: matchingTrailingWrapperLength(input, assignmentStart, valueStart, suffixEnd, keyName);
			const trailingMarkerLength = input.slice(suffixStart, suffixEnd).match(/[*_~]+$/u)?.[0].length ?? 0;
			const redactedEnd = suffixEnd - Math.max(wrapperLength, trailingMarkerLength);
			if ((openingWrapper && redactedEnd === suffixStart) || redactedEnd <= suffixStart) continue;
			matches.push({ start: valueStart, end: redactedEnd, replacement: REDACTION_PLACEHOLDER });
			coveredUntil = redactedEnd;
			continue;
		}
		const end = unquotedValueEnd(input, valueStart, assignmentStart);
		let hasMatchingWrapper = false;
		let preserveOpeningWrapper = false;
		if (openingWrapper) {
			const candidate = input.slice(valueStart, end);
			if (candidate.length > openingWrapper.length && candidate.endsWith(openingWrapper)) {
				hasMatchingWrapper = true;
			} else {
				const lineEnd = input.indexOf("\n", valueStart);
				const limit = lineEnd < 0 ? input.length : lineEnd;
				preserveOpeningWrapper = input.lastIndexOf(openingWrapper, limit) > end;
			}
		}
		const matchingWrapperLength = matchingTrailingWrapperLength(input, assignmentStart, valueStart, end, keyName);
		const trailingMarkerLength =
			hasMatchingWrapper || preserveOpeningWrapper
				? 0
				: (input.slice(valueStart, end).match(/[*_~]+$/u)?.[0].length ?? 0);
		const trailingWrapperLength = Math.max(matchingWrapperLength, trailingMarkerLength);
		const redactedEnd = end - trailingWrapperLength;
		const value = input.slice(valueStart, redactedEnd);
		const redactedValue = hasMatchingWrapper ? value.slice(0, -openingWrapper.length) : value;
		if (!shouldRedactUnquotedValue(keyName, prefix, redactedValue, input, assignmentStart)) continue;
		matches.push({
			start: openingWrapper ? valueStart - openingWrapper.length : valueStart,
			end: hasMatchingWrapper ? end : redactedEnd,
			replacement: hasMatchingWrapper
				? `${openingWrapper}${REDACTION_PLACEHOLDER}${openingWrapper}`
				: preserveOpeningWrapper
					? `${openingWrapper}${REDACTION_PLACEHOLDER}`
					: REDACTION_PLACEHOLDER,
		});
		coveredUntil = hasMatchingWrapper ? end : redactedEnd;
	}
	if (matches.length === 0) return { text: input, replacements: [] };
	let text = "";
	let cursor = 0;
	for (const match of matches) {
		text += input.slice(cursor, match.start) + match.replacement;
		cursor = match.end;
	}
	return {
		text: text + input.slice(cursor),
		replacements: [{ category: "credential-assignment", count: matches.length }],
	};
}
const rules = [
	{
		category: "private-key",
		pattern: /-----BEGIN [^-\n]*PRIVATE KEY[^-\n]*-----(?:[\s\S]*?-----END [^-\n]*PRIVATE KEY[^-\n]*-----|[\s\S]*)/gu,
		replacement: REDACTION_PLACEHOLDER,
	},
	{
		category: "url-credentials",
		pattern: /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9+.-]{0,63}:\/\/)(?!\[REDACTED\]@)[^\s/?#@]+@/giu,
		replacement: `$1${REDACTION_PLACEHOLDER}@`,
	},
	{ category: "anthropic-token", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/gu, replacement: REDACTION_PLACEHOLDER },
	{
		category: "github-token",
		pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
		replacement: REDACTION_PLACEHOLDER,
	},
	{ category: "openai-token", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gu, replacement: REDACTION_PLACEHOLDER },
	{ category: "aws-access-key", pattern: /\bAKIA[A-Z0-9]{16}\b/gu, replacement: REDACTION_PLACEHOLDER },
	{
		category: "provider-token",
		pattern:
			/\b(?:AIza[\w-]{35}|eyJ[\w-]{8,}(?:\.[\w-]{8,}){2}|(?:xox[abposr]|glpat|xai)-[\w-]{10,}|(?:sk_live_|hf_|npm_)\w{16,})/gu,
		replacement: REDACTION_PLACEHOLDER,
	},
	{ category: "credential-assignment", scrub: scrubCredentialAssignments },
	{
		category: "home-directory",
		pattern: new RegExp(`(?<!\\w)(?:${escaped(homedir())}|(?:\\w:)?[\\\\/](?:Users|home)[\\\\/][^\\\\/\\s]+)`, "giu"),
		replacement: "~",
	},
] as const satisfies readonly RedactionRule[];
export type RedactionCategory = (typeof rules)[number]["category"];

function scrub(text: string): { text: string; replacements: RedactionSummary[] } {
	const replacements: RedactionSummary[] = [];
	for (const rule of rules) {
		if ("scrub" in rule) {
			const result = rule.scrub(text);
			text = result.text;
			replacements.push(...result.replacements);
			continue;
		}
		const count = text.match(rule.pattern)?.length ?? 0;
		text = text.replace(rule.pattern, rule.replacement);
		if (count) replacements.push({ category: rule.category, count });
	}
	return { text, replacements };
}
export function scrubFeedback(title: string, body: string): ScrubbedFeedback {
	const scrubbedTitle = scrub(title);
	const scrubbedBody = scrub(body);
	const counts = new Map<RedactionCategory, number>();
	for (const item of [...scrubbedTitle.replacements, ...scrubbedBody.replacements])
		counts.set(item.category, (counts.get(item.category) ?? 0) + item.count);
	return {
		title: scrubbedTitle.text,
		body: scrubbedBody.text,
		replacements: rules.flatMap(({ category }) => {
			const count = counts.get(category);
			return count ? [{ category, count }] : [];
		}),
	};
}
export function boundStackTrace(stack: string): string {
	const lines = stack.split("\n");
	if (lines.length <= MAX_STACK_TRACE_LINES) return stack;
	const kept = lines.slice(0, MAX_STACK_TRACE_LINES - 1);
	return [...kept, `[Truncated ${lines.length - kept.length} stack trace lines]`].join("\n");
}
export function boundDiagnostic(diagnostic: string): string {
	if (diagnostic.length <= MAX_DIAGNOSTIC_CHARS) return diagnostic;
	let keptLength = MAX_DIAGNOSTIC_CHARS;
	let notice = "";
	do {
		notice = `[Truncated ${diagnostic.length - keptLength} diagnostic characters]`;
		keptLength = MAX_DIAGNOSTIC_CHARS - notice.length;
	} while (diagnostic.length - keptLength !== Number(notice.match(/\d+/u)?.[0]));
	return diagnostic.slice(0, keptLength) + notice;
}
