import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/pi-ai/compat";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { AuthStorage, ModelRuntime, SettingsManager } from "../../packages/coding-agent/src/index.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { expireWorkflowLease } from "../helpers/workflow-lease.js";

/**
 * Stages backed by real SDK sessions over a faux model.
 *
 * Scenario `finished` (the default), `wait`: every stage (even ones with `ctx.stage`, odd ones with `ctx.task`) gets
 * the model's final answer, and its call never returns, as when the process stops after the turn and before the stage
 * records its completion; the test kills the process once every stage has its answer.
 *
 * Scenario `fork`, `wait`: a `source` stage finishes, then a `forked` stage starts from a fork of its session, which
 * ends on the source's answer. The forked stage's session is recorded, and its prompt never reaches the session: the
 * test kills the process there, before the forked stage's own turn exists.
 *
 * `resume`: the same run resumes from the journal. Every request the model receives is logged as `model <prompt>`;
 * the values the resumed workflow received are written to `resumed-results.json`.
 */
const [mode, directory, stageCountText, runIdArgument, scenarioArgument] = process.argv.slice(2);
assert.ok(mode === "wait" || mode === "resume");
assert.ok(directory);
assert.ok(runIdArgument);
const STAGES = Number(stageCountText ?? "4");
const runId = runIdArgument;
const scenario = scenarioArgument ?? "finished";
assert.ok(scenario === "finished" || scenario === "fork");
const sourceSessionFile = join(directory, "source-session.txt");
const effects = join(directory, "effects.txt");
const journalPath = join(directory, "journal.sqlite");
if (mode === "resume") expireWorkflowLease(journalPath, runId);
const backend = await JournalDurableBackend.open(await openSqlRunJournal(journalPath));
const sessionStore = await JsonlSessionStore.open(join(directory, "sessions"), {
	exactDirectory: true,
	scanExisting: false,
});

const faux = registerFauxProvider();
const model = faux.getModel();
/** The model answers each request with the text of its last user message, which it logs first. */
const answer = async (context: { readonly messages: readonly { role: string; content: unknown }[] }) => {
	const last = [...context.messages].reverse().find((message) => message.role === "user");
	const text =
		typeof last?.content === "string"
			? last.content
			: Array.isArray(last?.content)
				? last.content.map((part: { readonly text?: string }) => part.text ?? "").join("")
				: "";
	await appendFile(effects, `model ${text.split("\n")[0]}\n`);
	return fauxAssistantMessage(`answered ${text}`);
};
faux.setResponses(Array.from({ length: 4 * STAGES }, () => answer));
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
const sdkAdapter = createAgentSessionAdapter({
	cwd: directory,
	agentDir: join(directory, "agent"),
	model,
	modelRuntime,
	settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
	builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
	tools: [],
});

let finished = 0;
const results: Record<string, string> = {};
const definition = workflow({
	name: "finished-turn-restart",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		if (scenario === "fork") {
			const source = ctx.stage("source");
			results.source = await source.prompt("source task");
			// A replayed stage has no live session; the resumed run forks from the one the first process recorded.
			if (mode === "wait") await writeFile(sourceSessionFile, source.sessionId);
			const forkFromSessionId = await readFile(sourceSessionFile, "utf8");
			results.forked = await ctx.stage("forked", { context: "fork", forkFromSessionId }).prompt("forked task");
			return {};
		}
		await Promise.all(
			Array.from({ length: STAGES }, async (_, index) => {
				const name = `stage-${index}`;
				results[name] =
					index % 2 === 1
						? (await ctx.task(name, { prompt: `plan ${index}` })).text
						: await ctx.stage(name).prompt(`plan ${index}`);
			}),
		);
		return {};
	},
});

try {
	const result = await run(
		definition,
		{},
		{
			runId,
			cwd: directory,
			store: createStore(),
			durableBackend: backend,
			adapters: {
				sessionStore,
				agentSession: {
					async create(...args) {
						const created = await sdkAdapter.create(...args);
						if (mode !== "wait") return created;
						const session = "session" in created ? created.session : created;
						const prompt = session.prompt.bind(session);
						if (scenario === "fork") {
							if (args[1]?.stageName !== "forked") return created;
							session.prompt = async () => {
								await writeFile(join(directory, "fork-ready"), "ready");
								// The forked stage's session is recorded and its prompt never sent. The process is killed here.
								return new Promise<never>(() => {});
							};
							return created;
						}
						session.prompt = async (...promptArgs: Parameters<typeof session.prompt>) => {
							await prompt(...promptArgs);
							finished += 1;
							if (finished === STAGES) await writeFile(join(directory, "finished-ready"), "ready");
							// The answer is stored; the stage never records its completion. The process is killed here.
							return new Promise<never>(() => {});
						};
						return created;
					},
				},
			},
		},
	);
	assert.equal(result.status, "completed", JSON.stringify(result.error));
	await writeFile(join(directory, "resumed-results.json"), JSON.stringify(results));
} finally {
	await backend.close();
	await sessionStore.close();
}
