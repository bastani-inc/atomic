import type { BashCommandPolicyDecision, BashCommandRule } from "./bash-policy-types.ts";

const DIAGNOSTIC_TEXT_LIMIT = 220;

function truncateDiagnostic(text: string): string {
	if (text.length <= DIAGNOSTIC_TEXT_LIMIT) return text;
	return `${text.slice(0, DIAGNOSTIC_TEXT_LIMIT - 1)}…`;
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
