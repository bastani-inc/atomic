import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { createGitEnvironment } from "@bastani/atomic";
import type {
	AcceptanceConfig,
	AcceptanceEvidenceKind,
	AcceptanceInput,
	AcceptanceLedger,
	AcceptanceLevel,
	AcceptanceReport,
	AcceptanceRuntimeCheck,
	AcceptanceReviewResult,
	AcceptanceVerifyCommand,
	AcceptanceVerifyResult,
	ResolvedAcceptanceConfig,
	ResolvedAcceptanceGate,
	SingleResult,
	SubagentRunMode,
} from "../../shared/types.ts";

const LEVEL_RANK: Record<Exclude<AcceptanceLevel, "auto">, number> = {
	none: 0,
	attested: 1,
	checked: 2,
	verified: 3,
	reviewed: 4,
};

const VALID_LEVELS = new Set<AcceptanceLevel>(["auto", "none", "attested", "checked", "verified", "reviewed"]);
const VALID_EVIDENCE = new Set<AcceptanceEvidenceKind>([
	"changed-files",
	"tests-added",
	"commands-run",
	"validation-output",
	"residual-risks",
	"no-staged-files",
	"diff-summary",
	"review-findings",
	"manual-notes",
]);

function normalizeLevel(level: AcceptanceLevel | undefined): Exclude<AcceptanceLevel, "auto"> | "auto" {
	return level ?? "auto";
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function requiredEvidenceForLevel(level: Exclude<AcceptanceLevel, "auto">): AcceptanceEvidenceKind[] {
	switch (level) {
		case "none":
			return [];
		case "attested":
			return ["manual-notes", "residual-risks"];
		case "checked":
			return ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"];
		case "verified":
		case "reviewed":
			return ["changed-files", "tests-added", "commands-run", "validation-output", "residual-risks", "no-staged-files"];
	}
}

const READ_ONLY_AGENTS = new Set([
	"codebase-locator",
	"codebase-analyzer",
	"codebase-pattern-finder",
	"codebase-research-locator",
	"codebase-research-analyzer",
	"codebase-online-researcher",
]);

function isReadOnlyAgent(agent: string): boolean {
	return READ_ONLY_AGENTS.has(agent) || /\b(?:reviewer|scout|context-builder|researcher|analyst)\b/.test(agent);
}

const READ_ONLY_CONTINUATION_VERB = String.raw`(?:identify|find|explain|describe|report|return|list|summari[sz]e)`;
const NO_WRITE_BOUNDARY = String.raw`(?=\s*(?:[.!?;]|\n|$|,\s*(?:(?:and|then)\s+)?(?:just\s+)?(?:only\s+)?${READ_ONLY_CONTINUATION_VERB}\b|,\s*but\s+(?:just\s+)?(?:only\s+)?${READ_ONLY_CONTINUATION_VERB}\b|\b(?:and|then)\s+(?:just\s+)?(?:only\s+)?${READ_ONLY_CONTINUATION_VERB}\b))`;
const BROAD_NO_WRITE_OBJECT = String.raw`(?:anything(?!\s+else\b)|any\s+(?:files?|code|source|edits?|modifications?|changes?|writes?)|files?|code|source|edits?|modifications?|changes?|writes?)`;
const DO_NOT_BARE_NO_WRITE_RE = new RegExp(String.raw`\b(?:do not|don't|dont)\s+(?:write|edit|modify|change|fix|implement|patch)\b(?:\s+at\s+all)?${NO_WRITE_BOUNDARY}`);
const DO_NOT_BROAD_NO_WRITE_RE = new RegExp(String.raw`\b(?:do not|don't|dont)\s+(?:write|edit|modify|change|fix|implement|patch)\s+${BROAD_NO_WRITE_OBJECT}\b(?:\s+at\s+all)?${NO_WRITE_BOUNDARY}`);
const DO_NOT_ANYTHING_ELSE_SCOPE_GUARD_RE = new RegExp(String.raw`\b(?:do not|don't|dont)\s+(?:write|edit|modify|change|fix|implement|patch)\s+anything\s+else\b(?:\s+at\s+all)?${NO_WRITE_BOUNDARY}`);
const DO_NOT_MAKE_BROAD_NO_WRITE_RE = new RegExp(String.raw`\b(?:do not|don't|dont)\s+(?:(?:make|perform|do)\s+)(?:any\s+)?(?:(?:file|code|source)\s+)?(?:edits?|modifications?|changes?|writes?)\b(?:\s+at\s+all)?${NO_WRITE_BOUNDARY}`);
const NO_BARE_NO_WRITE_RE = new RegExp(String.raw`\bno[- ](?:write|writes|file[- ]writes|file[- ]edits|source[- ]changes|source[- ]edits|code[- ]changes|code[- ]edits)\b${NO_WRITE_BOUNDARY}`);
const NO_SPACE_NO_WRITE_RE = new RegExp(String.raw`\bno\s+(?:edits?|writes?|file\s+(?:edits?|changes?|writes?|modifications?))\b${NO_WRITE_BOUNDARY}`);
const NO_SOURCE_NO_WRITE_RE = new RegExp(String.raw`\bno\s+(?:code|source)\s+(?:edits?|changes?|writes?|modifications?)\b${NO_WRITE_BOUNDARY}`);
const WITHOUT_BARE_NO_WRITE_RE = new RegExp(String.raw`\bwithout\s+(?:any\s+)?(?:edits?|modifications?|changes?)\b(?:\s+at\s+all)?${NO_WRITE_BOUNDARY}`);
const WITHOUT_FILE_NO_WRITE_RE = new RegExp(String.raw`\bwithout\s+(?:(?:making|performing|doing)\s+)?(?:any\s+)?(?:file|code|source)\s+(?:edits?|editing|modifications?|modifying|changes?|changing|writes?|writing)\b(?:\s+at\s+all)?${NO_WRITE_BOUNDARY}`);
const WITHOUT_EDITING_NO_WRITE_RE = new RegExp(String.raw`\bwithout\s+(?:editing|modifying|changing|writing)\s+(?:any\s+)?(?:files?|code|source)\b(?:\s+at\s+all)?${NO_WRITE_BOUNDARY}`);

function hasNoWriteWording(task: string, options: { allowAnythingElseScopeGuard?: boolean } = {}): boolean {
	const doNotAnythingElseScopeGuard = DO_NOT_ANYTHING_ELSE_SCOPE_GUARD_RE.test(task);
	const doNotDirectWrite = DO_NOT_BARE_NO_WRITE_RE.test(task)
		|| DO_NOT_BROAD_NO_WRITE_RE.test(task)
		|| (doNotAnythingElseScopeGuard && !options.allowAnythingElseScopeGuard)
		|| DO_NOT_MAKE_BROAD_NO_WRITE_RE.test(task);
	return /\b(?:read[- ]only|review[- ]only|analysis[- ]only|investigation[- ]only|investigate[- ]only|research[- ]only|inspect[- ]only|diagnos(?:e|is)[- ]only|debug[- ]only|report[- ]only|findings[- ]only)\b/.test(task)
		|| doNotDirectWrite
		|| NO_BARE_NO_WRITE_RE.test(task)
		|| /\bno[- ]implementation\s+(?:report|summary|write[- ]?up|brief)\b/.test(task)
		|| NO_SPACE_NO_WRITE_RE.test(task)
		|| NO_SOURCE_NO_WRITE_RE.test(task)
		|| WITHOUT_BARE_NO_WRITE_RE.test(task)
		|| WITHOUT_FILE_NO_WRITE_RE.test(task)
		|| WITHOUT_EDITING_NO_WRITE_RE.test(task);
}

function hasProseReportIntent(task: string): boolean {
	return /\b(?:summari[sz]e|summary|report|write[- ]?up|brief)\b/.test(task)
		|| /\bwrite\s+(?:a\s+|an\s+|the\s+)?(?:report|summary|brief|write[- ]?up|proposal|findings?)\b/.test(task);
}

function hasPriorWorkReportIntent(task: string): boolean {
	return /\b(?:report|summari[sz]e|review|analy[sz]e|inspect)\b/.test(task)
		&& (/\bwhat\s+changed\b/.test(task)
			|| /\b(?:in|from|by)\s+(?:the\s+)?(?:diff|patch|previous\s+change|previous\s+commit|prior\s+implementation|last\s+patch)\b/.test(task)
			|| /\b(?:the\s+)?(?:previous|prior|last)\s+commit\b/.test(task)
			|| /\btests?\s+added\s+(?:by|in)\s+(?:the\s+)?(?:previous|prior|last)\b/.test(task));
}

function hasReadOnlyInvestigationIntent(task: string): boolean {
	const actionPrefix = String.raw`(?:^|[;.!?\n]\s*|\b(?:and|then|also|please|must|should|need(?:s|ed)?\s+to|can\s+you|could\s+you|would\s+you)\s+)`;
	const investigationAction = String.raw`(?:investigate|diagnose|debug|inspect|analy[sz]e|review|trace|examine|audit|research|identify|determine|find)`;
	const investigationObject = String.raw`[^.!?\n]*(?:root\s+cause|cause|regression|failure|bug|issue|problem|race|flak(?:e|y)|behavior|flow|diff|patch|fix|implementation|code|files?)`;
	return new RegExp(`${actionPrefix}${investigationAction}\\b${investigationObject}`).test(task);
}

function hasSideEffectfulOperationIntent(task: string): boolean {
	const actionPrefix = String.raw`(?:^|[;.!?\n]\s*|\b(?:and|then|also|please|must|should|need(?:s|ed)?\s+to|can\s+you|could\s+you|would\s+you)\s+)`;
	const optionalAdverbs = String.raw`(?:(?:[a-z]+ly)\s+){0,2}`;
	const releaseObject = String.raw`(?:the\s+)?(?:package|version|release|build|artifact|library|module|app(?:lication)?|service|site|cli|extension|tag)\b`;
	const publishObject = String.raw`(?:the\s+)?(?:package|version|release|build|artifact|library|module|app(?:lication)?|service|site|docs?|documentation|extension)\b`;
	const deployObject = String.raw`(?:the\s+)?(?:app(?:lication)?|service|site|build|release|package|artifact|docs?|documentation|extension)\b`;
	const commitObject = String.raw`(?:the\s+)?(?:(?:current|pending|staged|local)\s+)?(?:changes?|work|patch|fix|implementation|updates?|files?)\b`;
	const objectlessOperationBoundary = String.raw`(?=\s*(?:[,;.!?\n]|$|\band\b|\bthen\b))`;
	return new RegExp(`${actionPrefix}${optionalAdverbs}release\\s+${releaseObject}`).test(task)
		|| new RegExp(`${actionPrefix}${optionalAdverbs}release\\b${objectlessOperationBoundary}`).test(task)
		|| new RegExp(`${actionPrefix}${optionalAdverbs}publish\\s+${publishObject}`).test(task)
		|| new RegExp(`${actionPrefix}${optionalAdverbs}deploy\\s+${deployObject}`).test(task)
		|| new RegExp(`${actionPrefix}${optionalAdverbs}commit\\s+${commitObject}`).test(task)
		|| new RegExp(`${actionPrefix}${optionalAdverbs}commit\\b${objectlessOperationBoundary}`).test(task);
}

function hasStrongImplementationIntent(task: string): boolean {
	const actionPrefix = String.raw`(?:^|[;.!?\n]\s*|\b(?:and|then|also|please|must|should|need(?:s|ed)?\s+to|can\s+you|could\s+you|would\s+you)\s+)`;
	const optionalAdverbs = String.raw`(?:(?:[a-z]+ly)\s+){0,3}`;
	const directAction = String.raw`(?:fix(?:e[ds]|ing)?|implement(?:ed|ing)?|update(?:d|s|ing)?|refactor(?:ed|s|ing)?|patch(?:ed|es|ing)?|migrate(?:d|s|ing)?)`;
	const completedOrGerundAction = String.raw`(?:fix(?:e[ds]|ing)?|implement(?:ed|ing)?|patch(?:ed|es|ing)?|updat(?:ed|ing)|refactor(?:ed|ing)|migrat(?:ed|ing)|(?:applied|applying)\s+(?:a\s+|an\s+|the\s+)?patch)`;
	return new RegExp(`${actionPrefix}${optionalAdverbs}${directAction}\\b`).test(task)
		|| new RegExp(`${actionPrefix}${optionalAdverbs}apply\\s+(?:a\\s+|an\\s+|the\\s+)?patch\\b`).test(task)
		|| new RegExp(`\\b(?:after|once|when)\\s+(?:you\\s+)?${completedOrGerundAction}\\b`).test(task)
		|| /\bwhat\s+you\s+(?:changed|fixed|implemented|patched|updated)\b/.test(task)
		|| /\byour\s+(?:changes|fixes|implementation|patch|updates)\b/.test(task);
}

const EXPLICIT_FILE_OR_CODE_MUTATION = String.raw`(?:edit|modify|change|update|refactor|delete|remove|clean(?:\s|-)?up|implement|migrate)`;
const NAMED_FILE_OBJECT = String.raw`(?:readme(?:\.[a-z0-9]+)?|changelog(?:\.[a-z0-9]+)?|license(?:\.[a-z0-9]+)?|package(?:-lock)?\.json|bun\.lockb?|tsconfig(?:\.[\w-]+)?\.json|(?:[\w.-]+[/\\])+[\w.-]+|[\w-]+\.[a-z0-9]{1,8})`;
const OBJECTFUL_FILE_MUTATION = String.raw`(?:edit|modify|change|update|refactor|delete|remove|clean(?:\s|-)?up)`;
const EXPLICIT_FILE_OR_CODE_MUTATION_BEFORE_OBJECT_RE = new RegExp(String.raw`\b${EXPLICIT_FILE_OR_CODE_MUTATION}\b[^.!?\n]*(?:\b(?:files?|code|source|implementation|patch(?:es)?|changes?)\b)`);
const EXPLICIT_FILE_OR_CODE_OBJECT_BEFORE_MUTATION_RE = new RegExp(String.raw`\b(?:files?|code|source)\b[^.!?\n]*\b${EXPLICIT_FILE_OR_CODE_MUTATION}\b`);
const EXPLICIT_NAMED_FILE_MUTATION_BEFORE_OBJECT_RE = new RegExp(String.raw`\b${OBJECTFUL_FILE_MUTATION}\b(?:\s+(?:the|a|an))?[^.!?\n]{0,80}\b${NAMED_FILE_OBJECT}\b`);
const EXPLICIT_NAMED_FILE_WRITE_RE = new RegExp(String.raw`\bwrite\s+(?:(?:to|into)\s+)?(?:the\s+)?${NAMED_FILE_OBJECT}\b(?=\s*(?:[,;.!?\n]|$|\band\b|\bthen\b))`);

function hasExplicitFileOrCodeWriteIntent(task: string): boolean {
	return EXPLICIT_FILE_OR_CODE_MUTATION_BEFORE_OBJECT_RE.test(task)
		|| EXPLICIT_FILE_OR_CODE_OBJECT_BEFORE_MUTATION_RE.test(task)
		|| EXPLICIT_NAMED_FILE_MUTATION_BEFORE_OBJECT_RE.test(task)
		|| /\bwrite\s+(?:code|tests?|files?|source|patch(?:es)?)\b/.test(task)
		|| EXPLICIT_NAMED_FILE_WRITE_RE.test(task)
		|| /\b(?:write|save|output)\b[^.!?\n]*\b(?:to|into)\b[^.!?\n]*(?:\b(?:file|code|source)\b|[/\\]|\.[a-z0-9]{1,8}\b)/.test(task);
}

function inferLevel(input: {
	agentName: string;
	task?: string;
	mode?: SubagentRunMode;
	async?: boolean;
	dynamic?: boolean;
	dynamicGroup?: boolean;
}): { level: Exclude<AcceptanceLevel, "auto">; reasons: string[]; criteria: string[]; evidence: AcceptanceEvidenceKind[]; review?: { agent?: string; required?: boolean } } {
	const agent = input.agentName.toLowerCase();
	const task = input.task?.toLowerCase() ?? "";
	const reasons: string[] = [];
	const readOnlyAgent = isReadOnlyAgent(agent);
	const explicitFileOrCodeWriteTask = hasExplicitFileOrCodeWriteIntent(task);
	const strongImplementationTask = hasStrongImplementationIntent(task);
	const sideEffectfulOperationTask = hasSideEffectfulOperationIntent(task);
	const noWriteTask = hasNoWriteWording(task, {
		allowAnythingElseScopeGuard: explicitFileOrCodeWriteTask || strongImplementationTask || sideEffectfulOperationTask,
	});
	const proseReportTask = hasProseReportIntent(task)
		&& !explicitFileOrCodeWriteTask
		&& !strongImplementationTask
		&& !sideEffectfulOperationTask;
	const priorWorkReportTask = hasPriorWorkReportIntent(task)
		&& !explicitFileOrCodeWriteTask
		&& !strongImplementationTask
		&& !sideEffectfulOperationTask;
	const investigationTask = hasReadOnlyInvestigationIntent(task)
		&& !explicitFileOrCodeWriteTask
		&& !strongImplementationTask
		&& !sideEffectfulOperationTask;
	const readOnlyTask = noWriteTask || proseReportTask || priorWorkReportTask || investigationTask;
	const genericWriteTask = strongImplementationTask
		|| sideEffectfulOperationTask
		|| /\b(?:fix|implement|update|write|edit|modify|migrate|security|delete|remove|refactor|apply|patch|clean(?:\s|-)?up)\b/.test(task)
		|| (/\bworker\b/.test(agent) && !proseReportTask);
	const writeCapableTask = !readOnlyAgent && (explicitFileOrCodeWriteTask || genericWriteTask) && !readOnlyTask;
	const riskyTask = sideEffectfulOperationTask || /\b(?:migration|migrate|security|data[- ]loss|destructive|post-review|fix pass)\b/.test(task);
	const dynamicFanout = Boolean(input.dynamic || input.dynamicGroup);
	const dynamicNeedsReview = dynamicFanout && !readOnlyAgent && !readOnlyTask;
	const risky = !readOnlyAgent && (Boolean(input.async && writeCapableTask)
		|| dynamicNeedsReview
		|| Boolean(riskyTask && !readOnlyTask));

	if (risky) {
		reasons.push(input.async && writeCapableTask ? "async write-capable or risky run" : "risky write-capable run");
		if (dynamicFanout) reasons.push("dynamic fanout context");
		return {
			level: "reviewed",
			reasons,
			criteria: ["Implement the requested change without widening scope", "Return evidence sufficient for an independent acceptance review"],
			evidence: requiredEvidenceForLevel("reviewed"),
			review: { agent: "codebase-analyzer", required: true },
		};
	}
	if (writeCapableTask) {
		reasons.push("write-capable worker/task");
		return {
			level: "checked",
			reasons,
			criteria: ["Implement the requested change without widening scope"],
			evidence: requiredEvidenceForLevel("checked"),
		};
	}
	if (readOnlyAgent || readOnlyTask) {
		reasons.push(readOnlyAgent ? "read-only/reviewer-style agent" : (proseReportTask ? "prose report/summary task" : (investigationTask ? "investigation/diagnostic task" : "read-only task wording")));
		return {
			level: "attested",
			reasons,
			criteria: ["Return concrete findings with file paths and severity when applicable"],
			evidence: ["review-findings", "residual-risks"],
		};
	}
	reasons.push("default lightweight attestation");
	return {
		level: "attested",
		reasons,
		criteria: ["Return a concise result and residual risks when applicable"],
		evidence: ["manual-notes", "residual-risks"],
	};
}

export function normalizeAcceptanceInput(input: AcceptanceInput | undefined): AcceptanceConfig {
	if (input === undefined || input === "auto") return { level: "auto" };
	if (input === false) return { level: "none", reason: "disabled by deprecated false shorthand" };
	if (typeof input === "string") return { level: input };
	return { ...input };
}

function explicitAcceptanceCanDisable(explicit: AcceptanceConfig): boolean {
	return explicit.level === "none" && typeof explicit.reason === "string" && explicit.reason.trim().length > 0;
}

export function validateAcceptanceInput(input: unknown, pathLabel = "acceptance"): string[] {
	const errors: string[] = [];
	if (input === undefined) return errors;
	if (input === false) return errors;
	if (typeof input === "string") {
		if (!VALID_LEVELS.has(input as AcceptanceLevel)) errors.push(`${pathLabel} has invalid level '${input}'.`);
		return errors;
	}
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		errors.push(`${pathLabel} must be a string level, false, or an object.`);
		return errors;
	}
	const value = input as Record<string, unknown>;
	if (value.level !== undefined && (typeof value.level !== "string" || !VALID_LEVELS.has(value.level as AcceptanceLevel))) {
		errors.push(`${pathLabel}.level must be one of auto, none, attested, checked, verified, reviewed.`);
	}
	if (value.level === "none" && (typeof value.reason !== "string" || !value.reason.trim())) {
		errors.push(`${pathLabel}.reason is required when level is none.`);
	}
	if (value.criteria !== undefined && !Array.isArray(value.criteria)) errors.push(`${pathLabel}.criteria must be an array.`);
	if (Array.isArray(value.evidence)) {
		for (const [index, item] of value.evidence.entries()) {
			if (typeof item !== "string" || !VALID_EVIDENCE.has(item as AcceptanceEvidenceKind)) {
				errors.push(`${pathLabel}.evidence[${index}] is not a supported evidence kind.`);
			}
		}
	} else if (value.evidence !== undefined) {
		errors.push(`${pathLabel}.evidence must be an array.`);
	}
	if (value.verify !== undefined && !Array.isArray(value.verify)) errors.push(`${pathLabel}.verify must be an array.`);
	if (Array.isArray(value.verify)) {
		for (const [index, command] of value.verify.entries()) {
			if (!command || typeof command !== "object" || Array.isArray(command)) {
				errors.push(`${pathLabel}.verify[${index}] must be an object.`);
				continue;
			}
			const cmd = command as Record<string, unknown>;
			if (typeof cmd.id !== "string" || !cmd.id.trim()) errors.push(`${pathLabel}.verify[${index}].id is required.`);
			if (typeof cmd.command !== "string" || !cmd.command.trim()) errors.push(`${pathLabel}.verify[${index}].command is required.`);
			if (cmd.timeoutMs !== undefined && (typeof cmd.timeoutMs !== "number" || cmd.timeoutMs <= 0)) {
				errors.push(`${pathLabel}.verify[${index}].timeoutMs must be a positive number.`);
			}
		}
	}
	return errors;
}

