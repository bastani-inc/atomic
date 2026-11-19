import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	type ToolCall,
	type ToolResultMessage,
} from "@bastani/atomic-ai/compat";
import { afterAll, afterEach, test, vi } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { stopDetachedBroker } from "../helpers/detached-broker.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

const REAL_STAGE_AND_SUBAGENT_TIMEOUT_MS = 120_000;
const PROVIDER = "faux-reach-5352";
const MAIN_MODEL = "main-5352";
const STAGE_MODEL = "stage-5352";
const CHILD_MODEL = "child-5352";
const HOME = "doc-a-5352";
const REACHABLE = "doc-b-5352";

type Prober = "stage" | "subagent";

const PROBE_CALLS: readonly ToolCall[] = [
	fauxToolCall("intercom", { action: "status" }),
	fauxToolCall("intercom", { action: "groups" }),
	fauxToolCall("intercom", { action: "join", group: REACHABLE }),
];

const agentDir = useTemporaryAgentDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	clearSubagentControls();
	vi.unstubAllEnvs();
});
afterAll(() => stopDetachedBroker(agentDir));

function resultText(message: ToolResultMessage): string {
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function scriptedModel(probes: Map<Prober, readonly ToolResultMessage[]>): FauxResponseFactory {
	return (context, _options, _state, model) => {
		const prober: Prober | undefined =
			model.id === STAGE_MODEL ? "stage" : model.id === CHILD_MODEL ? "subagent" : undefined;
		const results = context.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
		if (prober !== undefined) {
			const next = PROBE_CALLS[results.length];
			if (next) return fauxAssistantMessage([{ ...next }], { stopReason: "toolUse" });
			probes.set(prober, results);
			return fauxAssistantMessage(`${prober} probed Intercom`);
		}
		const launched = results.some((message) => message.toolName === "workflow");
		const runRequested = context.messages.some(
			(message) =>
				message.role === "user" && JSON.stringify(message.content).includes("Run the probe-5352 workflow"),
		);
		if (runRequested && !launched)
			return fauxAssistantMessage(
				[fauxToolCall("workflow", { action: "run", workflow: "probe-5352", inputs: {} })],
				{
					stopReason: "toolUse",
				},
			);
		const delegated = results.some((message) => message.toolName === "subagent");
		const asked = context.messages.some(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("Delegate the probe"),
		);
		if (asked && !delegated)
			return fauxAssistantMessage(
				[
					fauxToolCall("subagent", {
						agent: "probe-5352",
						task: "Probe Intercom.",
						group: "team",
					}),
				],
				{ stopReason: "toolUse" },
			);
		return fauxAssistantMessage("done");
	};
}

async function mainSession(cwd: string, respond: FauxResponseFactory): Promise<AgentSession> {
	const faux = registerFauxProvider({
		provider: PROVIDER,
		models: [{ id: MAIN_MODEL }, { id: STAGE_MODEL }, { id: CHILD_MODEL }],
	});
	cleanups.push(() => faux.unregister());
	faux.setResponses(Array.from({ length: 40 }, () => respond));
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(PROVIDER, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	modelRuntime.registerProvider(PROVIDER, {
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
		cwd,
		agentDir,
		modelRuntime,
		model: faux.getModel(MAIN_MODEL),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			sessionSummary: { enabled: false },
		}),
		sessionManager: SessionManager.inMemory(cwd),
		builtins: { mcp: false, "web-access": false },
		intercom: { group: HOME, reachable: [REACHABLE] },
	});
	cleanups.push(() => session.dispose());
	return session;
}

function writeProject(cwd: string): void {
	mkdirSync(join(cwd, ".atomic", "workflows"), { recursive: true });
	mkdirSync(join(cwd, ".atomic", "agents"), { recursive: true });
	writeFileSync(
		join(cwd, ".atomic", "workflows", "probe-5352.ts"),
		`import { workflow } from "@bastani/atomic/workflows";
export default workflow({
	name: "probe-5352",
	description: "A stage in its own subgroup probes Intercom",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.stage("probe", { model: "${PROVIDER}/${STAGE_MODEL}", group: "team" }).prompt("Probe Intercom.");
		return {};
	},
});
`,
	);
	writeFileSync(
		join(cwd, ".atomic", "agents", "probe-5352.md"),
		`---
name: probe-5352
description: Probes Intercom
tools: intercom
model: ${PROVIDER}/${CHILD_MODEL}
---

Probe Intercom and report.
`,
	);
}

function assertConfined(results: readonly ToolResultMessage[] | undefined, who: Prober, home: string): void {
	assert.ok(results, `${who} finished its probe`);
	const [status, groups, join] = results;
	assert.equal(status?.isError, false, `${who} status: ${status ? resultText(status) : ""}`);
	assert.match(resultText(status!), new RegExp(`Groups: ${home.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\n`), who);
	assert.equal(groups?.isError, false);
	assert.deepEqual(
		((groups?.details as { groups?: Array<{ group: string }> } | undefined)?.groups ?? []).map(
			(summary) => summary.group,
		),
		[home],
		`${who} sees only its own group`,
	);
	assert.equal(join?.isError, true, `${who} cannot join the group its parent reaches`);
	assert.match(resultText(join!), new RegExp(`Group "${REACHABLE}" is outside this session's Intercom reach`));
}

test(
	"a session with the option runs a workflow whose stage, and a subagent, get their own groups and reach nothing else (#5352)",
	async () => {
		vi.stubEnv("NODE_ENV", "production");
		const cwd = makeTempDirectory("atomic-intercom-reach-children-");
		cleanups.push(() => removeTempDirectory(cwd));
		writeProject(cwd);
		const probes = new Map<Prober, readonly ToolResultMessage[]>();
		const session = await mainSession(cwd, scriptedModel(probes));

		await session.prompt("Run the probe-5352 workflow.");
		const runId = await vi.waitFor(
			async () => {
				const [run] = await session.workflows.listRuns();
				assert.ok(run, "the workflow run started");
				return run.runId;
			},
			{ timeout: 10_000 },
		);
		await session.workflows.waitForSettled(runId);
		assert.equal((await session.workflows.getRun(runId)).status, "completed");
		assertConfined(probes.get("stage"), "stage", `workflow:${runId}/team`);

		await session.prompt("Delegate the probe to the probe-5352 subagent.", { streamingBehavior: "followUp" });
		await vi.waitFor(() => assert.ok(probes.has("subagent")), { timeout: REAL_STAGE_AND_SUBAGENT_TIMEOUT_MS });
		assertConfined(probes.get("subagent"), "subagent", `${HOME}/team`);
	},
	REAL_STAGE_AND_SUBAGENT_TIMEOUT_MS,
);
