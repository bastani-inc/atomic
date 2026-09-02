import { homedir } from "node:os";
import type { FormattedFeedbackDraft } from "./templates.js";

export const FEEDBACK_TITLE_MAX_CHARACTERS = 256;
export const FEEDBACK_BODY_MAX_CHARACTERS = 16_000;
export const FEEDBACK_DIAGNOSTIC_MAX_LINES = 12;

export type FeedbackPrivacyField = "title" | "body";
export type FeedbackPrivacyReplacementKind =
	| "api-token"
	| "credential-assignment"
	| "url-credentials"
	| "private-key"
	| "home-directory"
	| "stack-trace"
	| "diagnostic-dump"
	| "size-limit";

export interface FeedbackPrivacyReplacement {
	field: FeedbackPrivacyField;
	kind: FeedbackPrivacyReplacementKind;
	description: string;
	/** Safe replacement text retained in the edited draft, never the removed value. */
	replacement: string;
	/** Offset of the replacement in the current field text. */
	start: number;
}

export interface FeedbackPrivacyOptions {
	/** Trusted internal suffix included within the body limit after scrubbing caller text. */
	bodySuffix?: string;
	homeDirectories?: readonly string[];
}

export interface ScrubbedFeedbackDraft {
	draft: FormattedFeedbackDraft;
	replacements: FeedbackPrivacyReplacement[];
}

interface ReplacementCandidate {
	start: number;
	end: number;
	replacement: string;
	kind: Exclude<FeedbackPrivacyReplacementKind, "size-limit">;
}

const API_TOKEN_PATTERN =
	/(?<![A-Za-z0-9_-])(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{35}|npm_[A-Za-z0-9]{36,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]{20,})(?![A-Za-z0-9_-])/g;
const CREDENTIAL_ASSIGNMENT_PATTERN =
	/\b(?:TOKEN|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|[A-Z][A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD))\b(\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi;
const PRIVATE_KEY_HEADER_PATTERN = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[ \t]*(?:\r?\n|$)/g;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addPatternCandidates(
	text: string,
	pattern: RegExp,
	kind: ReplacementCandidate["kind"],
	replacement: (match: RegExpExecArray) => string,
	candidates: ReplacementCandidate[],
): void {
	pattern.lastIndex = 0;
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		candidates.push({
			start: match.index,
			end: match.index + match[0].length,
			replacement: replacement(match),
			kind,
		});
		if (match[0].length === 0) pattern.lastIndex += 1;
	}
}

function privateKeyEnd(text: string, label: string, afterHeader: number): number {
	const marker = `-----END ${label}-----`;
	for (let start = text.indexOf(marker, afterHeader); start !== -1; start = text.indexOf(marker, start + 1)) {
		const atLineStart = start === 0 || text[start - 1] === "\n";
		const after = start + marker.length;
		const atLineEnd = after === text.length || text[after] === "\r" || text[after] === "\n";
		if (atLineStart && atLineEnd) return text[after] === "\r" ? after + 1 : after;
	}
	return text.length;
}

function addPrivateKeyCandidates(text: string, candidates: ReplacementCandidate[]): void {
	PRIVATE_KEY_HEADER_PATTERN.lastIndex = 0;
	for (let match = PRIVATE_KEY_HEADER_PATTERN.exec(text); match; match = PRIVATE_KEY_HEADER_PATTERN.exec(text)) {
		const label = match[1];
		if (!label) continue;
		const end = privateKeyEnd(text, label, PRIVATE_KEY_HEADER_PATTERN.lastIndex);
		candidates.push({ start: match.index, end, replacement: "[REDACTED PRIVATE KEY]", kind: "private-key" });
		PRIVATE_KEY_HEADER_PATTERN.lastIndex = end;
	}
}

function lineRanges(text: string): Array<{ start: number; end: number; value: string }> {
	const lines: Array<{ start: number; end: number; value: string }> = [];
	let start = 0;
	while (start < text.length) {
		const newline = text.indexOf("\n", start);
		const end = newline === -1 ? text.length : newline + 1;
		lines.push({ start, end, value: text.slice(start, newline === -1 ? text.length : newline) });
		start = end;
	}
	return lines;
}

function addLongLineRunCandidates(
	text: string,
	kind: "stack-trace" | "diagnostic-dump",
	isMatchingLine: (line: string) => boolean,
	candidates: ReplacementCandidate[],
): void {
	const lines = lineRanges(text);
	let runStart = 0;
	while (runStart < lines.length) {
		if (!isMatchingLine(lines[runStart].value)) {
			runStart += 1;
			continue;
		}
		let runEnd = runStart + 1;
		while (runEnd < lines.length && isMatchingLine(lines[runEnd].value)) runEnd += 1;
		const count = runEnd - runStart;
		if (count > FEEDBACK_DIAGNOSTIC_MAX_LINES) {
			const label = kind === "stack-trace" ? "stack trace bounded" : "diagnostic dump omitted";
			candidates.push({
				start: lines[runStart].start,
				end: lines[runEnd - 1].end,
				replacement: `[Atomic feedback privacy review: ${label}; ${count} lines omitted.]${
					lines[runEnd - 1].end < text.length ? "\n" : ""
				}`,
				kind,
			});
		}
		runStart = runEnd;
	}
}

