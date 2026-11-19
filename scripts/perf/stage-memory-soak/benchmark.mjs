#!/usr/bin/env node
/**
 * Host memory soak: what a long-running host keeps of the workflow stages and subagents it has finished.
 *
 * One workflow runs `--stages` stages in `--lanes` parallel lanes through the SDK, as the interactive host runs them:
 * every stage is a real `AgentSession` with the bundled subagents and Intercom extensions, over a scripted model. Each
 * stage reads a large file `--reads` times, launches `--children` subagents in one `subagent` call (each child reads
 * the file and answers), waits for each of them with `subagent({ action: "wait" })`, and answers with a few kilobytes
 * of text. Sessions and the run journal live in SQLite files, as by default. The report counts the children's model
 * calls, so a soak that stopped exercising subagents shows it.
 *
 * Every `--sample-every` finished stages the lanes stop starting stages until every stage in flight has finished; the
 * process is then collected and sampled: heap in use, RSS, and how many finished stage sessions are still reachable.
 * The report fits the heap retained per finished stage between the first and the last sample. With
 * `SOAK_SNAPSHOT_DIR` set, a heap snapshot is written at every sample, to diff by retainer.
 *
 * It runs on the built package, as an npm install does: `npm run build` first.
 *
 *   node --expose-gc scripts/perf/stage-memory-soak/benchmark.mjs --stages 120 --lanes 6 --label after --out after.json
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		stages: { type: "string", default: "120" },
		lanes: { type: "string", default: "6" },
		reads: { type: "string", default: "6" },
		children: { type: "string", default: "2" },
		"sample-every": { type: "string", default: "20" },
		label: { type: "string", default: "soak" },
		out: { type: "string" },
	},
	strict: true,
});
const STAGES = Number(values.stages);
const LANES = Number(values.lanes);
const READS = Number(values.reads);
const CHILDREN = Number(values.children);
const SAMPLE_EVERY = Number(values["sample-every"]);
/** Lines of the file every stage and child reads: about 200 KB, so a stage's history is about a megabyte. */
const FILE_LINES = 2_500;
const ANSWER_BYTES = 4_096;
const PROVIDER = "faux-stage-memory-soak";
const STAGE_MODEL = "stage-soak";
const CHILD_MODEL = "child-soak";
/** How long a stage waits for one child: the scripted children answer at once, so only a stuck one reaches it. */
const CHILD_WAIT_BUDGET_MS = 600_000;

const collect = globalThis.gc;
if (typeof collect !== "function") throw new Error("run with node --expose-gc");

const root = mkdtempSync(join(tmpdir(), "atomic-stage-memory-soak-"));
const cwd = join(root, "project");
const agentDir = join(root, "agent");
mkdirSync(join(cwd, ".atomic", "agents"), { recursive: true });
mkdirSync(agentDir, { recursive: true });
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
process.env.ATOMIC_OFFLINE = "1";
// The scripted provider would otherwise keep every session's last prompt as its simulated prompt cache.
process.env.PI_CACHE_RETENTION = "none";
writeFileSync(
	join(cwd, "big.ts"),
	Array.from(
		{ length: FILE_LINES },
		(_, line) => `export const value${line} = ${line} * 7919; // ${"x".repeat(48)}`,
	).join("\n"),
);
writeFileSync(
	join(cwd, ".atomic", "agents", "soak-worker.md"),
	`---\nname: soak-worker\ndescription: Reads a file and answers\ntools: read\nmodel: ${PROVIDER}/${CHILD_MODEL}\n---\n\nRead the file, then answer.\n`,
);

const { AuthStorage, ModelRuntime, resolveSessionStore, SettingsManager } = await import("@bastani/atomic");
const { createAgentSessionAdapter, createStore, run, workflow } = await import("@bastani/atomic/workflows");
const { fauxAssistantMessage, fauxToolCall, registerFauxProvider } = await import("@bastani/atomic-ai/compat");

const answer = (seed) => `${seed} `.repeat(Math.ceil(ANSWER_BYTES / (seed.length + 1))).slice(0, ANSWER_BYTES);
const resultText = (message) => message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
let childCalls = 0;

