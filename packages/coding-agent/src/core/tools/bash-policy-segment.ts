import type { SegmentBuildResult, ShellQuoteState, ShellWordMetadata } from "./bash-policy-types.ts";
import {
	findClosingBacktick,
	findClosingParen,
	isCommandSubstitutionAt,
	isProcessSubstitutionAt,
	isWhitespace,
	readShellWord,
} from "./bash-policy-shell.ts";

const UNSUPPORTED_CONTROL_HEADS = new Set([
	"!",
	"[[",
	"]]",
	"case",
	"coproc",
	"do",
	"done",
	"elif",
	"else",
	"esac",
	"fi",
	"for",
	"function",
	"if",
	"in",
	"select",
	"then",
	"time",
	"until",
	"while",
	"{",
	"}",
]);

type LiteralCommandHeadValidation =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

interface AttachedRedirectionToken {
	readonly token: string;
	readonly offset: number;
}

function isAsciiDigit(char: string | undefined): boolean {
	return char !== undefined && char >= "0" && char <= "9";
}

function leadingRedirectionTokenAt(input: string, index: number): string | undefined {
	let operatorStart = index;
	while (isAsciiDigit(input[operatorStart])) operatorStart += 1;

	const hasDescriptorPrefix = operatorStart > index;
	const char = input[operatorStart];
	const next = input[operatorStart + 1];
	const afterNext = input[operatorStart + 2];

	if (char === undefined) return undefined;
	if (hasDescriptorPrefix && char !== "<" && char !== ">") return undefined;

	if (!hasDescriptorPrefix && (char === "<" || char === ">") && next === "(") {
		return undefined;
	}

	let operator: string | undefined;
	if (char === "&" && next === ">") {
		operator = afterNext === ">" ? "&>>" : "&>";
	} else if (char === "<") {
		if (next === "<") operator = "<<";
		else if (next === "&") operator = "<&";
		else if (next === ">") operator = "<>";
		else operator = "<";
	} else if (char === ">") {
		if (next === ">") operator = ">>";
		else if (next === "|") operator = ">|";
		else if (next === "&") operator = ">&";
		else operator = ">";
	}

	return operator === undefined ? undefined : `${input.slice(index, operatorStart)}${operator}`;
}

function isEnvAssignmentWord(word: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*(?:\+)?=/.test(word);
}

function attachedRedirectionOperatorAt(input: string, index: number): string | undefined {
	const char = input[index];
	const next = input[index + 1];
	const afterNext = input[index + 2];

	if ((char === "<" || char === ">") && next === "(") {
		return undefined;
	}
	if (char === "&" && next === ">") {
		return afterNext === ">" ? "&>>" : "&>";
	}
	if (char === "<") {
		if (next === "<") return "<<";
		if (next === "&") return "<&";
		if (next === ">") return "<>";
		return "<";
	}
	if (char === ">") {
		if (next === ">") return ">>";
		if (next === "|") return ">|";
		if (next === "&") return ">&";
		return ">";
	}
	return undefined;
}

function attachedCommandHeadRedirection(
	input: string,
	start: number,
	end: number,
): AttachedRedirectionToken | undefined {
	let quote: ShellQuoteState = "none";

	for (let i = start; i < end; i += 1) {
		const char = input[i]!;
		if (quote === "single") {
			if (char === "'") quote = "none";
			continue;
		}
		if (char === "\\") {
			i += 1;
			continue;
		}
		if (quote === "double") {
			if (char === "\"") {
				quote = "none";
				continue;
			}
			if (isCommandSubstitutionAt(input, i) || isProcessSubstitutionAt(input, i)) {
				const close = findClosingParen(input, i + 1, isCommandSubstitutionAt(input, i) ? "command substitution `$(`" : "process substitution");
				if (close.ok) i = close.closeIndex;
				continue;
			}
			if (char === "`") {
				const close = findClosingBacktick(input, i);
				if (close.ok) i = close.closeIndex;
			}
			continue;
		}
		if (char === "'") {
			quote = "single";
			continue;
		}
		if (char === "\"") {
			quote = "double";
			continue;
		}
		if (isCommandSubstitutionAt(input, i) || isProcessSubstitutionAt(input, i)) {
			const close = findClosingParen(input, i + 1, isCommandSubstitutionAt(input, i) ? "command substitution `$(`" : "process substitution");
			if (close.ok) i = close.closeIndex;
			continue;
		}
		if (char === "`") {
			const close = findClosingBacktick(input, i);
			if (close.ok) i = close.closeIndex;
			continue;
		}

		const operator = attachedRedirectionOperatorAt(input, i);
		if (operator !== undefined && i > start) {
			return { token: operator, offset: i };
		}
	}

	return undefined;
}