function isStackTraceLine(line: string): boolean {
	return (
		/^\s+at\b/u.test(line) ||
		/^\s*File ".+", line \d+\b/u.test(line) ||
		/^Caused by:/u.test(line) ||
		/^\s*\d+:\s+(?:(?:0x[\da-f]+\s+-\s+)?\S*::\S+)\s*$/iu.test(line) ||
		/^\s+at .+\.rs:\d+(?::\d+)?\s*$/u.test(line) ||
		/^goroutine \d+ \[[^\]]+\]:\s*$/u.test(line) ||
		/^(?:created by )?[A-Za-z0-9_./<>-]+(?:\.[A-Za-z0-9_<>-]+)+\(.*\)\s*$/u.test(line) ||
		/^\s+.+\.go:\d+(?:\s+\+0x[\da-f]+)?\s*$/iu.test(line)
	);
}

function isJsonDiagnosticLine(line: string): boolean {
	return /^\s*(?:(?:[{}]|\[|\])[,]?|"(?:[^"\\]|\\.)*"\s*(?::\s*.*)?[,]?|-?\d+(?:\.\d+)?[,]?|true[,]?|false[,]?|null[,]?)\s*$/u.test(
		line,
	);
}

function collectCandidates(text: string, homeDirectories: readonly string[]): ReplacementCandidate[] {
	const candidates: ReplacementCandidate[] = [];
	addLongLineRunCandidates(text, "stack-trace", isStackTraceLine, candidates);
	addLongLineRunCandidates(
		text,
		"diagnostic-dump",
		(line) => /^[A-Za-z_][A-Za-z0-9_.-]{2,}=.*$/u.test(line) || isJsonDiagnosticLine(line),
		candidates,
	);
	addPrivateKeyCandidates(text, candidates);
	addPatternCandidates(
		text,
		CREDENTIAL_ASSIGNMENT_PATTERN,
		"credential-assignment",
		(match) => {
			const equals = match[0].indexOf("=");
			return `${match[0].slice(0, equals + 1)}[REDACTED]`;
		},
		candidates,
	);
	addPatternCandidates(
		text,
		URL_CREDENTIAL_PATTERN,
		"url-credentials",
		(match) => `${match[1]}[REDACTED]@`,
		candidates,
	);
	addPatternCandidates(text, API_TOKEN_PATTERN, "api-token", () => "[REDACTED API TOKEN]", candidates);
	for (const homeDirectory of homeDirectories) {
		if (homeDirectory.length === 0) continue;
		const pathPattern = homeDirectory
			.split(/[\\/]+/u)
			.map(escapeRegExp)
			.join("[\\\\/]");
		const caseInsensitive = /^[A-Za-z]:[\\/]/u.test(homeDirectory);
		const pattern = new RegExp(`(?<![A-Za-z0-9_])${pathPattern}(?=$|[\\\\/])`, caseInsensitive ? "gi" : "g");
		addPatternCandidates(text, pattern, "home-directory", () => "~", candidates);
	}
	return candidates.sort((left, right) => left.start - right.start || right.end - left.end);
}

function replacementDescription(field: FeedbackPrivacyField, kind: FeedbackPrivacyReplacementKind): string {
	const descriptions: Record<FeedbackPrivacyReplacementKind, string> = {
		"api-token": "API or access token redacted",
		"credential-assignment": "credential assignment value redacted",
		"url-credentials": "URL credentials redacted",
		"private-key": "private key block redacted",
		"home-directory": "home-directory prefix replaced with ~",
		"stack-trace": "unbounded stack trace replaced with a bounded disclosure",
		"diagnostic-dump": "unbounded diagnostic dump omitted",
		"size-limit": "text truncated at the feedback output limit",
	};
	return `${field}: ${descriptions[kind]}`;
}

function applyCandidates(
	text: string,
	field: FeedbackPrivacyField,
	candidates: readonly ReplacementCandidate[],
): { text: string; replacements: FeedbackPrivacyReplacement[] } {
	let cursor = 0;
	let output = "";
	const replacements: FeedbackPrivacyReplacement[] = [];
	for (const candidate of candidates) {
		if (candidate.start < cursor) continue;
		output += text.slice(cursor, candidate.start);
		output += candidate.replacement;
		cursor = candidate.end;
		replacements.push({
			field,
			kind: candidate.kind,
			description: replacementDescription(field, candidate.kind),
			replacement: candidate.replacement,
			start: candidate.start,
		});
	}
	return { text: output + text.slice(cursor), replacements };
}