function normalizeCriteria(criteria: Array<string | { id?: string; must?: string; evidence?: AcceptanceEvidenceKind[]; severity?: "required" | "recommended" }> | undefined, evidence: AcceptanceEvidenceKind[]): ResolvedAcceptanceGate[] {
	return (criteria ?? []).map<ResolvedAcceptanceGate>((criterion, index) => {
		if (typeof criterion === "string") {
			return { id: `criterion-${index + 1}`, must: criterion, evidence, severity: "required" };
		}
		return {
			id: criterion.id?.trim() || `criterion-${index + 1}`,
			must: criterion.must ?? "",
			evidence: criterion.evidence?.filter((item) => VALID_EVIDENCE.has(item)) ?? evidence,
			severity: criterion.severity ?? "required",
		};
	}).filter((criterion) => criterion.must.trim().length > 0);
}

export function resolveEffectiveAcceptance(input: {
	explicit?: AcceptanceInput;
	agentName: string;
	task?: string;
	mode?: SubagentRunMode;
	async?: boolean;
	dynamic?: boolean;
	dynamicGroup?: boolean;
}): ResolvedAcceptanceConfig {
	const explicit = normalizeAcceptanceInput(input.explicit);
	const inferred = inferLevel(input);
	const explicitLevel = normalizeLevel(explicit.level);
	const level = explicitAcceptanceCanDisable(explicit)
		? "none"
		: explicitLevel === "auto"
			? inferred.level
			: (LEVEL_RANK[explicitLevel] >= LEVEL_RANK[inferred.level] ? explicitLevel : inferred.level);
	const evidence = unique([...(level === inferred.level ? inferred.evidence : requiredEvidenceForLevel(level)), ...(explicit.evidence ?? [])]);
	const criteria = normalizeCriteria(
		(explicit.criteria?.length ? explicit.criteria : inferred.criteria) as Array<string | { id?: string; must?: string; evidence?: AcceptanceEvidenceKind[]; severity?: "required" | "recommended" }>,
		evidence,
	);
	let review = explicit.review !== undefined ? explicit.review : inferred.review;
	if (level === "reviewed" && explicitLevel !== "auto" && explicitLevel !== "reviewed" && explicit.review === undefined && review) {
		review = { ...review, required: false };
	}
	return {
		level,
		explicit: input.explicit !== undefined,
		inferredReason: inferred.reasons,
		criteria,
		evidence,
		verify: explicit.verify ?? [],
		review,
		stopRules: explicit.stopRules ?? [],
		reason: explicit.reason,
	};
}

