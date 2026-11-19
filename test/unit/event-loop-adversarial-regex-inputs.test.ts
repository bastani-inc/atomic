import assert from "node:assert/strict";
import type { Message } from "@bastani/atomic-ai/compat";
import { describe, test } from "vitest";
import { normalizeChangelogLinks } from "../../packages/coding-agent/src/utils/changelog.ts";
import type { SupervisorInterviewRequest } from "../../packages/intercom/intercom-utils.ts";
import { parseStructuredSupervisorReply } from "../../packages/intercom/intercom-utils.ts";
import { stripSubagentOrchestrationSkill } from "../../packages/subagents/src/runs/inprocess/prompt-behavior.ts";
import { isMutatingBashCommand } from "../../packages/subagents/src/runs/shared/long-running-guard.ts";
import { detectSubagentError } from "../../packages/subagents/src/shared/utils.ts";
import { extractOutputTarget } from "../../packages/subagents/src/tui/render-status-progress.ts";

const RUN = 100_000;
const LONG_RUN = 4 * RUN;
const CUBIC_RUN = 3_000;
const ADVERSARIAL_INPUT_BUDGET_MS = 1_000;

function timed<T>(run: () => T): T {
	const started = performance.now();
	const value = run();
	const elapsedMs = performance.now() - started;
	assert.ok(
		elapsedMs < ADVERSARIAL_INPUT_BUDGET_MS,
		`took ${elapsedMs.toFixed(0)} ms on an adversarial input; the budget is ${ADVERSARIAL_INPUT_BUDGET_MS} ms`,
	);
	return value;
}

const spaces = (count: number): string => " ".repeat(count);

function bashResult(text: string, isError: boolean): Message {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	};
}

describe("tool output", () => {
	test("detecting a subagent's exit code reads a long run of spaces after `exit` once", () => {
		const output = `exit${spaces(CUBIC_RUN)}`;
		assert.deepEqual(
			timed(() => detectSubagentError([bashResult(output, true)])),
			{ hasError: true, exitCode: 1, errorType: "bash", details: output.slice(0, 200) },
		);
		assert.equal(timed(() => detectSubagentError([bashResult(output, false)])).hasError, false);
	});

	test("the exit code is still read after `exit`, `with`, `code` or `status`, and a colon", () => {
		for (const [output, exitCode] of [
			["exit 3", 3],
			["exited with code 4", 4],
			["Exit status: 5", 5],
			["exited with  code  :  6", 6],
			["exit\n\t7", 7],
		] as const) {
			assert.equal(detectSubagentError([bashResult(output, true)]).exitCode, exitCode, output);
		}
	});
});

describe("model-written commands and tasks", () => {
	test("classifying a bash command reads a long run of spaces after `sed` or `perl` once", () => {
		assert.equal(
			timed(() => isMutatingBashCommand(`sed${spaces(RUN)}`)),
			false,
		);
		assert.equal(
			timed(() => isMutatingBashCommand(`perl${spaces(RUN)}`)),
			false,
		);
	});

	test("in-place sed and perl edits are classified as before, across line breaks after the command name", () => {
		for (const command of [
			"sed -e s/a/b/ -i f",
			"x; sed\n\n  -i s/a/b/ f",
			"sed \n -i f",
			"sed -e x\n-i",
			"perl -e 1 -pi f",
		]) {
			assert.equal(isMutatingBashCommand(command), true, command);
		}
		for (const command of ["sed s/a/b/ f", "sed -e 's/-i/x/'", "perl -e 1"]) {
			assert.equal(isMutatingBashCommand(command), false, command);
		}
	});

	test("finding a task's output target reads a long run of spaces after `[Write to:` once", () => {
		assert.equal(
			timed(() => extractOutputTarget(`[Write to:${spaces(RUN)}`)),
			undefined,
		);
		assert.equal(extractOutputTarget("[Write to:  \n  out/report.md ]"), "out/report.md");
		assert.equal(extractOutputTarget("[Write to: out.md]"), "out.md");
	});
});

describe("prompts", () => {
	function stripWithPatterns(prompt: string): string {
		return prompt
			.replace(/\n{0,2}<skill\s+name=["']subagent(?:@[^"']*)?["'][^>]*>[\s\S]*?<\/skill>\n{0,2}/g, "\n\n")
			.replace(/[ \t]*<skill>\s*[\s\S]*?<\/skill>\s*/g, (block) =>
				/<name>\s*subagent(?:@[^<\s]*)?\s*<\/name>/.test(block) ? "" : block,
			);
	}

	test("stripping the orchestration skill reads a long run of spaces, or many unclosed blocks, once", () => {
		for (const prompt of [`<skill>${spaces(RUN)}`, `x${spaces(RUN)}y`, "<skill>".repeat(RUN / 10)]) {
			assert.equal(
				timed(() => stripSubagentOrchestrationSkill(prompt)),
				prompt,
			);
		}
	});

	test("stripping the orchestration skill removes exactly what the patterns it replaced removed", () => {
		const pieces = [
			"<skill>",
			"</skill>",
			"<name>subagent</name>",
			"<name> subagent@1.2 </name>",
			"<name>other</name>",
			'<skill name="subagent">',
			" ",
			"\t",
			"\n",
			"\r\n",
			"text",
		];
		let seed = 1;
		const next = (limit: number): number => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed % limit;
		};
		for (let sample = 0; sample < 2_000; sample++) {
			let prompt = "";
			for (let count = next(16); count > 0; count--) prompt += pieces[next(pieces.length)];
			assert.equal(stripSubagentOrchestrationSkill(prompt), stripWithPatterns(prompt), JSON.stringify(prompt));
		}
		assert.equal(
			stripSubagentOrchestrationSkill(
				"keep\n  <skill>\n<name>subagent</name>\n</skill>\n\n  <skill><name>x</name></skill> end",
			),
			"keep\n<skill><name>x</name></skill> end",
		);
	});
});

describe("model replies", () => {
	const interview: SupervisorInterviewRequest = { questions: [{ id: "q", type: "text", question: "Why?" }] };

	test("reading a supervisor's fenced reply reads a long run of spaces after the fence once", () => {
		assert.equal(
			timed(() => parseStructuredSupervisorReply(`\`\`\`${spaces(LONG_RUN)}`, interview)),
			undefined,
		);
		assert.deepEqual(
			parseStructuredSupervisorReply('```json\n  {"responses":[{"id":"q","value":"x"}]}\n```', interview),
			{
				value: { responses: [{ id: "q", value: "x" }] },
			},
		);
	});
});

describe("release notes", () => {
	test("normalizing changelog links reads a long run of spaces in an unclosed link once", () => {
		const markdown = `[a](b${spaces(RUN)}`;
		assert.equal(
			timed(() => normalizeChangelogLinks(markdown, "0.1.0")),
			markdown,
		);
	});
});