function respond(context, _options, _state, model) {
	const messages = context.messages;
	const toolResults = messages.filter((message) => message.role === "toolResult").length;
	if (model.id === CHILD_MODEL) {
		childCalls += 1;
		if (toolResults === 0)
			return fauxAssistantMessage([fauxToolCall("read", { path: "big.ts" })], { stopReason: "toolUse" });
		return fauxAssistantMessage(answer("child"));
	}
	if (toolResults < READS)
		return fauxAssistantMessage(
			[fauxToolCall("read", { path: "big.ts", offset: 1 + ((toolResults * 397) % (FILE_LINES - 600)), limit: 600 })],
			{ stopReason: "toolUse" },
		);
	if (toolResults === READS && CHILDREN > 0)
		return fauxAssistantMessage(
			[
				fauxToolCall("subagent", {
					tasks: Array.from({ length: CHILDREN }, (_, index) => ({
						agent: "soak-worker",
						task: `Read part ${index}`,
					})),
				}),
			],
			{ stopReason: "toolUse" },
		);
	// The launch returns once its children are admitted: wait for each one before answering.
	if (toolResults === READS + 1 && CHILDREN > 0) {
		const launch = resultText(messages.filter((message) => message.role === "toolResult").at(-1));
		const taskIds = [...new Set([...launch.matchAll(/"taskId":"([^"]+)"/g)].map((match) => match[1]))];
		if (taskIds.length > 0)
			return fauxAssistantMessage(
				taskIds.map((id) => fauxToolCall("subagent", { action: "wait", id, budgetMs: CHILD_WAIT_BUDGET_MS })),
				{ stopReason: "toolUse" },
			);
	}
	return fauxAssistantMessage(answer("stage"));
}

const faux = registerFauxProvider({ provider: PROVIDER, models: [{ id: STAGE_MODEL }, { id: CHILD_MODEL }] });
faux.setResponses(Array.from({ length: STAGES * (READS + CHILDREN * 2 + 5) + 1_000 }, () => respond));
const authStorage = AuthStorage.inMemory();
await authStorage.modify(PROVIDER, async () => ({ type: "api_key", key: "faux-key" }));
const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
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

const sessionStore = await resolveSessionStore(cwd, { agentDir, settings: {} });
const sdk = createAgentSessionAdapter({
	cwd,
	agentDir,
	model: faux.getModel(STAGE_MODEL),
	modelRuntime,
	settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
	builtins: { workflows: false, mcp: false, "web-access": false },
});

let created = 0;
let collected = 0;
const stageSessions = new FinalizationRegistry(() => {
	collected += 1;
});

let finished = 0;
let inFlight = 0;
let nextSample = SAMPLE_EVERY;
let sampling;
const samples = [];

async function settle() {
	for (let round = 0; round < 20; round++) {
		collect();
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function sample() {
	await settle();
	const memory = process.memoryUsage();
	const point = {
		stages: finished,
		heapUsedMB: +(memory.heapUsed / 2 ** 20).toFixed(1),
		heapTotalMB: +(memory.heapTotal / 2 ** 20).toFixed(1),
		rssMB: +(memory.rss / 2 ** 20).toFixed(1),
		externalMB: +(memory.external / 2 ** 20).toFixed(1),
		reachableStageSessions: created - collected,
	};
	samples.push(point);
	console.error(JSON.stringify(point));
	if (process.env.SOAK_SNAPSHOT_DIR)
		(await import("node:v8")).writeHeapSnapshot(
			join(process.env.SOAK_SNAPSHOT_DIR, `stages-${finished}.heapsnapshot`),
		);
}

/** Holds a lane before its next stage while a sample is due, and samples once no stage is in flight. */
async function beforeStage() {
	while (finished + inFlight >= nextSample) {
		if (inFlight > 0) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			continue;
		}
		sampling ??= sample().finally(() => {
			nextSample += SAMPLE_EVERY;
			sampling = undefined;
		});
		await sampling;
	}
	inFlight += 1;
}

const definition = workflow({
	name: "stage-memory-soak",
	description: "Stages that read and delegate to subagents, in parallel lanes.",
	inputs: {},
	outputs: {},
	async run(ctx) {
		let next = 0;
		const lane = async () => {
			while (next < STAGES) {
				const stage = next++;
				await beforeStage();
				await ctx.task(`stage-${stage}`, { prompt: `Stage ${stage}: read the file and delegate.` });
				inFlight -= 1;
				finished += 1;
			}
		};
		await Promise.all(Array.from({ length: LANES }, lane));
		return {};
	},
});

const started = performance.now();
const result = await run(
	definition,
	{},
	{
		cwd,
		store: createStore(),
		journal: { path: join(root, "journal.sqlite") },
		adapters: {
			sessionStore,
			agentSession: {
				async create(...args) {
					const session = await sdk.create(...args);
					created += 1;
					stageSessions.register("session" in session ? session.session : session, created);
					return session;
				},
			},
		},
	},
);
await sample();
const first = samples[0];
const last = samples.at(-1);
const report = {
	label: values.label,
	node: process.version,
	platform: process.platform,
	status: result.status,
	stages: STAGES,
	lanes: LANES,
	reads: READS,
	children: CHILDREN,
	childCalls,
	seconds: +((performance.now() - started) / 1000).toFixed(1),
	retainedKBPerStage: +(
		((last.heapUsedMB - first.heapUsedMB) * 1024) /
		Math.max(1, last.stages - first.stages)
	).toFixed(1),
	samples,
};
const text = JSON.stringify(report, null, 2);
if (values.out) writeFileSync(values.out, `${text}\n`);
console.log(text);
faux.unregister();
await sessionStore.close();
try {
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
} catch (error) {
	// Windows keeps a database the process still has open, such as the Intercom broker's, until the process exits.
	console.error(`left ${root}: ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(result.status === "completed" ? 0 : 1);