export function formatAcceptancePrompt(acceptance: ResolvedAcceptanceConfig): string {
	if (acceptance.level === "none") return "";
	const lines = [
		"",
		"## Acceptance Contract",
		`Acceptance level: ${acceptance.level}`,
		"Completion is not accepted from prose alone. End with a structured acceptance report.",
		"",
		"Criteria:",
		...(acceptance.criteria.length ? acceptance.criteria.map((criterion) => `- ${criterion.id}: ${criterion.must}`) : ["- Return the requested result."]),
		"",
		`Required evidence: ${acceptance.evidence.join(", ") || "none"}`,
	];
	if (acceptance.verify.length > 0) {
		lines.push("", "Runtime verification commands configured by parent:");
		for (const command of acceptance.verify) lines.push(`- ${command.id}: ${command.command}`);
	}
	if (acceptance.review) {
		lines.push("", `Review gate: ${acceptance.review.required === false ? "optional" : "required"}${acceptance.review.agent ? ` by ${acceptance.review.agent}` : ""}.`);
		if (acceptance.review.focus) lines.push(`Review focus: ${acceptance.review.focus}`);
	}
	if (acceptance.stopRules.length > 0) {
		lines.push("", "Stop rules:", ...acceptance.stopRules.map((rule) => `- ${rule}`));
	}
	lines.push(
		"",
		"Finish with a fenced JSON block tagged `acceptance-report` in this shape:",
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "specific proof" }],
			changedFiles: [],
			testsAddedOrUpdated: [],
			commandsRun: [{ command: "command", result: "passed", summary: "short result" }],
			validationOutput: [],
			residualRisks: [],
			noStagedFiles: true,
			notes: "anything else the parent should know",
		}, null, 2),
		"```",
	);
	return lines.join("\n");
}

