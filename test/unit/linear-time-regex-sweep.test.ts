import assert from "node:assert/strict";
import type { AssistantMessage } from "@bastani/atomic-ai";
import { isContextOverflow } from "@bastani/atomic-ai";
import { beforeAll, describe, test } from "vitest";
import { formatCacheWarmingUsage } from "../../packages/coding-agent/src/core/cache-warmer.js";
import {
	isContentFilterRefusal,
	isSafetyRefusalFailure,
} from "../../packages/coding-agent/src/core/model-fallback-failures.js";
import { workedVerb } from "../../packages/coding-agent/src/modes/interactive/components/atomic-working-status.js";
import { builtinToolBlockPresentation } from "../../packages/coding-agent/src/modes/interactive/components/tool-block-families.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../../packages/coding-agent/src/utils/ansi.js";
import { redactCredentialShapes } from "../../packages/coding-agent/src/utils/credential-redaction.js";
import { extractBearerToken, matchesOnSameLineCI } from "../../packages/coding-agent/src/utils/linear-text.js";
import { mayHaveReachedReason } from "../../packages/intercom/broker/departed-children.js";
import { scrub } from "../../packages/subagents/skills/feedback/scripts/scrub.mjs";
import {
	stripInheritedSkills,
	stripProjectContext,
	stripSubagentOrchestrationSkill,
} from "../../packages/subagents/src/runs/inprocess/prompt-behavior.js";

beforeAll(() => {
	initTheme();
});

const QUADRATIC_REPS = 40_000;
const LONG_QUADRATIC_REPS = 50_000;
const CUBIC_REPS = 2_000;
const BASELINE_SAMPLES = 5;
const LINEAR_BASELINE_FLOOR_MS = 25;
const LINEAR_BUDGET_MULTIPLIER = 40;

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function measureMs(run: () => void): number {
	const started = performance.now();
	run();
	return performance.now() - started;
}

function linearBudgetMs(runLinearBaseline: () => void): number {
	const samples: number[] = [];
	for (let i = 0; i < BASELINE_SAMPLES; i++) {
		samples.push(measureMs(runLinearBaseline));
	}
	samples.sort((a, b) => a - b);
	const medianBaselineMs = samples[Math.floor(samples.length / 2)]!;
	return Math.max(medianBaselineMs, LINEAR_BASELINE_FLOOR_MS) * LINEAR_BUDGET_MULTIPLIER;
}

function assertLinearTime<T>(label: string, runLinearBaseline: () => void, runPathological: () => T): T {
	const budgetMs = linearBudgetMs(runLinearBaseline);
	let result!: T;
	const elapsedMs = measureMs(() => {
		result = runPathological();
	});
	assert.ok(
		elapsedMs <= budgetMs,
		`${label} took ${elapsedMs.toFixed(1)} ms; expected <= ${budgetMs.toFixed(1)} ms (${LINEAR_BUDGET_MULTIPLIER}x linear baseline)`,
	);
	return result;
}

function errorAssistantMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-2.5-pro",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: 0,
	};
}

