/**
 * A session that launched subagents and then ended, as every workflow stage does, must leave nothing behind that keeps
 * its history, extensions and tools alive. On a scripted model each parent launches two children in one `subagent`
 * call, as a stage splits its work; each child reads a file and answers. Two kinds of parent are measured:
 *
 * - workflow stages: a workflow run through the SDK runs its stages one after another, each a real stage session with
 *   the bundled subagents and Intercom extensions, and every stage's session is released when it completes;
 * - SDK sessions: real `createAgentSession` sessions, disposed once both children answered. The first also starts a
 *   process-wide service from one of its extension handlers, as a lazily started shared service does: the service's
 *   timer keeps the async context it started in for as long as the process runs.
 *
 * Once every parent has ended, the garbage collector must be able to reclaim every one of them.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@bastani/atomic-ai/compat";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { type CollectionCount, collectEverythingTracked, trackCollection } from "../helpers/collect-garbage.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Structural cost: real parent and child sessions with the bundled extensions loaded for each. */
const ENDED_SESSIONS_TIMEOUT_MS = 300_000;
const PROVIDER = "faux-ended-session-retention";
const PARENT_MODEL = "parent-retention";
const CHILD_MODEL = "child-retention";
/** Parents that launch children and end, as the stages of one workflow run do one after another. */
const PARENTS = 3;
const CHILDREN_PER_PARENT = 2;

let childrenAnswered = 0;

const respond: FauxResponseFactory = (context, _options, _state, model) => {
	const messages = context.messages;
	if (model.id === CHILD_MODEL) {
		if (!messages.some((message) => message.role === "toolResult"))
			return fauxAssistantMessage([fauxToolCall("read", { path: "fixture.txt" })], { stopReason: "toolUse" });
		childrenAnswered += 1;
		return fauxAssistantMessage("child done");
	}
	const last = messages.at(-1);
	if (last?.role === "user" && JSON.stringify(last.content).includes("DELEGATE"))
		return fauxAssistantMessage(
			[
				fauxToolCall("subagent", {
					tasks: Array.from({ length: CHILDREN_PER_PARENT }, (_, index) => ({
						agent: "worker-retention",
						task: `Read the fixture, part ${index}`,
					})),
					wait: { kind: "foreground" },
				}),
			],
			{ stopReason: "toolUse" },
		);
	return fauxAssistantMessage("parent done");
};

/** A service the first session to need it starts and every later session shares, until the process exits. */
let processWideService: ReturnType<typeof setInterval> | undefined;

function startsProcessWideService(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		processWideService ??= setInterval(() => {}, 3_600_000);
	});
}

let cwd: string;
let modelRuntime: ModelRuntime;
let unregister: (() => void) | undefined;
let parentModel: ReturnType<ReturnType<typeof registerFauxProvider>["getModel"]>;

function quietSettings(): SettingsManager {
	return SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		sessionSummary: { enabled: false },
	});
}

async function assertEveryParentCollected(collection: CollectionCount): Promise<void> {
	await collectEverythingTracked(collection);
	if (process.env.RETENTION_SNAPSHOT) (await import("node:v8")).writeHeapSnapshot(process.env.RETENTION_SNAPSHOT);
	assert.deepEqual(
		collection.uncollected(),
		[],
		`ended sessions or generations still reachable: ${collection.uncollected().length} of ${collection.created}`,
	);
}