function extractBalancedJson(text: string, start: number): string | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") depth++;
		if (char === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}

export function parseAcceptanceReport(output: string): { report?: AcceptanceReport; error?: string } {
	const fenced = [...output.matchAll(/```acceptance-report\s*\n([\s\S]*?)```/gi)]
		.map((match) => match[1]?.trim())
		.filter((value): value is string => Boolean(value));
	const parseErrors: string[] = [];
	for (const body of fenced) {
		try {
			const parsed = JSON.parse(body) as unknown;
			const report = (parsed && typeof parsed === "object" && "acceptance" in parsed)
				? (parsed as { acceptance?: unknown }).acceptance
				: parsed;
			if (isAcceptanceReport(report)) return { report };
			parseErrors.push("acceptance-report block does not contain a valid acceptance report");
		} catch (error) {
			parseErrors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (parseErrors.length > 0) return { error: `Failed to parse acceptance-report: ${parseErrors.join("; ")}` };
	const markerIndex = output.search(/ACCEPTANCE_REPORT\s*:/i);
	if (markerIndex !== -1) {
		const jsonStart = output.indexOf("{", markerIndex);
		if (jsonStart !== -1) {
			const json = extractBalancedJson(output, jsonStart);
			if (json) {
				try {
					const parsed = JSON.parse(json) as unknown;
					if (isAcceptanceReport(parsed)) return { report: parsed };
				} catch (error) {
					return { error: error instanceof Error ? error.message : String(error) };
				}
			}
		}
	}
	return { error: "Structured acceptance report not found." };
}

export function stripAcceptanceReport(output: string): string {
	return output
		.replace(/\n?```acceptance-report\s*\n[\s\S]*?```\s*$/i, "")
		.replace(/\n?ACCEPTANCE_REPORT\s*:\s*\{[\s\S]*\}\s*$/i, "")
		.trimEnd();
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAcceptanceReport(value: unknown): value is AcceptanceReport {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const report = value as AcceptanceReport;
	if (report.criteriaSatisfied !== undefined) {
		if (!Array.isArray(report.criteriaSatisfied)) return false;
		for (const item of report.criteriaSatisfied) {
			if (!item || typeof item !== "object" || Array.isArray(item)) return false;
			const criterion = item as { id?: unknown; status?: unknown; evidence?: unknown };
			if (criterion.id !== undefined && typeof criterion.id !== "string") return false;
			if (criterion.status !== "satisfied" && criterion.status !== "not-satisfied" && criterion.status !== "not-applicable") return false;
			if (typeof criterion.evidence !== "string" || !criterion.evidence.trim()) return false;
		}
	}
	return report.criteriaSatisfied !== undefined
		|| report.changedFiles !== undefined
		|| report.testsAddedOrUpdated !== undefined
		|| report.commandsRun !== undefined
		|| report.residualRisks !== undefined
		|| report.manualNotes !== undefined
		|| report.reviewFindings !== undefined;
}

function checkCriteriaSatisfied(criteria: ResolvedAcceptanceGate[], report: AcceptanceReport): AcceptanceRuntimeCheck[] {
	const reports = new Map((report.criteriaSatisfied ?? []).filter((item) => item.id).map((item) => [item.id!, item]));
	return criteria.filter((criterion) => criterion.severity !== "recommended").map((criterion) => {
		const item = reports.get(criterion.id);
		if (!item) return { id: `criterion:${criterion.id}`, status: "failed", message: `Required criterion '${criterion.id}' was not reported.` };
		if (item.status !== "satisfied") return { id: `criterion:${criterion.id}`, status: "failed", message: `Required criterion '${criterion.id}' was reported as ${item.status}.` };
		return { id: `criterion:${criterion.id}`, status: "passed", message: `Required criterion '${criterion.id}' satisfied.` };
	});
}

function reportEvidenceCheck(report: AcceptanceReport, kind: AcceptanceEvidenceKind): AcceptanceRuntimeCheck {
	const passed = (message: string): AcceptanceRuntimeCheck => ({ id: `evidence:${kind}`, status: "passed", message });
	const failed = (message: string): AcceptanceRuntimeCheck => ({ id: `evidence:${kind}`, status: "failed", message });
	switch (kind) {
		case "changed-files": {
			if (report.changedFiles === undefined) return failed("changed-files evidence missing from child report.");
			if (!isStringArray(report.changedFiles)) return failed("changed-files evidence must be an array of file paths.");
			if (report.changedFiles.length === 0) return failed("changed-files evidence was present but empty; checked, verified, and reviewed write gates require at least one changed file.");
			return passed("changed-files evidence present.");
		}
		case "tests-added": return isStringArray(report.testsAddedOrUpdated) && report.testsAddedOrUpdated.length > 0 ? passed("tests-added evidence present.") : failed("tests-added evidence missing from child report.");
		case "commands-run": return Array.isArray(report.commandsRun) && report.commandsRun.length > 0 ? passed("commands-run evidence present.") : failed("commands-run evidence missing from child report.");
		case "validation-output": return isStringArray(report.validationOutput) && report.validationOutput.length > 0 ? passed("validation-output evidence present.") : failed("validation-output evidence missing from child report.");
		case "residual-risks": return isStringArray(report.residualRisks) ? passed("residual-risks evidence present.") : failed("residual-risks evidence missing from child report.");
		case "no-staged-files": return report.noStagedFiles === true ? passed("no-staged-files evidence present.") : failed("no-staged-files evidence missing from child report.");
		case "diff-summary": return typeof report.diffSummary === "string" && report.diffSummary.trim().length > 0 ? passed("diff-summary evidence present.") : failed("diff-summary evidence missing from child report.");
		case "review-findings": return isStringArray(report.reviewFindings) ? passed("review-findings evidence present.") : failed("review-findings evidence missing from child report.");
		case "manual-notes": return Boolean((report.manualNotes ?? report.notes)?.trim()) ? passed("manual-notes evidence present.") : failed("manual-notes evidence missing from child report.");
	}
}

function checkNoStagedFiles(cwd: string): AcceptanceRuntimeCheck {
	const result = spawnSync("git", ["status", "--short"], { cwd, env: createGitEnvironment(), encoding: "utf-8" });
	if (result.status !== 0) {
		return { id: "no-staged-files", status: "not-applicable", message: "git status unavailable; no staged-files check skipped" };
	}
	const staged = result.stdout.split(/\r?\n/).filter((line) => line.length >= 2 && line[0] !== " " && line[0] !== "?");
	return staged.length === 0
		? { id: "no-staged-files", status: "passed", message: "No staged files detected." }
		: { id: "no-staged-files", status: "failed", message: `Staged files present: ${staged.join(", ")}` };
}

function runStructuralChecks(acceptance: ResolvedAcceptanceConfig, report: AcceptanceReport, cwd: string): AcceptanceRuntimeCheck[] {
	const checks: AcceptanceRuntimeCheck[] = [];
	for (const kind of acceptance.evidence) {
		checks.push(reportEvidenceCheck(report, kind));
	}
	if (acceptance.evidence.includes("no-staged-files")) checks.push(checkNoStagedFiles(cwd));
	return checks;
}

function trimOutput(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > 12_000 ? `${trimmed.slice(0, 12_000)}\n...[truncated]` : trimmed;
}

function uniqueStrings(items: Array<string | undefined>): string[] {
	return unique(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item)));
}

export function aggregateAcceptanceReport(input: {
	results: Array<Pick<SingleResult, "agent" | "acceptance" | "error" | "exitCode">>;
	notes?: string;
}): AcceptanceReport {
	const childReports = input.results.map((result) => result.acceptance?.childReport).filter((report): report is AcceptanceReport => Boolean(report));
	const blockers = input.results.filter((result) => result.exitCode !== 0 || result.acceptance?.status === "rejected");
	const successfulChildren = input.results.length > 0 && blockers.length === 0;
	return {
		criteriaSatisfied: [
			{ id: "criterion-1", status: successfulChildren ? "satisfied" : "not-satisfied", evidence: successfulChildren ? `All ${input.results.length} dynamic child run(s) completed without child or acceptance blockers.` : "Dynamic fanout produced no accepted child evidence." },
			{ id: "criterion-2", status: successfulChildren ? "satisfied" : "not-satisfied", evidence: successfulChildren ? "Collected child acceptance evidence for aggregate review." : "Dynamic fanout produced no aggregate review evidence." },
			...input.results.map((result, index): NonNullable<AcceptanceReport["criteriaSatisfied"]>[number] => ({
				id: `child-${index + 1}`,
				status: result.exitCode === 0 && result.acceptance?.status !== "rejected" ? "satisfied" : "not-satisfied",
				evidence: `${result.agent}: acceptance ${result.acceptance?.status ?? "unreported"}${result.error ? ` (${result.error})` : ""}`,
			})),
		],
		changedFiles: uniqueStrings(childReports.flatMap((report) => report.changedFiles ?? [])),
		testsAddedOrUpdated: uniqueStrings(childReports.flatMap((report) => report.testsAddedOrUpdated ?? [])),
		commandsRun: childReports.flatMap((report) => report.commandsRun ?? []),
		validationOutput: uniqueStrings(childReports.flatMap((report) => report.validationOutput ?? [])),
		residualRisks: uniqueStrings([
			...childReports.flatMap((report) => report.residualRisks ?? []),
			...blockers.map((result) => `${result.agent}: ${result.error ?? "child or acceptance gate failed"}`),
		]),
		noStagedFiles: childReports.length > 0 && childReports.every((report) => report.noStagedFiles === true),
		reviewFindings: uniqueStrings(childReports.flatMap((report) => report.reviewFindings ?? [])),
		manualNotes: input.notes ?? `Aggregated acceptance evidence from ${input.results.length} dynamic fanout child run(s).`,
		notes: input.notes,
	};
}

function runVerifyCommand(command: AcceptanceVerifyCommand, defaultCwd: string): Promise<AcceptanceVerifyResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const cwd = command.cwd ? path.resolve(defaultCwd, command.cwd) : defaultCwd;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const child = spawn(command.command, {
			cwd,
			env: { ...process.env, ...(command.env ?? {}) },
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1000).unref?.();
		}, command.timeoutMs ?? 120_000);
		timeout.unref?.();
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (exitCode) => {
			clearTimeout(timeout);
			const durationMs = Date.now() - startedAt;
			const passed = exitCode === 0 && !timedOut;
			resolve({
				id: command.id,
				command: command.command,
				cwd,
				exitCode,
				status: timedOut ? "timed-out" : passed ? "passed" : command.allowFailure ? "allowed-failure" : "failed",
				stdout: trimOutput(stdout),
				stderr: trimOutput(stderr),
				durationMs,
			});
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			resolve({
				id: command.id,
				command: command.command,
				cwd,
				exitCode: 1,
				status: command.allowFailure ? "allowed-failure" : "failed",
				stderr: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startedAt,
			});
		});
	});
}

