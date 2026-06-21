import type {
	ClosingBacktickResult,
	ClosingParenResult,
	ShellQuoteState,
	ShellWordMetadata,
	ShellWordReadResult,
} from "./bash-policy-types.ts";

export function isWhitespace(char: string): boolean {
	return char === " " || char === "\t" || char === "\n" || char === "\r";
}

export function lineTerminatorLengthAt(input: string, index: number): number {
	const char = input[index];
	if (char === "\r") return input[index + 1] === "\n" ? 2 : 1;
	if (char === "\n") return 1;
	return 0;
}

function previousNonWhitespace(input: string, index: number): string | undefined {
	for (let i = index - 1; i >= 0; i -= 1) {
		const char = input[i]!;
		if (!isWhitespace(char)) return char;
	}
	return undefined;
}

function isRedirectionAmpersand(input: string, index: number): boolean {
	const previous = previousNonWhitespace(input, index);
	const next = input[index + 1];
	return previous === ">" || previous === "<" || next === ">";
}

export function operatorLengthAt(input: string, index: number): number {
	const char = input[index];
	const next = input[index + 1];
	if (char === "|" && input[index - 1] === ">") return 0;
	if (char === "|" && next === "&") return 2;
	if (char === "&" && next === "&") return 2;
	if (char === "|" && next === "|") return 2;
	if (char === "|") return 1;
	if (char === ";") return 1;
	if (char === "&" && !isRedirectionAmpersand(input, index)) return 1;
	return 0;
}

export function isHereDocumentAt(input: string, index: number): boolean {
	return input[index] === "<" && input[index + 1] === "<";
}

export function isCommandSubstitutionAt(input: string, index: number): boolean {
	return input[index] === "$" && input[index + 1] === "(";
}

export function isProcessSubstitutionAt(input: string, index: number): boolean {
	const char = input[index];
	return (char === "<" || char === ">") && input[index + 1] === "(";
}

export function findClosingBacktick(input: string, openIndex: number): ClosingBacktickResult {
	for (let i = openIndex + 1; i < input.length; i += 1) {
		const char = input[i]!;
		if (char === "\\") {
			if (i + 1 >= input.length) {
				return { ok: false, reason: "trailing escape in backtick command substitution", offset: i };
			}
			i += 1;
			continue;
		}
		if (char === "`") return { ok: true, closeIndex: i };
	}
	return { ok: false, reason: "unclosed backtick command substitution", offset: openIndex };
}

