export type BashCommandRule =
	| string
	| { readonly prefix: string }
	| { readonly glob: string }
	| { readonly regex: string; readonly flags?: string };

export type BashCommandPolicyDefault = "allow" | "deny";
export type BashCommandPolicyMatchMode = "whole" | "segments";

export interface BashCommandPolicy {
	readonly default?: BashCommandPolicyDefault;
	readonly allow?: readonly BashCommandRule[];
	readonly deny?: readonly BashCommandRule[];
	readonly match?: BashCommandPolicyMatchMode;
}

export type BashCommandSegmentSource = "top-level" | "command-substitution" | "process-substitution" | "backtick";

export interface BashCommandSegment {
	readonly raw: string;
	readonly target: string;
	readonly head: string;
	readonly start: number;
	readonly end: number;
	readonly source: BashCommandSegmentSource;
}

export interface BashCommandParseError {
	readonly reason: string;
	readonly offset: number;
	readonly source: BashCommandSegmentSource;
}

export type BashCommandParseResult =
	| { readonly ok: true; readonly segments: readonly BashCommandSegment[] }
	| { readonly ok: false; readonly error: BashCommandParseError };

export type BashCommandPolicyDenialReason =
	| "invalid-policy"
	| "unsupported-shell-syntax"
	| "matched-deny"
	| "default-deny";

export interface BashCommandPolicyRejection {
	readonly reason: BashCommandPolicyDenialReason;
	readonly message: string;
	readonly target?: BashCommandSegment;
	readonly matchedRule?: BashCommandRule;
	readonly parseError?: BashCommandParseError;
}

export type BashCommandPolicyDecision =
	| {
			readonly allowed: true;
			readonly mode: BashCommandPolicyMatchMode;
			readonly targets: readonly BashCommandSegment[];
	  }
	| {
			readonly allowed: false;
			readonly mode: BashCommandPolicyMatchMode;
			readonly targets: readonly BashCommandSegment[];
			readonly rejection: BashCommandPolicyRejection;
	  };

type CompiledRule =
	| { readonly kind: "exact"; readonly source: BashCommandRule; readonly value: string }
	| { readonly kind: "prefix"; readonly source: BashCommandRule; readonly value: string }
	| { readonly kind: "glob"; readonly source: BashCommandRule; readonly value: RegExp }
	| { readonly kind: "regex"; readonly source: BashCommandRule; readonly value: RegExp };

interface CompiledBashCommandPolicy {
	readonly defaultDecision: BashCommandPolicyDefault;
	readonly match: BashCommandPolicyMatchMode;
	readonly allow: readonly CompiledRule[];
	readonly deny: readonly CompiledRule[];
}

type CompileResult =
	| { readonly ok: true; readonly policy: CompiledBashCommandPolicy }
	| { readonly ok: false; readonly message: string };

type CompileRuleResult =
	| { readonly ok: true; readonly rule: CompiledRule }
	| { readonly ok: false; readonly message: string };

type CompileRulesResult =
	| { readonly ok: true; readonly rules: readonly CompiledRule[] }
	| { readonly ok: false; readonly message: string };

type SegmentBuildResult =
	| { readonly ok: true; readonly segment?: BashCommandSegment }
	| { readonly ok: false; readonly error: BashCommandParseError };

type ClosingParenResult =
	| { readonly ok: true; readonly closeIndex: number }
	| { readonly ok: false; readonly reason: string; readonly offset: number };

type ClosingBacktickResult =
	| { readonly ok: true; readonly closeIndex: number }
	| { readonly ok: false; readonly reason: string; readonly offset: number };

type ShellQuoteState = "none" | "single" | "double";

interface ShellWordMetadata {
	readonly sawSingleQuote: boolean;
	readonly sawDoubleQuote: boolean;
	readonly sawEscape: boolean;
	readonly sawParameterExpansion: boolean;
	readonly sawCommandSubstitution: boolean;
	readonly sawProcessSubstitution: boolean;
	readonly sawBacktick: boolean;
	readonly sawGlobPattern: boolean;
	readonly sawBraceExpansion: boolean;
	readonly sawTildePrefix: boolean;
}

