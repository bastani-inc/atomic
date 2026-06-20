import { compilePolicy, invalidPolicyMode } from "./bash-policy-compile.ts";
import { parseBashCommandSegments, wholeCommandTarget } from "./bash-policy-parser.ts";
import type {
	BashCommandParseResult,
	BashCommandPolicy,
	BashCommandPolicyDecision,
	BashCommandRule,
	CompiledBashCommandPolicy,
	CompiledRule,
} from "./bash-policy-types.ts";

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