describe("prompt-behavior linear-time block stripping", () => {
	test("completes in linear time on 50k+ repeated unclosed tags and leading newlines", () => {
		const cases: readonly [name: string, fn: (s: string) => string, input: string][] = [
			["stripProjectContext newlines", stripProjectContext, `${"\n".repeat(LONG_QUADRATIC_REPS)}x`],
			["stripProjectContext unclosed tags", stripProjectContext, "<project_context>".repeat(QUADRATIC_REPS)],
			["stripInheritedSkills newlines", stripInheritedSkills, `${"\n".repeat(LONG_QUADRATIC_REPS)}x`],
			["stripInheritedSkills unclosed tags", stripInheritedSkills, "<skills>".repeat(QUADRATIC_REPS)],
			[
				"stripSubagentOrchestrationSkill unclosed <skill name=subagent>",
				stripSubagentOrchestrationSkill,
				'<skill name="subagent">'.repeat(QUADRATIC_REPS),
			],
		];
		for (const [name, fn, input] of cases) {
			const sameLengthBenign = "a".repeat(input.length);
			const result = assertLinearTime(
				name,
				() => {
					fn(sameLengthBenign);
				},
				() => fn(input),
			);
			assert.equal(result, input, name);
		}
	});

	test("preserves exact tagged-block removal on realistic and edge-case prompts", () => {
		assert.equal(stripProjectContext("head\n\n<project_context>\nAGENTS\n</project_context>\n\ntail"), "head\ntail");
		assert.equal(
			stripProjectContext("\n\n<project_context>a</project_context>\n\n<project_context>b</project_context>\n\n"),
			"\n\n",
		);
		assert.equal(stripInheritedSkills("head\n<skills>one</skills>\ntail"), "head\ntail");
		assert.equal(
			stripSubagentOrchestrationSkill(
				'before\n\n<skill name="subagent@builtin" location="/a/SKILL.md">\nbody\n</skill>\n\nafter',
			),
			"before\n\nafter",
		);
		assert.equal(
			stripSubagentOrchestrationSkill('keep\n<skill name="tdd">body</skill>\nend'),
			'keep\n<skill name="tdd">body</skill>\nend',
		);
		assert.equal(stripSubagentOrchestrationSkill('\n\n\n<skill name="subagent">x</skill>\n\n\n'), "\n\n\n\n");
	});
});

describe("model-fallback-failures linear-time refusal classification", () => {
	test("completes in linear time on adversarial refusal-prefix repetitions", () => {
		const cases: readonly [name: string, input: string][] = [
			["finish_reason repeated", "finish_reason ".repeat(QUADRATIC_REPS)],
			["finish_reason repeated with later-line match", `${"finish_reason ".repeat(QUADRATIC_REPS)}\nother`],
			["flagged for possible repeated", "flagged for possible ".repeat(QUADRATIC_REPS)],
			["safety repeated", "safety ".repeat(QUADRATIC_REPS)],
			[
				"safety repeated with later-line refused (kills uncached stage-2 scan)",
				`${"safety ".repeat(QUADRATIC_REPS)}\nrefused`,
			],
			["refuse repeated", "refuse ".repeat(QUADRATIC_REPS)],
			["provider refuse repeated (cubic)", "provider x refuse ".repeat(CUBIC_REPS)],
			[
				"provider refuse repeated with later-line prompt (kills uncached stage-3 scan)",
				`${"provider x refuse ".repeat(CUBIC_REPS)}\nprompt`,
			],
			["tool repeated", "tool ".repeat(QUADRATIC_REPS)],
		];
		for (const [name, input] of cases) {
			const sameLengthBenign = "x".repeat(input.length);
			const result = assertLinearTime(
				name,
				() => {
					isSafetyRefusalFailure(sameLengthBenign);
				},
				() => isSafetyRefusalFailure(input),
			);
			assert.equal(result, false, name);
		}
	});

	test("classifies real provider refusal messages identically including multi-line whitespace tokens", () => {
		for (const msg of [
			"finish_reason: content_filter",
			"finish\nreason content_filter",
			"This content was flagged for possible cybersecurity risk.",
			"flagged\nfor potentially harmful policy",
			"Request blocked due to safety policy violation",
			"Policy refused this request",
			"The provider refused the prompt under content guidelines",
		]) {
			assert.equal(isContentFilterRefusal(msg), true, `content_filter expected: ${msg}`);
			assert.equal(isSafetyRefusalFailure(msg), true, `safety refusal expected: ${msg}`);
		}
		for (const msg of ["tool call refused by provider", "tool\ncall refused", "provider refused tool\nuse"]) {
			assert.equal(isSafetyRefusalFailure(msg), true, `tool refusal expected: ${msg}`);
		}
		for (const msg of [
			"finish_reason: stop\nother_filter disabled",
			"safety check ok\nrequest refused later",
			"provider ok\nrefused prompt",
			"tool ready\nrefused later",
		]) {
			assert.equal(isSafetyRefusalFailure(msg), false, `false positive: ${msg}`);
		}
	});
});