type ShellWordReadResult =
	| { readonly ok: true; readonly word: string; readonly end: number; readonly metadata: ShellWordMetadata }
	| { readonly ok: false; readonly reason: string; readonly offset: number };

type LiteralCommandHeadValidation =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

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

const DIAGNOSTIC_TEXT_LIMIT = 220;

function truncateDiagnostic(text: string): string {
	if (text.length <= DIAGNOSTIC_TEXT_LIMIT) return text;
	return `${text.slice(0, DIAGNOSTIC_TEXT_LIMIT - 1)}…`;
}

type RuntimePropertyValue =
	| string
	| number
	| boolean
	| bigint
	| symbol
	| null
	| object
	| ((...args: readonly never[]) => RuntimePropertyValue)
	| undefined;

type RuleObjectKey = "prefix" | "glob" | "regex" | "flags";

const BASH_POLICY_TOP_LEVEL_KEYS = ["default", "allow", "deny", "match"] as const;
const BASH_POLICY_TOP_LEVEL_KEY_SET: ReadonlySet<string> = new Set(BASH_POLICY_TOP_LEVEL_KEYS);

function hasOwnRuleKey<Key extends RuleObjectKey>(
	value: object,
	key: Key,
): value is Record<Key, RuntimePropertyValue> {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyRuleKeys(value: object, allowedKeys: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function unknownBashPolicyTopLevelKeys(policy: object): readonly string[] {
	return Object.keys(policy).filter((key) => !BASH_POLICY_TOP_LEVEL_KEY_SET.has(key));
}

function escapeRegexLiteral(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function escapeGlobClassCharacter(char: string): string {
	if (char === "\\") return "\\\\";
	if (char === "]") return "\\]";
	if (char === "[") return "\\[";
	return char;
}

function escapeEscapedGlobClassCharacter(char: string): string {
	if (char === "\\") return "\\\\";
	if (char === "-") return "\\-";
	if (char === "^") return "\\^";
	if (char === "]") return "\\]";
	if (char === "[") return "\\[";
	return char;
}

function readGlobBracketClass(
	pattern: string,
	openIndex: number,
): { readonly regexSource: string; readonly closeIndex: number } | undefined {
	let cursor = openIndex + 1;
	let negated = false;
	let hasContent = false;
	let content = "";

	if (cursor >= pattern.length) return undefined;
	if (pattern[cursor] === "!" || pattern[cursor] === "^") {
		negated = true;
		cursor += 1;
	}
	if (pattern[cursor] === "]") {
		content += "\\]";
		hasContent = true;
		cursor += 1;
	}

	for (; cursor < pattern.length; cursor += 1) {
		const char = pattern[cursor]!;
		if (char === "]") {
			if (!hasContent) return undefined;
			return { regexSource: `[${negated ? "^" : ""}${content}]`, closeIndex: cursor };
		}
		hasContent = true;
		if (char === "\\" && cursor + 1 < pattern.length) {
			cursor += 1;
			content += escapeEscapedGlobClassCharacter(pattern[cursor]!);
			continue;
		}
		content += escapeGlobClassCharacter(char);
	}

	return undefined;
}

function compileCommandStringGlob(pattern: string): RegExp {
	let source = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index]!;
		if (char === "*") {
			source += ".*";
			continue;
		}
		if (char === "?") {
			source += ".";
			continue;
		}
		if (char === "[") {
			const bracket = readGlobBracketClass(pattern, index);
			if (bracket !== undefined) {
				source += bracket.regexSource;
				index = bracket.closeIndex;
				continue;
			}
		}
		if (char === "\\" && index + 1 < pattern.length) {
			index += 1;
			source += escapeRegexLiteral(pattern[index]!);
			continue;
		}
		source += escapeRegexLiteral(char);
	}
	return new RegExp(`${source}$`);
}

function compileRule(rule: BashCommandRule, listName: "allow" | "deny", index: number): CompileRuleResult {
	if (typeof rule === "string") {
		if (rule.length === 0) {
			return { ok: false, message: `${listName}[${index}] exact rule must not be empty` };
		}
		return { ok: true, rule: { kind: "exact", source: rule, value: rule } };
	}

	if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
		return { ok: false, message: `${listName}[${index}] rule must be a non-empty string or an object rule` };
	}

	const hasPrefix = hasOwnRuleKey(rule, "prefix");
	const hasGlob = hasOwnRuleKey(rule, "glob");
	const hasRegex = hasOwnRuleKey(rule, "regex");
	const variantCount = (hasPrefix ? 1 : 0) + (hasGlob ? 1 : 0) + (hasRegex ? 1 : 0);
	if (variantCount !== 1) {
		return {
			ok: false,
			message: `${listName}[${index}] must specify exactly one of prefix, glob, or regex`,
		};
	}

	if (hasPrefix) {
		if (!hasOnlyRuleKeys(rule, ["prefix"])) {
			return { ok: false, message: `${listName}[${index}] prefix rule must only contain prefix` };
		}
		if (typeof rule.prefix !== "string") {
			return { ok: false, message: `${listName}[${index}].prefix must be a string` };
		}
		if (rule.prefix.length === 0) {
			return { ok: false, message: `${listName}[${index}].prefix must not be empty` };
		}
		return { ok: true, rule: { kind: "prefix", source: rule, value: rule.prefix } };
	}

	if (hasGlob) {
		if (!hasOnlyRuleKeys(rule, ["glob"])) {
			return { ok: false, message: `${listName}[${index}] glob rule must only contain glob` };
		}
		if (typeof rule.glob !== "string") {
			return { ok: false, message: `${listName}[${index}].glob must be a string` };
		}
		if (rule.glob.length === 0) {
			return { ok: false, message: `${listName}[${index}].glob must not be empty` };
		}
		try {
			return { ok: true, rule: { kind: "glob", source: rule, value: compileCommandStringGlob(rule.glob) } };
		} catch {
			return { ok: false, message: `${listName}[${index}].glob is not a valid command string glob` };
		}
	}

	if (!hasOnlyRuleKeys(rule, ["regex", "flags"])) {
		return { ok: false, message: `${listName}[${index}] regex rule must only contain regex and optional flags` };
	}
	if (typeof rule.regex !== "string") {
		return { ok: false, message: `${listName}[${index}].regex must be a string` };
	}
	if (rule.regex.length === 0) {
		return { ok: false, message: `${listName}[${index}].regex must not be empty` };
	}
	const hasFlags = hasOwnRuleKey(rule, "flags");
	if (hasFlags && typeof rule.flags !== "string") {
		return { ok: false, message: `${listName}[${index}].flags must be a string when present` };
	}
	const flags = hasFlags && typeof rule.flags === "string" ? rule.flags : "";
	if (/[gy]/.test(flags)) {
		return {
			ok: false,
			message: `${listName}[${index}].flags must not include stateful g or y regex flags`,
		};
	}
	try {
		return { ok: true, rule: { kind: "regex", source: rule, value: new RegExp(rule.regex, flags) } };
	} catch {
		return { ok: false, message: `${listName}[${index}].regex is not a valid JavaScript RegExp` };
	}
}

