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
	/(?<!\w)((?:(?:api|access)[ \t]+)?[\w-]*(?:key|token|password|secret)\d*)["']?([ \t]*)([:=])([ \t]*(?:[*_~`]+)?[ \t]*)/giu;
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
	return /^[ \t]*(?:(?:[-*+])[ \t]+|(?:\d+[.)])[ \t]+)?[*_~`]*$/u.test(linePrefix);
}
function unquotedValueEnd(input: string, start: number, stopLeadingSlash = true): number {
	let end = start;
	while (
		end < input.length &&
		!/[\s,;})\]&|<>("'`]/u.test(input[end] ?? "") &&
		!(stopLeadingSlash && input[end] === "/" && end === start)
	)
		end += 1;
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
	const compactAssignment = prefix.trim() === prefix;
	return (
		compactAssignment || isStrongCredentialName(name) || isLineLeadingCredentialName(name, input, assignmentStart)
	);
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
function scrubCredentialAssignments(input: string): CredentialScrubResult {
	const matches: Array<{ start: number; end: number; replacement: string }> = [];
	let coveredUntil = 0;
	credentialAssignment.lastIndex = 0;
	for (const match of input.matchAll(credentialAssignment)) {
		const assignmentStart = match.index ?? 0;
		if (assignmentStart < coveredUntil) continue;
		const prefix = match[0];
		const keyName = match[1] ?? "";
		const valueStart = assignmentStart + prefix.length;
		const first = input[valueStart];
		if (first === '"' || first === "'") {
			const quote = first;
			let cursor = valueStart + 1;
			let hasContent = false;
			let closed = false;
			while (cursor < input.length && input[cursor] !== "\r" && input[cursor] !== "\n") {
				const character = input[cursor];
				if (character === "\\") {
					const escaped = input[cursor + 1];
					if (escaped === undefined || escaped === "\r" || escaped === "\n") break;
					if (escaped !== "\\") hasContent = true;
					cursor += 2;
					continue;
				}
				if (character === quote) {
					closed = true;
					cursor += 1;
					break;
				}
				hasContent = true;
				cursor += 1;
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
		const openingWrapper = consumedValueWrapper(prefix);
		if (input.startsWith(REDACTION_PLACEHOLDER, valueStart)) {
			const suffixStart = valueStart + REDACTION_PLACEHOLDER.length;
			if (suffixStart >= input.length || /[\s,;})\]&|<>('"`]/u.test(input[suffixStart] ?? "")) continue;
			const suffixEnd = unquotedValueEnd(input, suffixStart, false);
			const wrapperLength = matchingTrailingWrapperLength(input, assignmentStart, valueStart, suffixEnd, keyName);
			const redactedEnd = suffixEnd - wrapperLength;
			if (
				(openingWrapper &&
					suffixEnd === suffixStart + openingWrapper.length &&
					input.slice(suffixStart, suffixEnd) === openingWrapper) ||
				redactedEnd <= suffixStart
			)
				continue;
			matches.push({ start: valueStart, end: redactedEnd, replacement: REDACTION_PLACEHOLDER });
			coveredUntil = redactedEnd;
			continue;
		}
		const end = unquotedValueEnd(input, valueStart);
		const value = input.slice(valueStart, end);
		if (openingWrapper) {
			const hasMatchingWrapper = value.length > openingWrapper.length && value.endsWith(openingWrapper);
			matches.push({
				start: valueStart - openingWrapper.length,
				end,
				replacement: hasMatchingWrapper
					? `${openingWrapper}${REDACTION_PLACEHOLDER}${openingWrapper}`
					: REDACTION_PLACEHOLDER,
			});
			coveredUntil = end;
			continue;
		}
		const redactedEnd = end - matchingTrailingWrapperLength(input, assignmentStart, valueStart, end, keyName);
		const redactedValue = input.slice(valueStart, redactedEnd);
		if (shouldRedactUnquotedValue(keyName, prefix, redactedValue, input, assignmentStart)) {
			matches.push({ start: valueStart, end: redactedEnd, replacement: REDACTION_PLACEHOLDER });
			coveredUntil = redactedEnd;
		}
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
		pattern: /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9+.-]*:\/\/)(?!\[REDACTED\]@)[^\s/?#@]+@/giu,
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