export async function evaluateAcceptance(input: {
	acceptance: ResolvedAcceptanceConfig;
	output: string;
	cwd: string;
	report?: AcceptanceReport;
	reviewResult?: AcceptanceReviewResult;
}): Promise<AcceptanceLedger> {
	const acceptance = input.acceptance;
	const ledger: AcceptanceLedger = {
		status: acceptance.level === "none" ? "not-required" : "claimed",
		explicit: acceptance.explicit,
		effectiveAcceptance: acceptance,
		inferredReason: acceptance.inferredReason,
		criteria: acceptance.criteria,
		runtimeChecks: [],
		verifyRuns: [],
	};
	if (acceptance.level === "none") return ledger;

	const parsed = input.report ? { report: input.report } : parseAcceptanceReport(input.output);
	if (parsed.report) {
		ledger.childReport = parsed.report;
		ledger.status = "attested";
	} else {
		ledger.childReportParseError = parsed.error;
		ledger.runtimeChecks.push({ id: "attestation", status: "failed", message: parsed.error ?? "Structured acceptance report missing." });
		ledger.status = "rejected";
		return ledger;
	}

	if (LEVEL_RANK[acceptance.level] >= LEVEL_RANK.checked) {
		ledger.runtimeChecks = [
			...checkCriteriaSatisfied(acceptance.criteria, parsed.report),
			...runStructuralChecks(acceptance, parsed.report, input.cwd),
		];
		if (ledger.runtimeChecks.some((check) => check.status === "failed")) {
			ledger.status = "rejected";
			return ledger;
		}
		ledger.status = "checked";
	}

	if (LEVEL_RANK[acceptance.level] >= LEVEL_RANK.verified && (acceptance.level === "verified" || acceptance.verify.length > 0)) {
		if (acceptance.level === "verified" && acceptance.verify.length === 0) {
			ledger.runtimeChecks.push({ id: "verification-config", status: "failed", message: "verified acceptance requires runtime verify commands." });
			ledger.status = "rejected";
			return ledger;
		}
		ledger.verifyRuns = [];
		for (const command of acceptance.verify) ledger.verifyRuns.push(await runVerifyCommand(command, input.cwd));
		if (ledger.verifyRuns.some((run) => run.status === "failed" || run.status === "timed-out")) {
			ledger.status = "rejected";
			return ledger;
		}
		ledger.status = "verified";
	}

	if (acceptance.level === "reviewed") {
		if (input.reviewResult) {
			ledger.reviewResult = input.reviewResult;
			ledger.status = input.reviewResult.status === "no-blockers" ? "reviewed" : "rejected";
		} else {
			const optionalReview = Boolean(acceptance.review && acceptance.review.required === false);
			ledger.reviewResult = {
				status: "needs-parent-decision",
				findings: [{
					severity: acceptance.explicit && !optionalReview ? "blocker" : "non-blocking",
					issue: "Reviewed acceptance requires an independent reviewer result.",
					rationale: "The run cannot be marked reviewed from child evidence alone.",
				}],
			};
			if (acceptance.review === false || (acceptance.explicit && !optionalReview)) ledger.status = "rejected";
		}
	}

	return ledger;
}