function compileRules(rules: readonly BashCommandRule[] | undefined, listName: "allow" | "deny"): CompileRulesResult {
	const compiled: CompiledRule[] = [];
	if (rules === undefined) return { ok: true, rules: compiled };
	for (let index = 0; index < rules.length; index += 1) {
		const rule = rules[index]!;
		const result = compileRule(rule, listName, index);
		if (!result.ok) return result;
		compiled.push(result.rule);
	}
	return { ok: true, rules: compiled };
}

function compilePolicy(policy: BashCommandPolicy): CompileResult {
	if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
		return { ok: false, message: "bash policy must be a non-null object" };
	}

	const unknownKeys = unknownBashPolicyTopLevelKeys(policy);
	if (unknownKeys.length > 0) {
		const formattedKeys = unknownKeys.map((key) => JSON.stringify(key)).join(", ");
		return {
			ok: false,
			message: `bash policy contains unknown top-level key${unknownKeys.length === 1 ? "" : "s"} ${formattedKeys}; allowed keys are default, allow, deny, and match`,
		};
	}

	const defaultDecision = policy.default === undefined ? "allow" : policy.default;
	if (defaultDecision !== "allow" && defaultDecision !== "deny") {
		return { ok: false, message: `bash policy default must be "allow" or "deny"` };
	}
	const match = policy.match === undefined ? "segments" : policy.match;
	if (match !== "whole" && match !== "segments") {
		return { ok: false, message: `bash policy match must be "whole" or "segments"` };
	}
	if (policy.allow !== undefined && !Array.isArray(policy.allow)) {
		return { ok: false, message: "bash policy allow must be an array" };
	}
	if (policy.deny !== undefined && !Array.isArray(policy.deny)) {
		return { ok: false, message: "bash policy deny must be an array" };
	}

	const allow = compileRules(policy.allow, "allow");
	if (!allow.ok) return allow;
	const deny = compileRules(policy.deny, "deny");
	if (!deny.ok) return deny;

	return {
		ok: true,
		policy: {
			defaultDecision,
			match,
			allow: allow.rules,
			deny: deny.rules,
		},
	};
}