function validateLiteralCommandHead(head: string, metadata: ShellWordMetadata): LiteralCommandHeadValidation {
	if (head.length === 0) {
		return { ok: false, reason: "empty command heads are not supported by bash policy segments mode" };
	}
	if (metadata.sawSingleQuote || metadata.sawDoubleQuote) {
		return { ok: false, reason: "quoted or quote-constructed command heads are not supported by bash policy segments mode" };
	}
	if (metadata.sawEscape) {
		return { ok: false, reason: "escape-constructed command heads are not supported by bash policy segments mode" };
	}
	if (metadata.sawCommandSubstitution || metadata.sawProcessSubstitution || metadata.sawBacktick) {
		return { ok: false, reason: "command, process, and backtick substitutions are not supported in command heads by bash policy segments mode" };
	}
	if (metadata.sawParameterExpansion) {
		return { ok: false, reason: "parameter-expanded command heads are not supported by bash policy segments mode" };
	}
	if (metadata.sawTildePrefix) {
		return { ok: false, reason: "tilde-expanded command heads are not supported by bash policy segments mode" };
	}
	if (metadata.sawGlobPattern) {
		return { ok: false, reason: "glob-expanded command heads are not supported by bash policy segments mode" };
	}
	if (metadata.sawBraceExpansion) {
		return { ok: false, reason: "brace-expanded command heads are not supported by bash policy segments mode" };
	}
	return { ok: true };
}

export function buildSegment(
	rawSegment: string,
	absoluteStart: number,
	absoluteEnd: number,
	source: "top-level" | "command-substitution" | "process-substitution" | "backtick",
): SegmentBuildResult {
	let cursor = 0;
	while (cursor < rawSegment.length && isWhitespace(rawSegment[cursor]!)) cursor += 1;
	if (cursor >= rawSegment.length) return { ok: true };

	while (cursor < rawSegment.length) {
		while (cursor < rawSegment.length && isWhitespace(rawSegment[cursor]!)) cursor += 1;
		if (cursor >= rawSegment.length) return { ok: true };

		const leadingRedirection = leadingRedirectionTokenAt(rawSegment, cursor);
		if (leadingRedirection !== undefined) {
			return {
				ok: false,
				error: {
					reason: `leading shell redirection ${JSON.stringify(leadingRedirection)} is not supported by bash policy segments mode`,
					offset: absoluteStart + cursor,
					source,
				},
			};
		}

		const word = readShellWord(rawSegment, cursor);
		if (!word.ok) {
			return {
				ok: false,
				error: { reason: word.reason, offset: absoluteStart + word.offset, source },
			};
		}

		const attachedRedirection = attachedCommandHeadRedirection(rawSegment, cursor, word.end);
		if (attachedRedirection !== undefined) {
			return {
				ok: false,
				error: {
					reason: `attached shell redirection ${JSON.stringify(attachedRedirection.token)} in the command head is not supported by bash policy segments mode`,
					offset: absoluteStart + attachedRedirection.offset,
					source,
				},
			};
		}

		if (isEnvAssignmentWord(word.word)) {
			return {
				ok: false,
				error: {
					reason: "environment assignment words are not supported by bash policy segments mode",
					offset: absoluteStart + cursor,
					source,
				},
			};
		}

		const target = rawSegment.slice(cursor).trim();
		const head = word.word;
		if (UNSUPPORTED_CONTROL_HEADS.has(head)) {
			return {
				ok: false,
				error: {
					reason: `unsupported shell reserved or compound syntax starting with ${JSON.stringify(head)}`,
					offset: absoluteStart + cursor,
					source,
				},
			};
		}
		const literalHead = validateLiteralCommandHead(head, word.metadata);
		if (!literalHead.ok) {
			return {
				ok: false,
				error: {
					reason: literalHead.reason,
					offset: absoluteStart + cursor,
					source,
				},
			};
		}

		return {
			ok: true,
			segment: {
				raw: rawSegment.trim(),
				target,
				head,
				start: absoluteStart + cursor,
				end: absoluteEnd,
				source,
			},
		};
	}

	return { ok: true };
}