function firstReviewFindingWithIssue(ledger: AcceptanceLedger): NonNullable<AcceptanceLedger["reviewResult"]>["findings"][number] | undefined {
	return ledger.reviewResult?.findings.find((item) => item.issue.trim().length > 0);
}

function firstBlockerFindingWithIssue(ledger: AcceptanceLedger): NonNullable<AcceptanceLedger["reviewResult"]>["findings"][number] | undefined {
	return ledger.reviewResult?.findings.find((item) => item.severity === "blocker" && item.issue.trim().length > 0)
		?? firstReviewFindingWithIssue(ledger);
}

function formatReviewFinding(finding: NonNullable<AcceptanceLedger["reviewResult"]>["findings"][number] | undefined): string | undefined {
	if (!finding) return undefined;
	const issue = finding.issue.trim();
	if (!issue) return undefined;
	const location = finding.file ? `${finding.file}: ` : "";
	const rationale = finding.rationale.trim() ? ` (${finding.rationale.trim()})` : "";
	return `${location}${issue}${rationale}`;
}

export function acceptanceFailureMessage(ledger: AcceptanceLedger): string | undefined {
	if (ledger.status !== "rejected") return undefined;
	const failedCheck = ledger.runtimeChecks.find((check) => check.status === "failed");
	if (failedCheck) return `Run completed, but the acceptance gate rejected the result: ${failedCheck.message}`;
	const failedVerify = ledger.verifyRuns.find((run) => run.status === "failed" || run.status === "timed-out");
	if (failedVerify) return `Run completed, but acceptance verification '${failedVerify.id}' ${failedVerify.status}.`;
	if (ledger.reviewResult?.status === "needs-parent-decision") {
		const firstReviewFinding = formatReviewFinding(firstReviewFindingWithIssue(ledger));
		return `Run completed, but acceptance review is required and no automatic reviewer result is available${firstReviewFinding ? `: ${firstReviewFinding}` : "."}`;
	}
	if (ledger.reviewResult?.status === "blockers") {
		const firstBlockerFinding = formatReviewFinding(firstBlockerFindingWithIssue(ledger));
		return `Run completed, but acceptance review found blockers${firstBlockerFinding ? `: ${firstBlockerFinding}` : "."}`;
	}
	return "Run completed, but the acceptance gate rejected the result.";
}