describe("tool-block-families linear-time footer parsing", () => {
	test("completes in linear time on 40k+ repeated malformed read, find, and bash footers", () => {
		const cases: readonly [name: string, toolName: string, args: unknown, rawText: string][] = [
			[
				"read repeated [Showing lines",
				"read",
				{ path: "a.ts" },
				"\n\n[Showing lines 1-2 of 3 ".repeat(QUADRATIC_REPS),
			],
			["find repeated [", "find", { pattern: "*" }, "\n\n[".repeat(QUADRATIC_REPS)],
			["bash repeated [Showing last", "bash", { command: "echo" }, "\n\n[Showing last ".repeat(QUADRATIC_REPS)],
			[
				"bash repeated Command is still running",
				"bash",
				{ command: "sleep 1", wait: { kind: "background" } },
				"\n\nCommand is still running (task ".repeat(QUADRATIC_REPS),
			],
		];
		for (const [name, toolName, args, rawText] of cases) {
			const sameLengthBenign = "a".repeat(rawText.length);
			assertLinearTime(
				name,
				() => {
					builtinToolBlockPresentation({
						toolName,
						args,
						result: { content: [{ type: "text", text: sameLengthBenign }], isError: false },
						expanded: false,
						isPartial: false,
						cwd: "/tmp",
						executionStarted: true,
						argsComplete: true,
						theme: identityTheme,
					});
				},
				() =>
					builtinToolBlockPresentation({
						toolName,
						args,
						result: { content: [{ type: "text", text: rawText }], isError: false },
						expanded: false,
						isPartial: false,
						cwd: "/tmp",
						executionStarted: true,
						argsComplete: true,
						theme: identityTheme,
					}),
			);
		}
	});

	test("strips real read, find, ls, and bash footers identically", () => {
		const readView = builtinToolBlockPresentation({
			toolName: "read",
			args: { path: "src/app.ts" },
			result: {
				content: [
					{
						type: "text",
						text: "line 1\nline 2\n\n[Showing lines 1-2 of 100. Continue with path selector :3.]",
					},
				],
				isError: false,
			},
			expanded: false,
			isPartial: false,
			cwd: "/tmp",
			executionStarted: true,
			argsComplete: true,
			theme: identityTheme,
		});
		assert.ok(readView);
		assert.ok(readView.meta?.some((m) => m.includes("2 lines")) || readView.details !== undefined);

		const bashBg = builtinToolBlockPresentation({
			toolName: "bash",
			args: { command: "sleep 10", wait: { kind: "background" } },
			result: {
				content: [
					{
						type: "text",
						text: "started\n\nCommand is still running (task task-1-0-9). Its output will follow.",
					},
				],
				isError: false,
			},
			expanded: false,
			isPartial: false,
			cwd: "/tmp",
			executionStarted: true,
			argsComplete: true,
			theme: identityTheme,
		});
		assert.equal(bashBg?.status, "shell-running");

		const findNested = builtinToolBlockPresentation({
			toolName: "find",
			args: { pattern: "*.ts" },
			result: {
				content: [{ type: "text", text: "a.ts\n\n[outer notice\n\n[inner notice]" }],
				isError: false,
			},
			expanded: false,
			isPartial: false,
			cwd: "/tmp",
			executionStarted: true,
			argsComplete: true,
			theme: identityTheme,
		});
		assert.equal(findNested?.details?.render(80).join("\n").includes("1 match"), true);
	});
});

