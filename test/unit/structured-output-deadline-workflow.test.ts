import assert from "node:assert/strict";
import { createStructuredOutputCapture, createStructuredOutputTool } from "@bastani/atomic";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, test, vi } from "vitest";
import { stripWorkflowOnlyOptions } from "../../packages/workflows/src/runs/foreground/stage-runner-options.js";
import {
	isStructuredOutputContractFailure,
	isWorkflowStructuredOutputContractError,
	stageOptionsWithStructuredOutput,
} from "../../packages/workflows/src/runs/foreground/stage-runner-structured-output.js";
import { decisionMessage, decisionModel } from "../helpers/structured-output.js";
import { toolContext } from "../helpers/tool-context.js";
import {
	type AgentSession,
	createStageContext,
	makeMockSession,
	makeOpts,
	skippedStructuredOutputTurn,
} from "./stage-runner-helpers.js";

const schema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });
const DEADLINE_MS = 1_000;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
	vi.useRealTimers();
});

function hangingContext(extra: { getHttpIdleTimeoutMs?: () => number } = {}) {
	const context = toolContext({
		model: decisionModel,
		modelRegistry: {
			getAll: () => [decisionModel],
			streamSimple: (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
				const stream = createAssistantMessageEventStream();
				options?.signal?.addEventListener(
					"abort",
					() => {
						const message = { ...decisionMessage(), content: [], stopReason: "aborted" as const };
						stream.push({ type: "error", reason: "aborted", error: message });
					},
					{ once: true },
				);
				return stream;
			},
		},
		...extra,
	} as never);
	return { context };
}

function structuredOutputToolOf(options: Parameters<typeof stageOptionsWithStructuredOutput>[0]) {
	const tool = stageOptionsWithStructuredOutput(options, createStructuredOutputCapture())?.customTools?.find(
		(candidate) => candidate.name === "structured_output",
	);
	assert.ok(tool, "the schema-backed stage registers structured_output");
	return tool;
}

interface Outcome {
	settled: boolean;
	error?: Error;
}

function startDecision(tool: ReturnType<typeof structuredOutputToolOf>, context: never): Outcome {
	const outcome: Outcome = { settled: false };
	tool.execute("call-1", { instructions: "Decide.", state: { task: "Review" } }, undefined, undefined, context).then(
		() => {
			outcome.settled = true;
		},
		(error: Error) => {
			outcome.settled = true;
			outcome.error = error;
		},
	);
	return outcome;
}

test("a stage's schemaTimeoutMs bounds the structured_output decision (#3806)", async () => {
	const tool = structuredOutputToolOf({ schema, schemaTimeoutMs: DEADLINE_MS });
	const { context } = hangingContext({ getHttpIdleTimeoutMs: () => 600_000 });
	const outcome = startDecision(tool, context as never);

	await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
	assert.equal(outcome.settled, false);
	await vi.advanceTimersByTimeAsync(1);

	assert.equal(outcome.settled, true);
	assert.match(
		outcome.error?.message ?? "",
		/^Structured output decision exceeded its 1000ms deadline; no decision was accepted\./,
	);
});

test("without schemaTimeoutMs the stage follows the session's httpIdleTimeoutMs (#3806)", async () => {
	const tool = structuredOutputToolOf({ schema });
	const { context } = hangingContext({ getHttpIdleTimeoutMs: () => 2_500 });
	const outcome = startDecision(tool, context as never);

	await vi.advanceTimersByTimeAsync(2_500);

	assert.match(outcome.error?.message ?? "", /^Structured output decision exceeded its 2500ms deadline/);
});

test("schemaTimeoutMs wins over the session's httpIdleTimeoutMs (#3806)", async () => {
	const tool = structuredOutputToolOf({ schema, schemaTimeoutMs: 400 });
	const { context } = hangingContext({ getHttpIdleTimeoutMs: () => 2_500 });
	const outcome = startDecision(tool, context as never);

	await vi.advanceTimersByTimeAsync(400);

	assert.match(outcome.error?.message ?? "", /^Structured output decision exceeded its 400ms deadline/);
});

test("an invalid schemaTimeoutMs fails when the stage is set up, before any model turn (#3806)", () => {
	for (const schemaTimeoutMs of [0, -1, 1.5, Number.NaN]) {
		assert.throws(
			() => stageOptionsWithStructuredOutput({ schema, schemaTimeoutMs }, createStructuredOutputCapture()),
			/timeoutMs/,
			String(schemaTimeoutMs),
		);
	}
});

test("schemaTimeoutMs is a workflow-only option and never reaches the session factory (#3806)", async () => {
	const options = await stripWorkflowOnlyOptions({ schema, schemaTimeoutMs: DEADLINE_MS }, undefined, {
		runId: "run",
		stageId: "stage",
		stageName: "Stage",
	});

	assert.equal(Object.hasOwn(options, "schemaTimeoutMs"), false);
	assert.equal(Object.hasOwn(options, "schema"), false);
});

async function expiredDecisionMessage(): Promise<string> {
	const tool = createStructuredOutputTool({ schema, timeoutMs: DEADLINE_MS });
	const { context } = hangingContext();
	let message = "";
	tool
		.execute("call-1", { instructions: "Decide.", state: { task: "Review" } }, undefined, undefined, context)
		.catch((error: Error) => {
			message = error.message;
		});
	await vi.advanceTimersByTimeAsync(DEADLINE_MS);
	return message;
}

test("a deadline overrun is an execution failure, while an exhausted repair budget stays a contract failure (#3806)", async () => {
	const deadline = await expiredDecisionMessage();
	assert.match(deadline, /^Structured output decision exceeded its 1000ms deadline/);

	assert.equal(isStructuredOutputContractFailure(deadline), false, deadline);
	assert.equal(
		isStructuredOutputContractFailure(
			"Structured output requires one structured_output call. Structured output repair exhausted after 4 attempts. Attempts: 1) stopReason=stop 25m02s; 2) stopReason=length 1m30s; 3) stopReason=toolUse 2.0s; 4) stopReason=stop 100ms.",
		),
		true,
	);
});

test("the stage fails with the deadline text unchanged, not as a structured-output contract error (#3806)", async () => {
	const deadline = await expiredDecisionMessage();
	vi.useRealTimers();
	let prompts = 0;
	const messages = [] as AgentSession["messages"];
	const mock = makeMockSession({
		messages,
		async prompt() {
			prompts += 1;
			skippedStructuredOutputTurn(messages);
			mock.emit({
				type: "tool_execution_end",
				toolName: "structured_output",
				isError: true,
				result: { content: [{ type: "text", text: deadline }] },
			});
		},
	});
	const stage = createStageContext(
		makeOpts({
			stageOptions: { schema },
			adapters: { agentSession: { create: async () => mock.session } },
		}),
	);

	try {
		const failure = await stage.prompt("decide").then(
			() => undefined,
			(error: Error) => error,
		);

		assert.ok(failure, "the stage must fail");
		assert.equal(failure.message, deadline);
		assert.equal(isWorkflowStructuredOutputContractError(failure), false);
		assert.equal(prompts, 4, "the existing corrective budget is unchanged");
	} finally {
		await stage.__dispose();
	}
});
