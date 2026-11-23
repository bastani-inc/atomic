import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage, createAgentSession, ModelRuntime, SettingsManager } from "@bastani/atomic";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { startPtyProgram, withoutInheritedTestRunnerEnv } from "../helpers/pty-program.js";
import { makeTempDirectory } from "../helpers/runtime.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	while (cleanups.length > 0) await cleanups.pop()!();
	clearSubagentControls();
});

async function runSubagentThroughRealSession(envVars: Record<string, string | undefined>): Promise<{
	readonly childModelCalls: number;
	readonly finalAssistantText: string;
}> {
	for (const [key, value] of Object.entries(envVars)) vi.stubEnv(key, value);

	const root = makeTempDirectory("subagents-ambient-env-");
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const provider = `faux-ambient-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const agentsDir = join(root, ".atomic", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, "real-worker.md"),
		`---\nname: real-worker\ndescription: Real model worker\nmodel: ${provider}/child\n---\n\nAnswer directly.\n`,
	);

	let childModelCalls = 0;
	let waited = false;
	const respond: FauxResponseFactory = (context, _options, _state, model) => {
		if (model.id === "child") {
			childModelCalls++;
			return fauxAssistantMessage("REAL-SUBAGENT-ANSWER");
		}
		const toolResults = context.messages.filter((message) => message.role === "toolResult");
		if (toolResults.length === 0) {
			return fauxAssistantMessage(
				[fauxToolCall("subagent", { agent: "real-worker", task: "Answer with the real model" })],
				{ stopReason: "toolUse" },
			);
		}
		const lastTool = toolResults.at(-1);
		const toolText =
			lastTool && "content" in lastTool
				? lastTool.content
						.filter((part): part is { type: "text"; text: string } => part.type === "text")
						.map((part) => part.text)
						.join("\n")
				: "";
		if (!waited) {
			waited = true;
			const taskId = /"taskId"\s*:\s*"([^"]+)"/.exec(toolText)?.[1];
			assert.ok(taskId, `expected taskId in subagent tool result, got: ${toolText}`);
			return fauxAssistantMessage([fauxToolCall("subagent", { action: "wait", id: taskId })], {
				stopReason: "toolUse",
			});
		}
		return fauxAssistantMessage(`PARENT-SAW:${toolText}`);
	};

	const faux = registerFauxProvider({ provider, models: [{ id: "main" }, { id: "child" }] });
	cleanups.push(() => faux.unregister());
	faux.setResponses(Array.from({ length: 10 }, () => respond));

	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	modelRuntime.registerProvider(provider, {
		baseUrl: faux.getModel().baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			cost: registered.cost,
		})),
	});

	const { session } = await createAgentSession({
		cwd: root,
		modelRuntime,
		model: faux.getModel("main"),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			sessionSummary: { enabled: false },
		}),
		builtins: { mcp: false, intercom: false, "web-access": false },
	});
	cleanups.push(() => session.dispose());

	await session.prompt("Launch the subagent.");
	const messages = session.sessionManager.buildSessionContext().messages;
	const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
	const finalAssistantText =
		lastAssistant && "content" in lastAssistant
			? lastAssistant.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n")
			: "";
	return { childModelCalls, finalAssistantText };
}

test("ambient NODE_ENV=test never stubs subagents to 'done'", async () => {
	const result = await runSubagentThroughRealSession({ NODE_ENV: "test", NODE_TEST_CONTEXT: undefined });
	assert.equal(result.childModelCalls, 1, "subagent must invoke the real child model under NODE_ENV=test");
	assert.match(result.finalAssistantText, /REAL-SUBAGENT-ANSWER/);
});

test("ambient NODE_TEST_CONTEXT never stubs subagents to 'done'", async () => {
	const result = await runSubagentThroughRealSession({ NODE_ENV: "production", NODE_TEST_CONTEXT: "child-v8" });
	assert.equal(result.childModelCalls, 1, "subagent must invoke the real child model under NODE_TEST_CONTEXT");
	assert.match(result.finalAssistantText, /REAL-SUBAGENT-ANSWER/);
});

test("explicit options.testSession still runs the in-process stub regardless of NODE_ENV", async () => {
	vi.stubEnv("NODE_ENV", "production");
	const root = makeTempDirectory("subagents-explicit-stub-");
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const agent: AgentConfig = {
		name: "stub-worker",
		description: "Explicit stub test",
		systemPrompt: "Stub.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: join(root, "stub-worker.md"),
	};
	const result = await runSync(root, [agent], "stub-worker", "return explicit stub output", {
		cwd: root,
		runId: "explicit-stub-run",
		artifactsDir: root,
		testSession: { output: "EXPLICIT-STUB-OK" },
	});
	assert.equal(result.status, "ok");
	assert.equal(result.finalOutput, "EXPLICIT-STUB-OK");
});

test("startPtyProgram scrubs inherited Vitest NODE_ENV=test and VITEST markers by default while preserving explicit caller overrides", async () => {
	const root = makeTempDirectory("pty-env-scrub-");
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const script =
		'console.log("ENV_JSON=" + JSON.stringify({ nodeEnv: process.env.NODE_ENV ?? null, vitest: process.env.VITEST ?? null }));';

	// 1. Caller omits NODE_ENV and VITEST -> inherited Vitest NODE_ENV=test and VITEST=true must be cleared.
	const defaultPty = startPtyProgram({
		executable: process.execPath,
		args: ["-e", script],
		cwd: root,
		env: { PATH: process.env.PATH ?? "" },
		timeoutMs: 30_000,
		cols: 120,
		rows: 24,
	});
	try {
		await defaultPty.waitForScreen((s) => s.includes("ENV_JSON="), 15_000, "child env json");
		await defaultPty.exited;
		const match = defaultPty.screen().match(/ENV_JSON=(\{[^\n]+\})/);
		assert.ok(match, `expected ENV_JSON line, got:\n${defaultPty.screen()}`);
		const parsed = JSON.parse(match[1]!) as { nodeEnv: string | null; vitest: string | null };
		assert.notEqual(parsed.nodeEnv, "test", "startPtyProgram must not leak Vitest's NODE_ENV=test");
		assert.equal(parsed.vitest || "", "", "startPtyProgram must not leak Vitest's VITEST marker");
	} finally {
		defaultPty.kill();
		await defaultPty.exited;
	}

	// 2. Caller explicitly passes NODE_ENV="test" -> preserved verbatim.
	const explicitPty = startPtyProgram({
		executable: process.execPath,
		args: ["-e", script],
		cwd: root,
		env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
		timeoutMs: 30_000,
		cols: 120,
		rows: 24,
	});
	try {
		await explicitPty.waitForScreen((s) => s.includes("ENV_JSON="), 15_000, "explicit child env json");
		await explicitPty.exited;
		const match = explicitPty.screen().match(/ENV_JSON=(\{[^\n]+\})/);
		assert.ok(match, `expected ENV_JSON line, got:\n${explicitPty.screen()}`);
		const parsed = JSON.parse(match[1]!) as { nodeEnv: string | null; vitest: string | null };
		assert.equal(parsed.nodeEnv, "test", "explicit caller NODE_ENV must be preserved");
	} finally {
		explicitPty.kill();
		await explicitPty.exited;
	}
});

test("withoutInheritedTestRunnerEnv clears inherited NODE_ENV=test and runner markers while preserving explicit and non-test values", () => {
	const cleaned = withoutInheritedTestRunnerEnv(
		{ PATH: "/usr/bin" },
		{
			NODE_ENV: "test",
			VITEST: "true",
			VITEST_MODE: "test",
			VITEST_POOL_ID: "1",
			VITEST_WORKER_ID: "2",
			NODE_TEST_CONTEXT: "child-v8",
		},
	);
	assert.equal(cleaned.NODE_ENV, "");
	assert.equal(cleaned.VITEST, "");
	assert.equal(cleaned.VITEST_MODE, "");
	assert.equal(cleaned.VITEST_POOL_ID, "");
	assert.equal(cleaned.VITEST_WORKER_ID, "");
	assert.equal(cleaned.NODE_TEST_CONTEXT, "");

	const keptNonTest = withoutInheritedTestRunnerEnv({ PATH: "/usr/bin" }, { NODE_ENV: "production" });
	assert.equal("NODE_ENV" in keptNonTest, false, "non-test inherited NODE_ENV must not be overwritten");

	const keptExplicit = withoutInheritedTestRunnerEnv(
		{ PATH: "/usr/bin", NODE_ENV: "test", VITEST: "custom" },
		{ NODE_ENV: "test", VITEST: "true" },
	);
	assert.equal(keptExplicit.NODE_ENV, "test");
	assert.equal(keptExplicit.VITEST, "custom");
});