export function findClosingParen(input: string, openIndex: number, construct: string): ClosingParenResult {
	let quote: ShellQuoteState = "none";
	let depth = 1;
	for (let i = openIndex + 1; i < input.length; i += 1) {
		const char = input[i]!;

		if (quote === "single") {
			if (char === "'") quote = "none";
			continue;
		}

		if (char === "\\") {
			if (i + 1 >= input.length) {
				return { ok: false, reason: `trailing escape in ${construct}`, offset: i };
			}
			i += 1;
			continue;
		}

		if (quote === "double") {
			if (char === "\"") {
				quote = "none";
				continue;
			}
			if (isCommandSubstitutionAt(input, i) || isProcessSubstitutionAt(input, i)) {
				depth += 1;
				i += 1;
				continue;
			}
			if (char === "`") {
				const close = findClosingBacktick(input, i);
				if (!close.ok) return close;
				i = close.closeIndex;
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
			depth += 1;
			i += 1;
			continue;
		}
		if (char === "`") {
			const close = findClosingBacktick(input, i);
			if (!close.ok) return close;
			i = close.closeIndex;
			continue;
		}
		if (char === "(") {
			return {
				ok: false,
				reason: `unsupported shell grouping parentheses in ${construct}`,
				offset: i,
			};
		}
		if (char === ")") {
			depth -= 1;
			if (depth === 0) return { ok: true, closeIndex: i };
		}
	}

	if (quote === "single") return { ok: false, reason: `unclosed single quote in ${construct}`, offset: openIndex };
	if (quote === "double") return { ok: false, reason: `unclosed double quote in ${construct}`, offset: openIndex };
	return { ok: false, reason: `unclosed ${construct}`, offset: openIndex };
}

export function readShellWord(input: string, start: number): ShellWordReadResult {
	let quote: ShellQuoteState = "none";
	let sawSingleQuote = false;
	let sawDoubleQuote = false;
	let sawEscape = false;
	let sawParameterExpansion = false;
	let sawCommandSubstitution = false;
	let sawProcessSubstitution = false;
	let sawBacktick = false;
	let sawGlobPattern = false;
	let sawBraceExpansion = false;
	let sawTildePrefix = false;

	const metadata = (): ShellWordMetadata => ({
		sawSingleQuote,
		sawDoubleQuote,
		sawEscape,
		sawParameterExpansion,
		sawCommandSubstitution,
		sawProcessSubstitution,
		sawBacktick,
		sawGlobPattern,
		sawBraceExpansion,
		sawTildePrefix,
	});

	for (let i = start; i < input.length; i += 1) {
		const char = input[i]!;
		if (quote === "single") {
			if (char === "'") quote = "none";
			continue;
		}
		if (char === "\\") {
			sawEscape = true;
			if (i + 1 >= input.length) return { ok: false, reason: "trailing escape in shell word", offset: i };
			i += 1;
			continue;
		}
		if (quote === "double") {
			if (char === "\"") {
				quote = "none";
				continue;
			}
			if (isCommandSubstitutionAt(input, i) || isProcessSubstitutionAt(input, i)) {
				if (isCommandSubstitutionAt(input, i)) {
					sawCommandSubstitution = true;
				} else {
					sawProcessSubstitution = true;
				}
				const close = findClosingParen(input, i + 1, isCommandSubstitutionAt(input, i) ? "command substitution `$(`" : "process substitution");
				if (!close.ok) return { ok: false, reason: close.reason, offset: close.offset };
				i = close.closeIndex;
				continue;
			}
			if (char === "`") {
				sawBacktick = true;
				const close = findClosingBacktick(input, i);
				if (!close.ok) return { ok: false, reason: close.reason, offset: close.offset };
				i = close.closeIndex;
				continue;
			}
			if (char === "$") sawParameterExpansion = true;
			continue;
		}
		if (isWhitespace(char)) {
			return { ok: true, word: input.slice(start, i), end: i, metadata: metadata() };
		}
		if (char === "'") {
			sawSingleQuote = true;
			quote = "single";
			continue;
		}
		if (char === "\"") {
			sawDoubleQuote = true;
			quote = "double";
			continue;
		}
		if (i === start && char === "~") {
			sawTildePrefix = true;
			continue;
		}
		if (isCommandSubstitutionAt(input, i) || isProcessSubstitutionAt(input, i)) {
			if (isCommandSubstitutionAt(input, i)) {
				sawCommandSubstitution = true;
			} else {
				sawProcessSubstitution = true;
			}
			const close = findClosingParen(input, i + 1, isCommandSubstitutionAt(input, i) ? "command substitution `$(`" : "process substitution");
			if (!close.ok) return { ok: false, reason: close.reason, offset: close.offset };
			i = close.closeIndex;
			continue;
		}
		if (char === "`") {
			sawBacktick = true;
			const close = findClosingBacktick(input, i);
			if (!close.ok) return { ok: false, reason: close.reason, offset: close.offset };
			i = close.closeIndex;
			continue;
		}
		if (char === "$") {
			sawParameterExpansion = true;
			continue;
		}
		if (char === "*" || char === "?" || char === "[" || char === "]") {
			sawGlobPattern = true;
			continue;
		}
		if (char === "{" || char === "}") {
			sawBraceExpansion = true;
		}
	}
	if (quote === "single") return { ok: false, reason: "unclosed single quote in shell word", offset: start };
	if (quote === "double") return { ok: false, reason: "unclosed double quote in shell word", offset: start };
	return { ok: true, word: input.slice(start), end: input.length, metadata: metadata() };
}

