import assert from "node:assert/strict";
import { join } from "node:path";
import type { AgentSession, ResourceAdmission } from "@bastani/atomic";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { admittedSessionAdapter } from "../../packages/workflows/src/workers/admission-binding.js";
import { SqlResourceAdmission } from "../../packages/workflows/src/workers/resource-admission.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import {
	type AgentSessionAdapter,
	createStageContext,
	type InternalStageContext,
	makeMockSession,
	makeOpts,
	type StageExecutionMeta,
} from "./stage-runner-helpers.js";

const FALLBACK_COMPLETION_BUDGET_MS = 15_000;

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1000,
};

function response(
	model: { api: AssistantMessage["api"]; provider: string; id: string },
	failure?: string,
	stream = createAssistantMessageEventStream(),
): ReturnType<typeof createAssistantMessageEventStream> {
	const msg: AssistantMessage = {
		role: "assistant",
		content: failure === undefined ? [{ type: "text", text: "ok" }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: failure === undefined ? "stop" : "error",
		timestamp: Date.now(),
		...(failure === undefined ? {} : { errorMessage: failure }),
	};
	stream.push({ type: "start", partial: msg });
	if (failure === undefined) stream.push({ type: "done", reason: "stop", message: msg });
	else stream.push({ type: "error", reason: "error", error: msg });
	stream.end(msg);
	return stream;
}

async function fixture() {
	const directory = makeTempDirectory("admitted-fallback-");
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	const journal = await SqlRunJournal.open(database);
	const admission = await SqlResourceAdmission.open(journal, {
		root: "root",
		holder: "holder",
		limits: { session: 1 },
	});
	return {
		admission,
		journal,
		database,
		async close() {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

function granted(admission: SqlResourceAdmission) {
	return admission.inspect().then((rows) => rows.filter((row) => row.state === "granted").length);
}

function realSessionAdapter(
	onPrimaryCall: () => Promise<void>,
	sessions: AgentSession[],
	spareContexts: string[],
): AgentSessionAdapter {
	return {
		async create(options) {
			const modelRuntime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({
					limited: { type: "api_key", key: "x" },
					spare: { type: "api_key", key: "x" },
				}),
				modelsPath: null,
				refreshOnCreate: false,
			});
			modelRuntime.registerProvider("limited", {
				api: "openai-completions",
				baseUrl: "https://example.invalid",
				apiKey: "x",
				models: [spec],
				streamSimple: (model) => {
					const stream = createAssistantMessageEventStream();
					void onPrimaryCall().then(() => response(model, "429 rate limit exceeded", stream));
					return stream;
				},
			});
			modelRuntime.registerProvider("spare", {
				api: "openai-completions",
				baseUrl: "https://example.invalid",
				apiKey: "x",
				models: [spec],
				streamSimple: (model, context) => {
					spareContexts.push(JSON.stringify(context.messages.filter((message) => message.role === "user")));
					return response(model);
				},
			});
			const requested =
				typeof options.model === "string"
					? String(options.model).split("/")[0]!
					: (options.model?.provider ?? "limited");
			const { session } = await createAgentSession({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
				modelRuntime,
				model: modelRuntime.getModel(requested, "m")!,
				resourceAdmissionDelegated: false,
				resourceAdmission: options.resourceAdmission,
				resourceAdmissionSignal: options.resourceAdmissionSignal,
				settingsManager: SettingsManager.inMemory({
					retry: { enabled: false },
					compaction: { enabled: false },
				}),
				sessionManager: SessionManager.inMemory(),
				resourceLoader: createTestResourceLoader(),
			});
			sessions.push(session);
			return session as unknown as StageSessionRuntime;
		},
	};
}

test("a model fallback replaces a real session under a session cap of one without losing a pending delivery (#3869)", async () => {
	const f = await fixture();
	const sessions: AgentSession[] = [];
	const spareContexts: string[] = [];
	const primaryStarted = Promise.withResolvers<void>();
	const primaryMayFail = Promise.withResolvers<void>();
	let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
	const ctx = createStageContext(
		makeOpts({
			adapters: {
				agentSession: admittedSessionAdapter(
					realSessionAdapter(
						async () => {
							primaryStarted.resolve();
							await primaryMayFail.promise;
						},
						sessions,
						spareContexts,
					),
					f.admission,
				),
			},
			stageOptions: { model: "limited/m", fallbackModels: ["spare/m"] },
		}),
	) as InternalStageContext;
	try {
		const outcome = ctx.prompt("go");
		await primaryStarted.promise;
		await sessions[0]!.sendCustomMessage(
			{ customType: "note", content: "pending before fallback", display: false },
			{ deliverAs: "nextTurn" },
		);
		primaryMayFail.resolve();
		const result = await Promise.race([
			outcome.then(() => "completed"),
			new Promise<string>((resolve) => {
				fallbackTimer = setTimeout(() => resolve("deadlocked"), FALLBACK_COMPLETION_BUDGET_MS);
			}),
		]);
		assert.equal(result, "completed");
		assert.equal(sessions.length, 2, "the fallback created exactly one replacement session");
		assert.match(spareContexts.join("\n"), /pending before fallback/);
		assert.equal(await granted(f.admission), 1, "only the replacement session holds capacity");
		await ctx.__dispose();
		assert.equal(await granted(f.admission), 0, "capacity is released once every session is disposed");
	} finally {
		clearTimeout(fallbackTimer);
		primaryMayFail.resolve();
		await ctx.abort().catch(() => {});
		await ctx.__dispose().catch(() => {});
		await f.close();
	}
});

const makeMeta = (): StageExecutionMeta => ({ runId: "run", stageId: "stage", stageName: "stage" });

function countingAdmission() {
	const state = { acquired: 0, released: 0 };
	const admission: ResourceAdmission = {
		async acquire() {
			state.acquired++;
			return async () => {
				state.released++;
			};
		},
	};
	return { state, admission };
}

const acquiringAdapter: AgentSessionAdapter = {
	async create(options) {
		const release = await options.resourceAdmission!.acquire("session", options.resourceAdmissionSignal);
		return Object.assign(makeMockSession().session, { release });
	},
};

test("a replacement inherits capacity and frees it only after both cleanups are confirmed (#3869)", async () => {
	const { state, admission } = countingAdmission();
	const adapter = admittedSessionAdapter(acquiringAdapter, admission);
	const predecessor = (await adapter.create({}, undefined)) as StageSessionRuntime & { release: () => Promise<void> };
	const successor = (await adapter.create(
		{},
		{ ...makeMeta(), replacesSession: predecessor },
	)) as StageSessionRuntime & {
		release: () => Promise<void>;
	};
	assert.equal(state.acquired, 1, "the replacement does not wait for a second permit");

	await successor.release();
	assert.equal(state.released, 0, "the predecessor's cleanup is unconfirmed, so capacity stays held");

	await predecessor.release();
	await predecessor.release();
	assert.equal(state.released, 1);
});

test("a session that does not replace a predecessor acquires its own capacity (#3869)", async () => {
	const { state, admission } = countingAdmission();
	const adapter = admittedSessionAdapter(acquiringAdapter, admission);
	const first = await adapter.create({}, undefined);
	await adapter.create({}, makeMeta());
	await adapter.create({}, { ...makeMeta(), replacesSession: {} });
	assert.equal(state.acquired, 3);
	assert.ok(first);
});

test("a replacement acquires normally once its predecessor's capacity is already released (#3869)", async () => {
	const { state, admission } = countingAdmission();
	const adapter = admittedSessionAdapter(acquiringAdapter, admission);
	const predecessor = (await adapter.create({}, undefined)) as StageSessionRuntime & { release: () => Promise<void> };
	await predecessor.release();
	await adapter.create({}, { ...makeMeta(), replacesSession: predecessor });
	assert.equal(state.acquired, 2);
	assert.equal(state.released, 1);
});

test("a replacement is refused before sharing capacity when the root budget is exhausted (#3869)", async () => {
	const { state, admission } = countingAdmission();
	let exhausted = false;
	const adapter = admittedSessionAdapter(acquiringAdapter, admission, async () => {
		if (exhausted) throw new Error("Root workflow budget exhausted");
	});
	const predecessor = (await adapter.create({}, undefined)) as StageSessionRuntime & { release: () => Promise<void> };
	exhausted = true;
	await assert.rejects(adapter.create({}, { ...makeMeta(), replacesSession: predecessor }), /budget exhausted/);
	assert.equal(state.acquired, 1);

	await predecessor.release();
	assert.equal(state.released, 1, "the refused replacement leaves the predecessor as the only capacity owner");
});

test("a stale worker attempt cannot inherit a predecessor's capacity (#3869)", async () => {
	const f = await fixture();
	try {
		await f.journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
		const acquired = await f.journal.acquire("root", "coordinator");
		if (acquired.status !== "acquired") assert.fail("no lease");
		const pool = await openSqlPoolQueue(f.journal);
		await pool.initialize(acquired.lease, 60_000);
		const queued = poolWorkFixture();
		await pool.enqueue(acquired.lease, queued.work, queued.boundary);
		const work = await pool.claim(acquired.lease, "worker", [queued.work], 60_000);
		assert.ok(work);
		const admission = await SqlResourceAdmission.open(f.journal, {
			root: "root",
			holder: "worker",
			attempt: work,
			limits: { session: 1 },
		});
		const adapter = admittedSessionAdapter(acquiringAdapter, admission, (signal) => admission.validate(signal));
		const predecessor = (await adapter.create({}, undefined)) as StageSessionRuntime & {
			release: () => Promise<void>;
		};
		await f.database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", work.id);

		await assert.rejects(adapter.create({}, { ...makeMeta(), replacesSession: predecessor }), /Stale/);
		assert.equal((await admission.inspect()).filter((row) => row.state === "granted").length, 1);

		await predecessor.release();
		assert.equal((await admission.inspect()).filter((row) => row.state === "granted").length, 0);
	} finally {
		await f.close();
	}
});

test.each(["released", "aborted"] as const)(
	"replacement rechecks %s state after validating inherited capacity (#3869)",
	async (change) => {
		const { state, admission } = countingAdmission();
		const entered = Promise.withResolvers<void>();
		const validated = Promise.withResolvers<void>();
		const controller = new AbortController();
		const adapter = admittedSessionAdapter(acquiringAdapter, admission, async () => {
			entered.resolve();
			await validated.promise;
		});
		const predecessor = (await adapter.create({}, undefined)) as StageSessionRuntime & {
			release: () => Promise<void>;
		};
		const replacement = adapter.create(
			{},
			{
				...makeMeta(),
				replacesSession: predecessor,
				startupSignal: controller.signal,
			},
		);
		await entered.promise;
		if (change === "released") await predecessor.release();
		else controller.abort(new Error("replacement cancelled"));
		validated.resolve();
		if (change === "aborted") {
			await assert.rejects(replacement, /replacement cancelled/);
			assert.equal(state.acquired, 1);
			await predecessor.release();
		} else {
			const successor = (await replacement) as StageSessionRuntime & { release: () => Promise<void> };
			assert.equal(state.acquired, 2);
			await successor.release();
		}
		assert.equal(state.released, state.acquired);
	},
);