beforeAll(async () => {
	vi.stubEnv("NODE_ENV", "production");
	vi.stubEnv("PI_CACHE_RETENTION", "none");
	cwd = makeTempDirectory("atomic-ended-session-retention-");
	mkdirSync(join(cwd, ".atomic", "agents"), { recursive: true });
	writeFileSync(join(cwd, "fixture.txt"), "x".repeat(32 * 1024));
	writeFileSync(
		join(cwd, ".atomic", "agents", "worker-retention.md"),
		`---\nname: worker-retention\ndescription: Reads a fixture and answers\ntools: read\nmodel: ${PROVIDER}/${CHILD_MODEL}\n---\n\nRead the fixture, then answer.\n`,
	);
	const faux = registerFauxProvider({ provider: PROVIDER, models: [{ id: PARENT_MODEL }, { id: CHILD_MODEL }] });
	unregister = () => faux.unregister();
	parentModel = faux.getModel(PARENT_MODEL);
	faux.setResponses(Array.from({ length: 1_000 }, () => respond));
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(PROVIDER, async () => ({ type: "api_key", key: "faux-key" }));
	modelRuntime = await ModelRuntime.create({
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
}, ENDED_SESSIONS_TIMEOUT_MS);

afterAll(() => {
	clearInterval(processWideService);
	unregister?.();
	clearSubagentControls();
	vi.unstubAllEnvs();
	if (cwd) removeTempDirectory(cwd);
});

describe("workflow stages that launched subagents and completed", () => {
	const stages = trackCollection();
	let status: string | undefined;

	beforeAll(async () => {
		const sdk = createAgentSessionAdapter({
			cwd,
			agentDir: join(cwd, "agent"),
			model: parentModel,
			modelRuntime,
			settingsManager: quietSettings(),
			builtins: { workflows: false, mcp: false, "web-access": false },
		});
		const definition = workflow({
			name: "ended-stage-retention",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				for (let stage = 0; stage < PARENTS; stage++)
					await ctx.task(`stage-${stage}`, { prompt: `DELEGATE the reading of part ${stage}` });
				return {};
			},
		});
		// Children a stage launched: one it stopped watching may still be running when the stage completes, and ends
		// with it, so the stages are measured by what they launched rather than by what answered.
		let childrenLaunched = 0;
		const countLaunches = (event: { type: string; toolName?: string; result?: unknown }) => {
			if (event.type !== "tool_execution_end" || event.toolName !== "subagent") return;
			const details = (event.result as { details?: { taskRecords?: readonly unknown[] } } | undefined)?.details;
			childrenLaunched += details?.taskRecords?.length ?? 0;
		};
		const result = await run(
			definition,
			{},
			{
				cwd,
				store: createStore(),
				journal: { memory: true },
				adapters: {
					sessionStore: new MemorySessionStore(),
					agentSession: {
						async create(...args: Parameters<typeof sdk.create>) {
							const created = await sdk.create(...args);
							const session = "session" in created ? created.session : created;
							stages.track(session);
							session.subscribe(countLaunches);
							return created;
						},
					},
				},
			},
		);
		status = result.status;
		assert.equal(childrenLaunched, PARENTS * CHILDREN_PER_PARENT, "every stage launched its children");
	}, ENDED_SESSIONS_TIMEOUT_MS);

	test(
		"every completed stage's session can be collected once its run ended",
		async () => {
			assert.equal(status, "completed");
			assert.equal(stages.created, PARENTS, "every stage ran in its own session");
			await assertEveryParentCollected(stages);
		},
		ENDED_SESSIONS_TIMEOUT_MS,
	);
});

describe("SDK sessions that launched subagents and were disposed", () => {
	const parents = trackCollection();

	async function runParentAndEnd(): Promise<void> {
		const settingsManager = quietSettings();
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager,
			extensionFactories: [startsProcessWideService],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			modelRuntime,
			model: parentModel,
			settingsManager,
			resourceLoader,
			builtins: { mcp: false, "web-access": false },
		});
		parents.track(session);
		const answeredBefore = childrenAnswered;
		await session.prompt("DELEGATE the reading");
		await vi.waitFor(
			() => {
				assert.equal(childrenAnswered - answeredBefore, CHILDREN_PER_PARENT, "both children answered");
				assert.equal(session.isStreaming, false);
			},
			{ timeout: 60_000, interval: 20 },
		);
		await session.dispose();
	}

	beforeAll(async () => {
		for (let parent = 0; parent < PARENTS; parent++) await runParentAndEnd();
	}, ENDED_SESSIONS_TIMEOUT_MS);

	test(
		"every disposed session can be collected, also the one that started a process-wide service",
		async () => {
			assert.ok(processWideService, "the first parent started the process-wide service");
			await assertEveryParentCollected(parents);
		},
		ENDED_SESSIONS_TIMEOUT_MS,
	);
});

describe("extension generations a session replaced with /reload", () => {
	/** Reloads of one session: each starts a new generation of every extension and retires the previous one. */
	const RELOADS = 4;
	const retired = trackCollection();
	let disposeSession: (() => Promise<void>) | undefined;

	beforeAll(async () => {
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			modelRuntime,
			model: parentModel,
			settingsManager: quietSettings(),
			builtins: { mcp: false, "web-access": false },
		});
		disposeSession = () => session.dispose();
		for (let reload = 0; reload < RELOADS; reload++) {
			retired.track(session.extensionRunner);
			await session.reload();
		}
	}, ENDED_SESSIONS_TIMEOUT_MS);

	afterAll(async () => {
		await disposeSession?.();
	});

	test(
		"every retired generation's extension runner can be collected while the session goes on",
		async () => {
			await assertEveryParentCollected(retired);
		},
		ENDED_SESSIONS_TIMEOUT_MS,
	);
});
