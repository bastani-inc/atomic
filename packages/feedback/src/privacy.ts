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
const rules = [
	{
		category: "private-key",
		pattern: /-----BEGIN [^-\n]*PRIVATE KEY[^-\n]*-----(?:[\s\S]*?-----END [^-\n]*PRIVATE KEY[^-\n]*-----|[\s\S]*)/gu,
		replacement: REDACTION_PLACEHOLDER,
	},
	{
		category: "url-credentials",
		pattern: /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/:@]*:[^\s/@]+@/giu,
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
	{
		category: "credential-assignment",
		pattern:
			/(?<!\w)(\w*(?:key|token|password|secret)["']?\s*[:=]\s*)(?:(['"])(?!\[REDACTED\]\2)(?:(?:\\[^\r\n])|(?!\2)[^\r\n])+\2|([A-Za-z0-9+/=_-]{16,}))/giu,
		replacement: `$1$2${REDACTION_PLACEHOLDER}$2`,
	},
	{
		category: "home-directory",
		pattern: new RegExp(`(?<!\\w)(?:${escaped(homedir())}|(?:\\w:)?[\\\\/](?:Users|home)[\\\\/][^\\\\/\\s]+)`, "gu"),
		replacement: "~",
	},
] as const satisfies readonly { category: string; pattern: RegExp; replacement: string }[];
export type RedactionCategory = (typeof rules)[number]["category"];

function scrub(text: string): { text: string; replacements: RedactionSummary[] } {
	const replacements: RedactionSummary[] = [];
	for (const rule of rules) {
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