export function validateBashCommandPolicy(policy: BashCommandPolicy): void {
	const compiled = compilePolicy(policy);
	if (!compiled.ok) {
		throw new Error(`Invalid bash command policy: ${compiled.message}`);
	}
}

function shellError(reason: string, offset: number, source: BashCommandSegmentSource): BashCommandParseResult {
	return { ok: false, error: { reason, offset, source } };
}

function isWhitespace(char: string): boolean {
	return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function lineTerminatorLengthAt(input: string, index: number): number {
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

function operatorLengthAt(input: string, index: number): number {
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

function isHereDocumentAt(input: string, index: number): boolean {
	return input[index] === "<" && input[index + 1] === "<";
}

function isCommandSubstitutionAt(input: string, index: number): boolean {
	return input[index] === "$" && input[index + 1] === "(";
}

function isProcessSubstitutionAt(input: string, index: number): boolean {
	const char = input[index];
	return (char === "<" || char === ">") && input[index + 1] === "(";
}

function findClosingBacktick(input: string, openIndex: number): ClosingBacktickResult {
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

function findClosingParen(input: string, openIndex: number, construct: string): ClosingParenResult {
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

function readShellWord(input: string, start: number): ShellWordReadResult {
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

interface AttachedRedirectionToken {
	readonly token: string;
	readonly offset: number;
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

function buildSegment(
	rawSegment: string,
	absoluteStart: number,
	absoluteEnd: number,
	source: BashCommandSegmentSource,
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

function parseSegmentsInSource(
	input: string,
	baseOffset: number,
	source: BashCommandSegmentSource,
): BashCommandParseResult {
	const segments: BashCommandSegment[] = [];
	let quote: ShellQuoteState = "none";
	let segmentStart = 0;
	let nestedForCurrentSegment: BashCommandSegment[] = [];

	const commitSegment = (end: number): BashCommandParseResult | undefined => {
		const built = buildSegment(input.slice(segmentStart, end), baseOffset + segmentStart, baseOffset + end, source);
		if (!built.ok) return { ok: false, error: built.error };
		if (built.segment) segments.push(built.segment);
		segments.push(...nestedForCurrentSegment);
		nestedForCurrentSegment = [];
		return undefined;
	};

	for (let i = 0; i < input.length; i += 1) {
		const char = input[i]!;

		if (quote === "single") {
			if (char === "'") quote = "none";
			continue;
		}

		if (char === "\\") {
			if (i + 1 >= input.length) {
				return shellError("trailing escape", baseOffset + i, source);
			}
			i += 1;
			continue;
		}

		if (quote === "double") {
			if (char === "\"") {
				quote = "none";
				continue;
			}
			if (isCommandSubstitutionAt(input, i)) {
				const close = findClosingParen(input, i + 1, "command substitution `$(`");
				if (!close.ok) return shellError(close.reason, baseOffset + close.offset, source);
				const nested = parseSegmentsInSource(input.slice(i + 2, close.closeIndex), baseOffset + i + 2, "command-substitution");
				if (!nested.ok) return nested;
				nestedForCurrentSegment.push(...nested.segments);
				i = close.closeIndex;
				continue;
			}
			if (char === "`") {
				const close = findClosingBacktick(input, i);
				if (!close.ok) return shellError(close.reason, baseOffset + close.offset, source);
				const nested = parseSegmentsInSource(input.slice(i + 1, close.closeIndex), baseOffset + i + 1, "backtick");
				if (!nested.ok) return nested;
				nestedForCurrentSegment.push(...nested.segments);
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
		if (isHereDocumentAt(input, i)) {
			return shellError("here-documents are not supported by bash policy segments mode", baseOffset + i, source);
		}
		if (isCommandSubstitutionAt(input, i)) {
			const close = findClosingParen(input, i + 1, "command substitution `$(`");
			if (!close.ok) return shellError(close.reason, baseOffset + close.offset, source);
			const nested = parseSegmentsInSource(input.slice(i + 2, close.closeIndex), baseOffset + i + 2, "command-substitution");
			if (!nested.ok) return nested;
			nestedForCurrentSegment.push(...nested.segments);
			i = close.closeIndex;
			continue;
		}
		if (isProcessSubstitutionAt(input, i)) {
			const close = findClosingParen(input, i + 1, "process substitution");
			if (!close.ok) return shellError(close.reason, baseOffset + close.offset, source);
			const nested = parseSegmentsInSource(input.slice(i + 2, close.closeIndex), baseOffset + i + 2, "process-substitution");
			if (!nested.ok) return nested;
			nestedForCurrentSegment.push(...nested.segments);
			i = close.closeIndex;
			continue;
		}
		if (char === "`") {
			const close = findClosingBacktick(input, i);
			if (!close.ok) return shellError(close.reason, baseOffset + close.offset, source);
			const nested = parseSegmentsInSource(input.slice(i + 1, close.closeIndex), baseOffset + i + 1, "backtick");
			if (!nested.ok) return nested;
			nestedForCurrentSegment.push(...nested.segments);
			i = close.closeIndex;
			continue;
		}
		if (char === "(" || char === ")") {
			return shellError("unsupported shell grouping parentheses", baseOffset + i, source);
		}

		const lineTerminatorLength = lineTerminatorLengthAt(input, i);
		if (lineTerminatorLength > 0) {
			const committed = commitSegment(i);
			if (committed) return committed;
			i += lineTerminatorLength - 1;
			segmentStart = i + 1;
			continue;
		}

		const operatorLength = operatorLengthAt(input, i);
		if (operatorLength > 0) {
			const committed = commitSegment(i);
			if (committed) return committed;
			i += operatorLength - 1;
			segmentStart = i + 1;
		}
	}

	if (quote === "single") return shellError("unclosed single quote", baseOffset + input.length, source);
	if (quote === "double") return shellError("unclosed double quote", baseOffset + input.length, source);
	const committed = commitSegment(input.length);
	if (committed) return committed;
	return { ok: true, segments };
}

export function parseBashCommandSegments(command: string): BashCommandParseResult {
	return parseSegmentsInSource(command, 0, "top-level");
}

function wholeCommandTarget(command: string): BashCommandSegment {
	const target = command;
	const trimmed = command.trimStart();
	const leading = command.length - trimmed.length;
	const firstSpace = trimmed.search(/\s/);
	const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
	return {
		raw: command,
		target,
		head,
		start: leading,
		end: command.length,
		source: "top-level",
	};
}

function ruleMatches(rule: CompiledRule, target: string): boolean {
	switch (rule.kind) {
		case "exact":
			return target === rule.value;
		case "prefix":
			return target.startsWith(rule.value);
		case "glob":
			return rule.value.test(target);
		case "regex":
			return rule.value.test(target);
	}
}

function firstMatchingRule(rules: readonly CompiledRule[], target: string): BashCommandRule | undefined {
	for (const rule of rules) {
		if (ruleMatches(rule, target)) return rule.source;
	}
	return undefined;
}

function invalidPolicyMode(policy: BashCommandPolicy): BashCommandPolicyMatchMode {
	if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return "segments";
	return policy.match === "whole" ? "whole" : "segments";
}

function isNoRuleDefaultAllowPolicy(policy: CompiledBashCommandPolicy): boolean {
	return policy.defaultDecision === "allow" && policy.allow.length === 0 && policy.deny.length === 0;
}

export function evaluateBashCommandPolicy(
	command: string,
	policy: BashCommandPolicy | undefined,
): BashCommandPolicyDecision {
	if (policy === undefined) {
		return { allowed: true, mode: "segments", targets: [] };
	}

	const compiled = compilePolicy(policy);
	if (!compiled.ok) {
		return {
			allowed: false,
			mode: invalidPolicyMode(policy),
			targets: [],
			rejection: {
				reason: "invalid-policy",
				message: compiled.message,
			},
		};
	}

	const activePolicy = compiled.policy;
	if (isNoRuleDefaultAllowPolicy(activePolicy)) {
		return { allowed: true, mode: activePolicy.match, targets: [] };
	}

	const targetsResult: BashCommandParseResult = activePolicy.match === "whole"
		? { ok: true, segments: [wholeCommandTarget(command)] }
		: parseBashCommandSegments(command);

	if (!targetsResult.ok) {
		return {
			allowed: false,
			mode: activePolicy.match,
			targets: [],
			rejection: {
				reason: "unsupported-shell-syntax",
				message: targetsResult.error.reason,
				parseError: targetsResult.error,
			},
		};
	}

	for (const target of targetsResult.segments) {
		const denyRule = firstMatchingRule(activePolicy.deny, target.target);
		if (denyRule !== undefined) {
			return {
				allowed: false,
				mode: activePolicy.match,
				targets: targetsResult.segments,
				rejection: {
					reason: "matched-deny",
					message: `command ${JSON.stringify(target.head)} matched a deny rule`,
					target,
					matchedRule: denyRule,
				},
			};
		}

		const allowRule = firstMatchingRule(activePolicy.allow, target.target);
		if (allowRule !== undefined || activePolicy.defaultDecision === "allow") {
			continue;
		}

		return {
			allowed: false,
			mode: activePolicy.match,
			targets: targetsResult.segments,
			rejection: {
				reason: "default-deny",
				message: `command ${JSON.stringify(target.head)} is not permitted by default-deny bash policy`,
				target,
			},
		};
	}

	return { allowed: true, mode: activePolicy.match, targets: targetsResult.segments };
}

function formatRule(rule: BashCommandRule): string {
	if (typeof rule === "string") return JSON.stringify(rule);
	if ("prefix" in rule) return `{ prefix: ${JSON.stringify(rule.prefix)} }`;
	if ("glob" in rule) return `{ glob: ${JSON.stringify(rule.glob)} }`;
	return rule.flags === undefined
		? `{ regex: ${JSON.stringify(rule.regex)} }`
		: `{ regex: ${JSON.stringify(rule.regex)}, flags: ${JSON.stringify(rule.flags)} }`;
}

export function formatBashCommandPolicyRejection(
	decision: Extract<BashCommandPolicyDecision, { readonly allowed: false }>,
	policyLabel = "bash command policy",
): string {
	const lines = [`Bash command blocked by ${policyLabel}.`, ""];
	const rejection = decision.rejection;

	if (rejection.reason === "unsupported-shell-syntax") {
		lines.push(
			"The command uses shell syntax that Atomic cannot safely parse in `segments` mode.",
			`Reason: ${rejection.message}.`,
		);
		if (rejection.parseError) {
			lines.push(`Parser source: ${rejection.parseError.source} at offset ${rejection.parseError.offset}.`);
		}
		lines.push(
			"Use match: \"whole\" only if the caller intentionally accepts raw-command matching semantics.",
		);
	} else if (rejection.reason === "invalid-policy") {
		lines.push("The configured bash command policy is invalid.", `Reason: ${rejection.message}.`);
	} else {
		const target = rejection.target;
		if (target) {
			lines.push(
				`Command head: \`${truncateDiagnostic(target.head)}\``,
				`Rejected ${decision.mode === "whole" ? "command" : "segment"}: \`${truncateDiagnostic(target.target)}\``,
				`Segment source: ${target.source}`,
			);
		}
		if (rejection.reason === "matched-deny") {
			lines.push("Reason: matched a deny rule; deny rules take precedence over allow rules.");
			if (rejection.matchedRule !== undefined) {
				lines.push(`Matched deny rule: ${formatRule(rejection.matchedRule)}`);
			}
		} else {
			lines.push("Reason: no allow rule matched and the policy default is deny.");
		}
	}

	lines.push(`Policy mode: ${decision.mode}.`, "", "No shell process was started.");
	return lines.join("\n");
}