interface BoundedText {
	text: string;
	truncation?: { replacement: string; start: number };
}

function boundText(text: string, field: FeedbackPrivacyField, limit: number): BoundedText {
	if (text.length <= limit) return { text };
	const separator = field === "body" ? "\n\n" : " ";
	const marker = `${separator}[truncated by Atomic feedback privacy review; privacy-reviewed length ${text.length} characters]`;
	const retainedLength = Math.max(0, limit - marker.length);
	return {
		text: `${text.slice(0, retainedLength)}${marker}`,
		truncation: { replacement: marker, start: retainedLength },
	};
}

function scrubField(
	text: string,
	field: FeedbackPrivacyField,
	limit: number,
	homeDirectories: readonly string[],
): { text: string; replacements: FeedbackPrivacyReplacement[] } {
	const scrubbed = applyCandidates(text, field, collectCandidates(text, homeDirectories));
	const bounded = boundText(scrubbed.text, field, limit);
	if (bounded.truncation) {
		scrubbed.replacements.push({
			field,
			kind: "size-limit",
			description: replacementDescription(field, "size-limit"),
			replacement: bounded.truncation.replacement,
			start: bounded.truncation.start,
		});
	}
	return { text: bounded.text, replacements: scrubbed.replacements };
}

export function scrubFeedbackDraft(
	draft: FormattedFeedbackDraft,
	options: FeedbackPrivacyOptions = {},
): ScrubbedFeedbackDraft {
	const homeDirectories = options.homeDirectories ?? [homedir()];
	const title = scrubField(draft.title, "title", FEEDBACK_TITLE_MAX_CHARACTERS, homeDirectories);
	const bodySuffix = options.bodySuffix ?? "";
	if (bodySuffix.length > FEEDBACK_BODY_MAX_CHARACTERS) {
		throw new Error("Feedback body suffix exceeds the output limit.");
	}
	const body = scrubField(draft.body, "body", FEEDBACK_BODY_MAX_CHARACTERS - bodySuffix.length, homeDirectories);
	return {
		draft: {
			repository: draft.repository,
			kind: draft.kind,
			label: draft.label,
			title: title.text,
			body: `${body.text}${bodySuffix}`,
		},
		replacements: [...title.replacements, ...body.replacements],
	};
}

function fieldText(draft: FormattedFeedbackDraft, field: FeedbackPrivacyField): string {
	return field === "title" ? draft.title : draft.body;
}

function overlaps(start: number, length: number, claimed: readonly { start: number; end: number }[]): boolean {
	const end = start + length;
	return claimed.some((range) => start < range.end && end > range.start);
}

function findUnclaimedOccurrence(
	text: string,
	replacement: string,
	claimed: readonly { start: number; end: number }[],
): number | undefined {
	let start = text.indexOf(replacement);
	while (start !== -1) {
		if (!overlaps(start, replacement.length, claimed)) return start;
		start = text.indexOf(replacement, start + Math.max(1, replacement.length));
	}
	return undefined;
}

function locateCurrentReplacements(
	draft: FormattedFeedbackDraft,
	replacements: readonly FeedbackPrivacyReplacement[],
): FeedbackPrivacyReplacement[] {
	const located: FeedbackPrivacyReplacement[] = [];
	for (const field of ["title", "body"] as const) {
		const text = fieldText(draft, field);
		const claimed: Array<{ start: number; end: number }> = [];
		const candidates = replacements
			.filter((replacement) => replacement.field === field)
			.sort((left, right) => left.start - right.start);
		for (const candidate of candidates) {
			const start = findUnclaimedOccurrence(text, candidate.replacement, claimed);
			if (start === undefined) continue;
			claimed.push({ start, end: start + candidate.replacement.length });
			located.push({ ...candidate, start });
		}
	}
	return located;
}

function replacementLocationKey(replacement: FeedbackPrivacyReplacement): string {
	return `${replacement.field}\u0000${replacement.kind}\u0000${replacement.start}\u0000${replacement.replacement}`;
}

/** Re-scrub edited text while retaining provenance only for replacement text that the user kept. */
export function rescrubFeedbackDraft(
	draft: FormattedFeedbackDraft,
	previousReplacements: readonly FeedbackPrivacyReplacement[],
	options: FeedbackPrivacyOptions = {},
): ScrubbedFeedbackDraft {
	const preserved = locateCurrentReplacements(draft, previousReplacements);
	const preservedLocations = new Set(preserved.map(replacementLocationKey));
	const scrubbed = scrubFeedbackDraft(draft, options);
	const newlyApplied = scrubbed.replacements.filter(
		(replacement) => !preservedLocations.has(replacementLocationKey(replacement)),
	);
	return {
		draft: scrubbed.draft,
		replacements: locateCurrentReplacements(scrubbed.draft, [...preserved, ...newlyApplied]),
	};
}
