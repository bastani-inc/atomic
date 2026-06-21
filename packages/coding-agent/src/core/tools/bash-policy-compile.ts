import type {
	BashCommandPolicy,
	BashCommandPolicyMatchMode,
	BashCommandRule,
	CompiledRule,
	CompileResult,
	CompileRuleResult,
	CompileRulesResult,
} from "./bash-policy-types.ts";

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

export function compilePolicy(policy: BashCommandPolicy): CompileResult {
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

export function invalidPolicyMode(policy: BashCommandPolicy): BashCommandPolicyMatchMode {
	if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return "segments";
	return policy.match === "whole" ? "whole" : "segments";
}
