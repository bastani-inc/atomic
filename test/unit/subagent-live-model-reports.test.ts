import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { ActivityReport } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { LIVE_CHILD_START_WAIT_MS, liveChildEnvironment } from "../helpers/live-child-environment.js";

/** A live child loads its real resources; that load is the structural cost of these tests. */
const LIVE_CHILD_TIMEOUT_MS = 120_000;
const CONDITION_WAIT_MS = 20_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "worker agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/worker.md",
		thinking: "high",
	};
}

async function until(predicate: () => boolean, timeoutMs = CONDITION_WAIT_MS): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!predicate() && performance.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 5));
	assert.ok(predicate(), "condition never held");
}

type ModelChange = Extract<ActivityReport["change"], { kind: "model" }>;

/**
 * A child on `faux/faux-1` at `high` whose first request fails as a missing model: its session falls back to
 * `faux/faux-2` at `low`, which then runs a call that blocks until the child is stopped.
 */
async function fellBackChild(runId: string) {
	const env = await liveChildEnvironment(cleanups, {
		models: [
			{ id: "faux-1", reasoning: true },
			{ id: "faux-2", reasoning: true },
		],
		fallbackModels: ["faux/faux-2:low"],
	});
	env.faux.setResponses([
		fauxAssistantMessage([], {
			stopReason: "error",
			// A missing model falls back at once; an overloaded one is retried on the same model first (#4994).
			errorMessage: "404 Not Found: the model faux-1 is unavailable",
		}),
		fauxAssistantMessage([fauxToolCall("block", {}, { id: `${runId}-block` })], { stopReason: "toolUse" }),
	]);
	const reports: ModelChange[] = [];
	let source: TaskTranscriptSource | undefined;
	const stop = new AbortController();
	const run = runSingleInProcess(env.root, agent(), "run until stopped", {
		...env.options(runId, {
			signal: stop.signal,
			taskExecution: {
				signal: stop.signal,
				reportActivity(report) {
					if (report.change.kind === "model") reports.push(report.change);
				},
				bindTranscript(bound) {
					if (bound.chatSession !== undefined) source ??= bound;
				},
				onExecution() {},
			},
		}),
	});
	await until(() => env.blockStarted() && source !== undefined, LIVE_CHILD_START_WAIT_MS);
	return {
		env,
		run,
		stop,
		reports,
		session: () => source!.chatSession as unknown as AgentSession,
	};
}

test(
	"a subagent that falls back reports the fallback model with the fallback's level in one report, never with the level it ran at before",
	async () => {
		const child = await fellBackChild("fallback-pair");
		try {
			assert.deepEqual(child.reports.at(-1), { kind: "model", model: "faux/faux-2", thinking: "low" });
			const mixed = child.reports.filter((change) => change.model === "faux/faux-2" && change.thinking !== "low");
			assert.deepEqual(mixed, [], "no report pairs the fallback model with the level the first model ran at");
			assert.ok(child.reports.some((change) => change.model === "faux/faux-1" && change.thinking === "high"));
		} finally {
			child.stop.abort("user");
			await child.run;
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a subagent whose session switches model without a fallback, as an extension's setModel does, reports the model it runs on now",
	async () => {
		const child = await fellBackChild("model-set");
		try {
			const session = child.session();
			const first = child.env.faux.getModel("faux-1");
			assert.ok(first);
			await session.setModel(first);
			await until(() => child.reports.at(-1)?.model === "faux/faux-1");
			assert.deepEqual(child.reports.at(-1), {
				kind: "model",
				model: `${session.model!.provider}/${session.model!.id}`,
				thinking: session.thinkingLevel,
			});
			await session.setThinkingLevel("medium");
			await until(() => child.reports.at(-1)?.thinking === "medium");
			assert.deepEqual(child.reports.at(-1), { kind: "model", model: "faux/faux-1", thinking: "medium" });
		} finally {
			child.stop.abort("user");
			await child.run;
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);
