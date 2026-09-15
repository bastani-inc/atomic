#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
export const REDACTION_PLACEHOLDER = "[REDACTED]";

function escaped(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const credentialAssignment =
	/(?<!\w)((?:[*_~`]{1,8})?((?:(?:api|access)[ \t]+)?[\w-]{0,127}(?:key|token|password|secret)\d*)[*_~`]{0,8})["']?([ \t]*)([:=])([ \t]*(?:[*_~`]{1,8})?[ \t]*)/giu;
function isStrongCredentialName(name) {
	const normalized = name.toLowerCase().replaceAll(/[ \t-]+/gu, "_");
	if (/^(?:key|token|password|secret)\d*$/u.test(normalized)) return false;
	return (
		normalized.includes("password") ||
		normalized.includes("token") ||
		normalized.includes("secret") ||
		/(?:api|access)_?key/u.test(normalized)
	);
}
function isLineLeadingCredentialName(name, input, assignmentStart) {
	const normalized = name.toLowerCase();
	if (!/^(?:key|token|password|secret)\d*$/u.test(normalized)) return false;
	const lineStart = input.lastIndexOf("\n", assignmentStart - 1) + 1;
	const linePrefix = input.slice(lineStart, assignmentStart);
	return /^[ \t]*(?:(?:>|#|\/\/)[ \t]*)?(?:(?:[-*+])[ \t]+|(?:\d+[.)])[ \t]+)?[*_~`]*$/u.test(linePrefix);
}
function isLikelyCredentialValue(value) {
	return /[\d@#$%^&*_=+/\\.-]/u.test(value) || /[a-z][A-Z]/u.test(value);
}
function isPathLikeValue(value) {
	return /^\/(?:tmp|var|home|users|opt|etc|private|workspace|workspaces|dev|proc|sys)(?:\/|$)/iu.test(value);
}
function hasUnclosedQuoteBefore(input, start, quote) {
	const lineStart = input.lastIndexOf("\n", start - 1) + 1;
	let open = false;
	for (let index = lineStart; index < start; index += 1) {
		if (input[index] !== quote || input[index - 1] === "\\") continue;
		open = !open;
	}
	return open;
}
function balancedValueEnd(input, start) {
	const opening = "([{<";
	const closing = ")]}>";
	const first = opening.indexOf(input[start] ?? "");
	if (first < 0 || start >= input.length) return undefined;
	const stack = [closing[first]];
	let quote = "";
	for (let cursor = start + 1; cursor < input.length; cursor += 1) {
		const character = input[cursor] ?? "";
		if (character === "\r" || character === "\n") return undefined;
		if (quote) {
			if (character === "\\" && input[cursor + 1] !== "\r" && input[cursor + 1] !== "\n") cursor += 1;
			else if (character === quote) quote = "";
			continue;
		}
		if ((character === '"' || character === "'") && /[\s([{<,:]/u.test(input[cursor - 1] ?? "")) {
			quote = character;
			continue;
		}
		const nested = opening.indexOf(character);
		if (nested >= 0) stack.push(closing[nested]);
		else if (closing.includes(character)) {
			if (stack.pop() !== character) return undefined;
			if (stack.length === 0) return cursor + 1;
		}
	}
	return undefined;
}
// Share hard report boundaries between quoted values and private-key blocks.
// Setext lookahead preserves the title line as well as its underline. Keep this
// line-local: do not reinterpret preceding credential material as heading text.
const reportBoundary =
	/\r?\n(?=[ \t]*(?:\r?\n|$)| {0,3}#{1,6}(?:[ \t]|\r?\n|$)| {0,3}[^ \t\r\n][^\r\n]*\r?\n {0,3}(?:=+|-+)[ \t]*(?:\r?\n|$))/uy;
function structuralQuoteBoundary(input, cursor, quote) {
	const lineBreakEnd =
		input[cursor] === "\r" && input[cursor + 1] === "\n" ? cursor + 2 : input[cursor] === "\n" ? cursor + 1 : -1;
	if (lineBreakEnd < 0) return undefined;
	const nextLineEnd = input.indexOf("\n", lineBreakEnd);
	const nextLine = input.slice(lineBreakEnd, nextLineEnd < 0 ? input.length : nextLineEnd).replace(/\r$/u, "");
	reportBoundary.lastIndex = cursor;
	if (reportBoundary.test(input)) return cursor;
	let sawQuote = false;
	for (let index = 0; index < nextLine.length; index += 1) {
		if (nextLine[index] !== quote || nextLine[index - 1] === "\\") continue;
		sawQuote = true;
		const previous = nextLine[index - 1] ?? "";
		const next = nextLine[index + 1] ?? "";
		if (previous && next && /\w/u.test(previous) && /\w/u.test(next)) continue;
		const suffix = nextLine.slice(index + 1).trim();
		if (suffix.length === 0) return undefined;
		if (index === 0 || /\s/u.test(nextLine.slice(0, index).trimStart())) return cursor;
		return undefined;
	}
	return sawQuote ? cursor : undefined;
}
function completeTemplatePlaceholderEnd(input, start) {
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
function templatePlaceholderEnd(input, start) {
	const end = completeTemplatePlaceholderEnd(input, start);
	if (end === undefined) return undefined;
	const next = input[end] ?? "";
	return next === "" || /[\s,;[})\]&|<>('"`*_~]/u.test(next) ? end : undefined;
}
function unquotedValueEnd(input, start, assignmentStart) {
	let end = start;
	const quoteBoundaries = new Map();
	const unclosedWrappers = new Set();
	while (end < input.length) {
		const character = input[end] ?? "";
		if ("([{<".includes(character)) {
			if (character === "<" && end !== start) break;
			const balancedEnd = unclosedWrappers.has(character) ? undefined : balancedValueEnd(input, end);
			if (balancedEnd !== undefined) {
				end = balancedEnd;
				continue;
			}
			unclosedWrappers.add(character);
			// A malformed opening wrapper belongs to this line's value only.
			if (character !== "<" || end === start) {
				end += 1;
				continue;
			}
		}
		if (/\s/u.test(character) || /[,;})\]&|<>]/u.test(character)) break;
		if (character === '"' || character === "'" || character === "`") {
			let boundary = quoteBoundaries.get(character);
			if (boundary === undefined) {
				boundary = hasUnclosedQuoteBefore(
					input,
					assignmentStart + (input[assignmentStart] === character ? 1 : 0),
					character,
				);
				quoteBoundaries.set(character, boundary);
			}
			if (boundary) break;
		}
		end += 1;
	}
	return end;
}
function consumedValueWrapper(prefix) {
	const match = prefix.match(/([*_~`]+)$/u);
	if (!match || /[ \t]$/u.test(prefix)) return "";
	return match[1] ?? "";
}
function shouldRedactUnquotedValue(name, prefix, value, input, assignmentStart) {
	if (value === REDACTION_PLACEHOLDER || value.length === 0) return false;
	const assignmentPrefix = prefix.replace(/[ \t]*[*_~`]+[ \t]*$/u, "");
	const compactAssignment = !/[=:](?:[*_~`]+)?[ \t]/u.test(prefix) && assignmentPrefix.trim() === assignmentPrefix;
	const normalized = name.toLowerCase().replaceAll(/[ -]/gu, "_");
	const pathLikeName = normalized.includes("path");
	const strong = isStrongCredentialName(name);
	if (value.startsWith("/") && isPathLikeValue(value) && (!strong || pathLikeName)) return false;
	const lineLeading = isLineLeadingCredentialName(name, input, assignmentStart);
	return (
		(compactAssignment && (!/[*_~`]/u.test(prefix) || lineLeading || strong)) ||
		strong ||
		(lineLeading && (strong || isLikelyCredentialValue(value)))
	);
}
function matchingTrailingWrapperLength(input, assignmentStart, valueStart, end, keyName) {
	const lineStart = input.lastIndexOf("\n", assignmentStart - 1) + 1;
	const linePrefix = input.slice(lineStart, assignmentStart);
	const opening = linePrefix.match(/(?:^|[ \t])([*_~`]+)$/u)?.[1] ?? keyName.match(/^([*_~`]+)/u)?.[1];
	if (!opening) return 0;
	const value = input.slice(valueStart, end);
	return value.endsWith(opening) ? opening.length : 0;
}
function lineBreakStart(input, lineStart) {
	if (lineStart === 0) return 0;
	return input[lineStart - 2] === "\r" ? lineStart - 2 : lineStart - 1;
}

function scrubCredentialAssignments(input) {
	const matches = [];
	const assignmentMatches = Array.from(input.matchAll(credentialAssignment));
	let coveredUntil = 0;
	for (const [assignmentIndex, match] of assignmentMatches.entries()) {
		const assignmentStart = match.index ?? 0;
		const prefix = match[0];
		const keyName = match[2] ?? "";
		const valueStart = assignmentStart + prefix.length;
		// The optional spaced name prefix may start inside the preceding value.
		// Only skip values already covered, not untouched values with overlapping names.
		if (valueStart < coveredUntil) continue;
		const first = input[valueStart];
		if (first === '"' || first === "'") {
			const quote = first;
			let cursor = valueStart + 1;
			let hasContent = false;
			let closed = false;
			let stoppedAtBoundary = false;
			const assignmentLineStart = input.lastIndexOf("\n", assignmentStart - 1) + 1;
			const nextAssignment = assignmentMatches[assignmentIndex + 1];
			const nextAssignmentStart = nextAssignment?.index;
			const nextAssignmentLineStart =
				nextAssignmentStart === undefined ? undefined : input.lastIndexOf("\n", nextAssignmentStart - 1) + 1;
			const nextAssignmentValueStart =
				nextAssignmentStart === undefined ? undefined : nextAssignmentStart + nextAssignment[0].length;
			const nextAssignmentIsQuoted =
				nextAssignmentValueStart !== undefined &&
				(input[nextAssignmentValueStart] === '"' || input[nextAssignmentValueStart] === "'");
			const nextAssignmentBoundary =
				nextAssignmentStart === undefined || nextAssignmentLineStart === undefined
					? undefined
					: nextAssignmentLineStart === assignmentLineStart
						? nextAssignmentIsQuoted
							? nextAssignmentStart
							: undefined
						: lineBreakStart(input, nextAssignmentLineStart);
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
			let replacementEnd = cursor;
			if (stoppedAtBoundary && nextAssignmentLineStart === assignmentLineStart) {
				while (replacementEnd > valueStart && /[ \t]/u.test(input[replacementEnd - 1] ?? "")) replacementEnd -= 1;
			}
			const value = input.slice(valueStart + 1, closed ? replacementEnd - 1 : replacementEnd);
			if (hasContent && value !== REDACTION_PLACEHOLDER) {
				matches.push({
					start: valueStart,
					end: replacementEnd,
					replacement: `${quote}${REDACTION_PLACEHOLDER}${quote}`,
				});
				coveredUntil = replacementEnd;
			}
			continue;
		}
		if (first === undefined || first === "\r" || first === "\n" || /\s/u.test(first)) continue;
		const completePlaceholderEnd = completeTemplatePlaceholderEnd(input, valueStart);
		if (completePlaceholderEnd !== undefined) {
			if (input.startsWith(REDACTION_PLACEHOLDER, completePlaceholderEnd)) {
				const redactedSuffixStart = completePlaceholderEnd + REDACTION_PLACEHOLDER.length;
				if (
					redactedSuffixStart >= input.length ||
					input.startsWith(REDACTION_PLACEHOLDER, redactedSuffixStart) ||
					/[\s,;[})\]&|<>('"`]/u.test(input[redactedSuffixStart] ?? "")
				)
					continue;
				const suffixEnd = unquotedValueEnd(input, redactedSuffixStart, assignmentStart);
				const suffix = input.slice(redactedSuffixStart, suffixEnd);
				if (!shouldRedactUnquotedValue(keyName, prefix, suffix, input, assignmentStart)) continue;
				matches.push({ start: completePlaceholderEnd, end: suffixEnd, replacement: REDACTION_PLACEHOLDER });
				coveredUntil = suffixEnd;
				continue;
			}
			if (templatePlaceholderEnd(input, valueStart) !== undefined) continue;
			const suffixEnd = unquotedValueEnd(input, completePlaceholderEnd, assignmentStart);
			const suffix = input.slice(completePlaceholderEnd, suffixEnd);
			if (!shouldRedactUnquotedValue(keyName, prefix, suffix, input, assignmentStart)) continue;
			matches.push({ start: completePlaceholderEnd, end: suffixEnd, replacement: REDACTION_PLACEHOLDER });
			coveredUntil = suffixEnd;
			continue;
		}
		const labelClosingWrapper = /^[*_~`]/u.test(prefix) && /[:=][ \t]*[*_~`]+[ \t]*$/u.test(prefix);
		const openingWrapper = labelClosingWrapper ? "" : consumedValueWrapper(prefix);
		if (input.startsWith(REDACTION_PLACEHOLDER, valueStart)) {
			const suffixStart = valueStart + REDACTION_PLACEHOLDER.length;
			if (
				suffixStart >= input.length ||
				input.startsWith(REDACTION_PLACEHOLDER, suffixStart) ||
				/[\s,;[})\]&|<>('"`]/u.test(input[suffixStart] ?? "")
			)
				continue;
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
		const balancedEnd = balancedValueEnd(input, valueStart);
		if (balancedEnd !== undefined) {
			const value = input.slice(valueStart, balancedEnd);
			// Keep the existing literal example placeholder, not arbitrary angle-wrapped secrets.
			const inner = value.slice(1, -1).trim();
			if (end === balancedEnd && (value === "<your-key-here>" || inner === "" || inner === REDACTION_PLACEHOLDER))
				continue;
			if (
				first === "[" &&
				(input[balancedEnd] === "(" || input[balancedEnd] === "[") &&
				balancedValueEnd(input, balancedEnd) !== undefined
			)
				continue;
		}
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
function scrubPrivateKeys(input) {
	const beginPattern = /-----BEGIN [^-\r\n]*PRIVATE KEY[^-\r\n]*-----/gu;
	// Index terminators and hard boundaries once, rather than retrying a failed END
	// search over the same contiguous report block for every BEGIN mention.
	const ends = Array.from(input.matchAll(/-----END [^-\r\n]*PRIVATE KEY[^-\r\n]*-----/gu));
	const boundaries = Array.from(input.matchAll(new RegExp(reportBoundary.source, "gu")));
	const sameLineFallback = /[ \t]*[^ \t\r\n][^\r\n]*/uy;
	let endIndex = 0;
	let boundaryIndex = 0;
	let cursor = 0;
	let count = 0;
	let text = "";
	for (let begin = beginPattern.exec(input); begin; begin = beginPattern.exec(input)) {
		const markerEnd = begin.index + begin[0].length;
		while (endIndex < ends.length && ends[endIndex].index < markerEnd) endIndex += 1;
		while (boundaryIndex < boundaries.length && boundaries[boundaryIndex].index < markerEnd) boundaryIndex += 1;
		const end = ends[endIndex];
		const boundary = boundaries[boundaryIndex]?.index ?? input.length;
		let replacementEnd;
		if (end && end.index < boundary) {
			replacementEnd = end.index + end[0].length;
		} else {
			sameLineFallback.lastIndex = markerEnd;
			const sameLine = sameLineFallback.exec(input);
			replacementEnd = sameLine ? markerEnd + sameLine[0].length : boundary;
		}
		text += input.slice(cursor, begin.index) + REDACTION_PLACEHOLDER;
		cursor = replacementEnd;
		beginPattern.lastIndex = replacementEnd;
		count += 1;
	}
	return {
		text: text + input.slice(cursor),
		replacements: count ? [{ category: "private-key", count }] : [],
	};
}
const seg = "[\\\\/](?:Users|home)[\\\\/][^\\\\/\\s]+";
const rules = [
	{
		category: "private-key",
		scrub: scrubPrivateKeys,
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
			/\b(?:AIza[\w-]{35}|ya29\.[\w-]{20,}|eyJ[\w-]{8,}(?:\.[\w-]{8,}){2}|(?:xox[abposr]|glpat|xai)-[\w-]{10,}|(?:sk_live_|hf_|npm_)\w{16,})/gu,
		replacement: REDACTION_PLACEHOLDER,
	},
	{
		category: "bearer-token",
		pattern: /\b(Bearer[ \t]+)(?!\[REDACTED\])[^\s"'`,;]+/giu,
		replacement: `$1${REDACTION_PLACEHOLDER}`,
	},
	{ category: "credential-assignment", scrub: scrubCredentialAssignments },
	{
		category: "home-directory",
		pattern: new RegExp(`(?<!\\w)(?:${escaped(homedir())}|(?:\\w:)?${seg})(?:${seg})*[\\\\/]?`, "giu"),
		replacement: (match) => (/[\\/]$/u.test(match) ? "~/" : "~"),
	},
	{ category: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, replacement: REDACTION_PLACEHOLDER },
];

export function scrub(text) {
	const replacements = [];
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { text, replacements } = scrub(readFileSync(process.argv[2] ?? 0, "utf8"));
	process.stdout.write(text);
	console.error(
		`Privacy scrubbed: ${replacements.length ? replacements.map(({ category, count }) => `${category} (${count})`).join(", ") : "no replacements needed"}`,
	);
}
