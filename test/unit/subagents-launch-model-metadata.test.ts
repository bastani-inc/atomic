import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { ModelSingleResponse } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { renderSubagentToolResult } from "../../packages/subagents/src/extension/tool-rendering.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runAgentTask, taskToolResult } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import {
	findSubagentControl,
	unregisterSubagentControl,
} from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { createCandidateModelResolver } from "../../packages/subagents/src/shared/model-resolution.js";
import type { RunSyncOptions, SingleResult, SubagentToolResult } from "../../packages/subagents/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const parentModel: Model<Api> = {
	provider: "fixture",
	id: "inherited",
	name: "Inherited model",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
};
const pinnedModel: Model<Api> = { ...parentModel, id: "pinned" };
const models = [parentModel, pinnedModel];
const worker: AgentConfig = {
	name: "worker",
	description: "Launch metadata fixture",
	systemPrompt: "Work",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "project",
	filePath: "worker.md",
};
const lookup = {
	getAvailable: () => models,
	find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
	hasConfiguredAuth: () => true,
};

function receiptText(result: SubagentToolResult): string {
	return stripVTControlCharacters(
		renderSubagentToolResult(result, { expanded: false, isPartial: false }, theme, {
			toolCallId: "launch-model",
			state: {},
			invalidate() {},
		})
			.render(120)
			.join("\n"),
	);
}

async function withQueuedLaunch(
	config: { agent?: Partial<AgentConfig>; options?: Partial<RunSyncOptions> },
	verify: (fixture: {
		host: AgentTaskHost;
		response: ModelSingleResponse;
		updates: SubagentToolResult[];
		release: () => void;
		terminal: Promise<SingleResult>;
	}) => void | Promise<void>,
): Promise<void> {
	initTheme("dark");
	const cwd = makeTempDirectory("subagent-launch-model-");
	const runId = randomUUID();
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: runId }, authorizeLaunch() {} });
	const gate = Promise.withResolvers<void>();
	const terminal = Promise.withResolvers<SingleResult>();
	const updates: SubagentToolResult[] = [];
	try {
		// Hold four admitted turns in a run that runs four children at a time, so the fifth child
		// waits for a slot before its session exists until the test releases them. The default running
		// capacity (1000 since the agent-count raise) admits it at once, racing its session start
		// against every "before the child reports" read here. This exercises the same early receipt
		// boundary as asynchronous resource loading, without mocking model selection, the owner task
		// store, or the renderer.
		for (let index = 0; index < 5; index++) {
			const response = await runAgentTask({
				host,
				cwd,
				agents: [{ ...worker, ...(index === 4 ? config.agent : {}) }],
				agent: "worker",
				task: `Inspect ${index}`,
				options: {
					runId,
					index,
					currentModel: "fixture/inherited",
					currentThinkingLevel: "high",
					resolveCandidateModel: createCandidateModelResolver(lookup),
					runningCapacity: 4,
					testSession: { promptGate: gate.promise },
					...(index === 4 ? config.options : {}),
					onUpdate: index === 4 ? (update) => updates.push(update) : undefined,
				},
				runtime: { runSync },
				onTerminal: index === 4 ? terminal.resolve : undefined,
			});
			assert.equal(response.kind, "admitted");
			if (index !== 4) continue;
			await verify({ host, response, updates, release: gate.resolve, terminal: terminal.promise });
		}
	} finally {
		gate.resolve();
		await host.close("session-close");
		const control = findSubagentControl(runId);
		if (control) unregisterSubagentControl(control);
		removeTempDirectory(cwd);
	}
}

test("background receipt retains the resolved inherited model before child session startup", async () => {
	await withQueuedLaunch({}, ({ host, response, updates }) => {
		assert.equal(updates[0]?.details?.progress?.[0]?.model, "fixture/inherited");
		assert.equal(updates[0]?.details?.progress?.[0]?.thinking, "high");
		const receipt = taskToolResult(response, host);
		const text = receiptText(receipt);
		assert.match(text, /fixture\/inherited.*thinking high/);
		assert.doesNotMatch(text, /unavailable/);
		assert.equal(receipt.details?.taskRecords?.length, 1);
		assert.equal(receipt.details?.taskRecords?.[0]?.model, "fixture/inherited");
		assert.equal(receipt.details?.taskRecords?.[0]?.thinking, "high");
	});
});

test("launch and status cards show the selected child model and suffix, not the parent's settings", async () => {
	await withQueuedLaunch({ agent: { model: "fixture/pinned:low", thinking: "medium" } }, ({ host, response }) => {
		const receipt = taskToolResult(response, host);
		assert.equal(receipt.details?.taskRecords?.[0]?.model, "fixture/pinned");
		assert.equal(receipt.details?.taskRecords?.[0]?.thinking, "low");
		for (const details of [receipt.details!, { ...receipt.details!, taskResponse: undefined }]) {
			const text = receiptText({ ...receipt, details });
			assert.match(text, /fixture\/pinned.*thinking low/);
			assert.doesNotMatch(text, /fixture\/inherited|thinking high|thinking medium|unavailable/);
		}
	});
});