describe("credential-redaction, overflow, ansi, working-status, intercom, scrub, cache-warmer", () => {
	test("credential-redaction keeps mysql/mariadb/-u joined-password redaction intact (never redacts less)", () => {
		for (const [input, secret] of [
			["mysql -u root -pSecretPass db", "SecretPass"],
			["mariadb-client -h localhost -pAlphaBeta", "AlphaBeta"],
			["dbtool -uadmin -pMyPasswd", "MyPasswd"],
		] as const) {
			const redacted = redactCredentialShapes(input);
			assert.equal(redacted.includes(secret), false, `must redact ${secret} in ${input}`);
		}
		assert.equal(redactCredentialShapes("gcc -pthread main.c"), "gcc -pthread main.c");
	});

	test("isContextOverflow completes in linear time on repeated 'input token count ' prefixes", () => {
		const pathological = "input token count ".repeat(QUADRATIC_REPS);
		const sameLengthBenign = "x".repeat(pathological.length);
		const result = assertLinearTime(
			"isContextOverflow(input token count repeated)",
			() => {
				isContextOverflow(errorAssistantMessage(sameLengthBenign));
			},
			() => isContextOverflow(errorAssistantMessage(pathological)),
		);
		assert.equal(result, false);
		assert.equal(
			isContextOverflow(
				errorAssistantMessage(
					"The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
				),
			),
			true,
		);
		assert.equal(isContextOverflow(errorAssistantMessage("input token count (10)\nexceeds the maximum")), false);
	});

	test("stripAnsi completes in linear time on 40k+ unclosed OSC sequences and preserves exact CSI fallback", () => {
		const pathological = "\u001b]".repeat(QUADRATIC_REPS);
		const sameLengthBenign = "a".repeat(pathological.length);
		const result = assertLinearTime(
			"stripAnsi(unclosed OSC repeated)",
			() => {
				stripAnsi(sameLengthBenign);
			},
			() => stripAnsi(pathological),
		);
		assert.equal(result, pathological);
		assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
		assert.equal(stripAnsi("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007"), "link");
		assert.equal(stripAnsi("\u001b]0;title\u001b\\body"), "body");
		assert.equal(stripAnsi("\u001b]0;unclosed"), "nclosed");
		assert.equal(stripAnsi("\u001b]0;a\u001bb\u0007rest"), "rest");
	});

	test("workedVerb, mayHaveReachedReason, formatCacheWarmingUsage, and scrub run in linear time", () => {
		const longLetters = `${"a".repeat(LONG_QUADRATIC_REPS)}!`;
		const benignSpaces = " ".repeat(longLetters.length);
		assert.equal(
			assertLinearTime(
				"workedVerb(long letters)",
				() => {
					workedVerb(benignSpaces);
				},
				() => workedVerb(longLetters),
			),
			"Worked",
		);
		assert.equal(workedVerb("Thinking…"), "Thought");
		assert.equal(workedVerb("Re-indexing files"), "Re-indexed");
		assert.equal(workedVerb("inginging'inging"), "Inginging'inged");

		const longWs = `${" ".repeat(LONG_QUADRATIC_REPS)}x`;
		assert.match(
			assertLinearTime(
				"mayHaveReachedReason(leading spaces)",
				() => {
					mayHaveReachedReason("worker-1", "a".repeat(longWs.length));
				},
				() => mayHaveReachedReason("worker-1", longWs),
			),
			/may already have this message/,
		);
		assert.equal(
			mayHaveReachedReason("w", "Session ended. The message was not delivered; send again."),
			'Subagent "w" may already have this message: Intercom handed it over before it restarted, and the subagent had not confirmed it. It was not handed over again. Session ended.',
		);

		assert.equal(formatCacheWarmingUsage(0.0123), "Cache warmed: $0.0123");
		assert.equal(formatCacheWarmingUsage(0.01), "Cache warmed: $0.010");
		assert.equal(formatCacheWarmingUsage(0.0123456), "Cache warmed: $0.012346");

		const scrubResult = scrub("**api_key**: sk_live_1234567890abcdef1234***");
		assert.equal(scrubResult.text.includes("sk_live_1234567890abcdef1234"), false);

		assert.equal(extractBearerToken("Bearer secret-token"), "secret-token");
		assert.equal(extractBearerToken("bearer   tok 123"), "tok 123");
		assert.equal(extractBearerToken(`Bearer${" ".repeat(LONG_QUADRATIC_REPS)}\n`), undefined);
		assert.equal(matchesOnSameLineCI("remote: Repository foo/bar not found.", "repository ", " not found"), true);
		assert.equal(matchesOnSameLineCI("repository ".repeat(QUADRATIC_REPS), "repository ", " not found"), false);
	});
});
