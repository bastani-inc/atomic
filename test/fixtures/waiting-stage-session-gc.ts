/**
 * Counts how many released stage sessions the runtime can collect while their stages wait (#4309). Real SDK stages
 * against a scripted model either wait on a detachable tool (`detached`) or are released by their author between
 * prompts (`release`). Prints one JSON line: sessions created before the wake, and how many of them were collected.
 *
 *   bun test/fixtures/waiting-stage-session-gc.ts detached
 *   node --expose-gc --import jiti/register test/fixtures/waiting-stage-session-gc.ts release
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { AuthStorage, ModelRuntime, SettingsManager, type ToolDefinition } from "../../packages/coding-agent/src/index.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

const mode = process.argv[2];
if (mode !== "detached" && mode !== "release") throw new Error("usage: waiting-stage-session-gc.ts detached|release");
const STAGES = 20;

function collectGarbage(): void {
	const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
	if (bun !== undefined) bun.gc(true);
	else (globalThis as { gc?: () => void }).gc?.();
}

async function collectAll(): Promise<void> {
	for (let round = 0; round < 10; round++) {
		collectGarbage();
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const cwd = mkdtempSync(join(tmpdir(), "waiting-stage-session-gc-"));
const faux = registerFauxProvider();
const model = faux.getModel();
const authStorage = AuthStorage.inMemory();
await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
const modelRuntime = await ModelRuntime.create({
	credentials: authStorage,
	modelsPath: null,
	modelsStore: new InMemoryCodingAgentModelsStore(),
});
modelRuntime.registerProvider(model.provider, {
	baseUrl: model.baseUrl,
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
faux.appendResponses(
	Array.from(
		{ length: 2 * STAGES },
		() => (context: { readonly messages: readonly { readonly role: string }[] }) =>
			mode === "release" || context.messages.at(-1)?.role === "toolResult"
				? fauxAssistantMessage("ci passed")
				: fauxAssistantMessage([fauxToolCall("wait_for_ci", {})], { stopReason: "toolUse" }),
	),
);

const answers: (() => void)[] = [];
const waitForCi: ToolDefinition = {
	name: "wait_for_ci",
	label: "Wait for CI",
	description: "Waits for the CI run of the change",
	parameters: Type.Object({}),
	detachable: true,
	execute: () =>
		new Promise<AgentToolResult>((resolve) =>
			answers.push(() => resolve({ content: [{ type: "text", text: "ci passed" }], details: undefined })),
		),
};
const sdk = createAgentSessionAdapter({
	cwd,
	agentDir: join(cwd, "agent"),
	model,
	modelRuntime,
	settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
	builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
	tools: mode === "detached" ? ["wait_for_ci"] : [],
});

let created = 0;
let collected = 0;
let waiting = 0;
const sessions = new FinalizationRegistry<number>(() => {
	collected += 1;
});
const definition = workflow({
	name: "waiting-stage-session-gc",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await Promise.all(
			Array.from({ length: STAGES }, async (_, index) => {
				if (mode === "detached") {
					await ctx.task(`stage-${index}`, { prompt: `watch ci ${index}`, customTools: [waitForCi] });
					return;
				}
				const stage = ctx.stage(`stage-${index}`);
				await stage.prompt(`watch ci ${index}`);
				await stage.release();
				waiting += 1;
				await new Promise<void>((resolve) => answers.push(resolve));
			}),
		);
		return {};
	},
});
const result = run(
	definition,
	{},
	{
		cwd,
		store: createStore(),
		journal: { memory: true },
		releaseWhenWaiting: { afterMs: 0 },
		onStageLifecycleEvent: (_runId, event) => {
			if (mode === "detached" && event.type === "stage_waiting") waiting += 1;
		},
		adapters: {
			sessionStore: new MemorySessionStore(),
			agentSession: {
				async create(...args: Parameters<typeof sdk.create>) {
					const session = await sdk.create(...args);
					created += 1;
					sessions.register("session" in session ? session.session : session, created);
					return session;
				},
			},
		},
	},
);
while (waiting < STAGES) await new Promise((resolve) => setTimeout(resolve, 10));
await collectAll();
const report = { mode, stages: STAGES, created, collected };
for (const answer of answers) answer();
const settled = await result;
faux.unregister();
rmSync(cwd, { recursive: true, force: true });
console.log(JSON.stringify({ ...report, status: settled.status }));
process.exit(0);