test("launch reasoning is clamped to the selected model's capabilities", async () => {
	await withQueuedLaunch({ agent: { model: "fixture/pinned:max" } }, ({ host, response }) => {
		const receipt = taskToolResult(response, host);
		assert.equal(receipt.details?.taskRecords?.[0]?.thinking, "high");
		assert.match(receiptText(receipt), /fixture\/pinned.*thinking high/);
		assert.doesNotMatch(receiptText(receipt), /thinking max/);
	});
});

test("unresolved candidates stay unavailable until the child session reports its actual settings", async () => {
	await withQueuedLaunch(
		{
			agent: { model: "fixture/missing:low" },
			options: { testSession: { sessionModel: "fixture/pinned", sessionThinkingLevel: "off" } },
		},
		async ({ host, response, release, terminal }) => {
			const receipt = taskToolResult(response, host);
			assert.equal(receipt.details?.taskRecords?.[0]?.model, undefined);
			assert.equal(receipt.details?.taskRecords?.[0]?.thinking, undefined);
			assert.match(receiptText(receipt), /model \/ thinking unavailable/);
			assert.doesNotMatch(receiptText(receipt), /fixture\/inherited|fixture\/missing|thinking high/);
			release();
			await terminal;
			const current = taskToolResult(response, host);
			assert.equal(current.details?.taskRecords?.[0]?.model, "fixture/pinned");
			assert.equal(current.details?.taskRecords?.[0]?.thinking, "off");
			assert.match(receiptText(current), /fixture\/pinned.*thinking off/);
		},
	);
});

test("later fallback settings replace admission metadata without changing the launch snapshot", async () => {
	await withQueuedLaunch(
		{ options: { testSession: { fallbackModel: "fixture/pinned", fallbackThinkingLevel: "off" } } },
		async ({ host, response, release, terminal }) => {
			const launch = taskToolResult(response, host);
			assert.match(receiptText(launch), /fixture\/inherited.*thinking high/);
			release();
			const child = await terminal;
			assert.equal(child.model, "fixture/pinned");
			assert.equal(child.thinking, "off");
			assert.equal(response.kind, "admitted");
			if (response.kind !== "admitted") throw new Error("Expected admission");
			const observed = await host.waitForTask(response.observation.taskId);
			assert.ok(observed.ok);
			assert.equal(observed.value.kind, "settled");
			const receipt = taskToolResult({ kind: "admitted", observation: observed.value }, host);
			assert.equal(receipt.details?.taskRecords?.[0]?.execution.kind, "settled");
			assert.match(receiptText(receipt), /fixture\/pinned.*thinking off/);
			assert.doesNotMatch(receiptText(receipt), /fixture\/inherited|thinking high/);
			assert.match(receiptText(launch), /fixture\/inherited.*thinking high/);
		},
	);
});

test("a selected child model without known reasoning does not borrow the parent's reasoning", async () => {
	await withQueuedLaunch({ agent: { model: "fixture/pinned" } }, ({ host, response }) => {
		const receipt = taskToolResult(response, host);
		assert.equal(receipt.details?.taskRecords?.[0]?.model, "fixture/pinned");
		assert.equal(receipt.details?.taskRecords?.[0]?.thinking, undefined);
		assert.match(receiptText(receipt), /fixture\/pinned/);
		assert.doesNotMatch(receiptText(receipt), /fixture\/inherited|thinking high/);
	});
});

test("a child that reaches its session before the receipt is read still reports the selected model without its thinking suffix (#4009)", async () => {
	initTheme("dark");
	const cwd = makeTempDirectory("subagent-launch-model-session-");
	const runId = randomUUID();
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: runId }, authorizeLaunch() {} });
	const gate = Promise.withResolvers<void>();
	const launched = Promise.withResolvers<void>();
	try {
		const response = await runAgentTask({
			host,
			cwd,
			agents: [{ ...worker, model: "fixture/pinned:low", thinking: "medium" }],
			agent: "worker",
			task: "Inspect",
			options: {
				runId,
				index: 0,
				currentModel: "fixture/inherited",
				currentThinkingLevel: "high",
				resolveCandidateModel: createCandidateModelResolver(lookup),
				// No session model: the child's own session reports nothing better than its selection.
				testSession: { promptGate: gate.promise },
				onChildLaunch: () => launched.resolve(),
			},
			runtime: { runSync },
		});
		assert.equal(response.kind, "admitted");
		await launched.promise;
		const receipt = taskToolResult(response, host);
		assert.equal(receipt.details?.taskRecords?.[0]?.model, "fixture/pinned");
		assert.equal(receipt.details?.taskRecords?.[0]?.thinking, "low");
	} finally {
		gate.resolve();
		await host.close("session-close");
		const control = findSubagentControl(runId);
		if (control) unregisterSubagentControl(control);
		removeTempDirectory(cwd);
	}
});
