import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { SessionWriteOptions } from "../../packages/coding-agent/src/core/storage/session/types.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { subagentChildRecordOf } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { type ChildSpec, SubagentControlRuntime } from "../../packages/subagents/src/runs/inprocess/runner.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

const agent: AgentConfig = {
	name: "worker",
	description: "worker",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/worker.md",
};

/** A store whose append of a change to `held` waits until the test lets it through. */
class HeldModelChangeStore extends MemorySessionStore {
	readonly appending = Promise.withResolvers<void>();
	readonly release = Promise.withResolvers<void>();
	readonly heldModel: string;
	constructor(heldModel: string) {
		super();
		this.heldModel = heldModel;
	}
	override async append(sessionId: string, entries: readonly SessionEntry[], options: SessionWriteOptions) {
		if (entries.some((entry) => entry.type === "model_change" && entry.modelId === this.heldModel)) {
			this.appending.resolve();
			await this.release.promise;
		}
		return super.append(sessionId, entries, options);
	}
}

function root(): string {
	const directory = mkdtempSync(join(tmpdir(), "atomic-launch-settings-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

/** A child's session that already records `model` at `level`, with one message, as a fork's copy of its parent has. */
async function sessionRecording(
	cwd: string,
	model: string,
	level: string,
	store = new MemorySessionStore(),
): Promise<SessionManager> {
	const session = await SessionManager.create(store, cwd);
	const [provider, id] = model.split("/") as [string, string];
	await session.appendModelChange(provider, id);
	await session.appendThinkingLevelChange(level);
	await session.appendMessage({ role: "user", content: "earlier context", timestamp: 1 });
	return session;
}

/** Run one attempt of a child on `session`, starting on `model` at `level`; resolves once it launched. */
async function launch(
	cwd: string,
	session: SessionManager,
	model: string,
	level: string,
	spec: Partial<ChildSpec> = {},
) {
	const control = new SubagentControlRuntime({ path: "settings-parent", depth: 0 }, join(cwd, "sessions"));
	const abort = new AbortController();
	const interrupt = new AbortController();
	control.registerAgents([agent]);
	const launched = Promise.withResolvers<{ leafSeq?: number }>();
	const gate = Promise.withResolvers<void>();
	cleanups.push(() => gate.resolve());
	const promptLog = join(cwd, "prompts.log");
	const admitted = (
		await control.admitChildSession(
			{
				taskName: "worker",
				task: "do the work",
				agent,
				cwd,
				sessionManager: session,
				onChildLaunch: (started) => launched.resolve(started),
				testSession: {
					output: "done",
					sessionModel: model,
					sessionThinkingLevel: level,
					promptGate: gate.promise,
					promptLogPath: promptLog,
				},
				...spec,
			},
			{ path: "settings-parent", depth: 0 },
		)
	).admitted;
	assert.ok(admitted);
	const running = control.startAttempt(admitted, {}, { abort: abort.signal, interrupt: interrupt.signal });
	return { running, launched: launched.promise, gate, promptLog, abort, interrupt };
}

/** What the child's saved session records last, read again from its store as a restart reads it. */
async function reopened(session: SessionManager) {
	const opened = await SessionManager.open(session.getSessionStore(), session.getSessionId(), undefined, {
		history: "tail",
	});
	const { model, thinkingLevel } = opened.getLatestBranchSettings();
	return {
		model: model && `${model.entry.provider}/${model.entry.modelId}`,
		thinkingLevel: thinkingLevel?.entry.thinkingLevel,
		seqs: [model?.seq, thinkingLevel?.seq],
		settings: opened
			.getEntries()
			.filter((entry) => entry.type === "model_change" || entry.type === "thinking_level_change").length,
	};
}

test("a forked child launched on another model and level records both in its own session before its first request", async () => {
	const cwd = root();
	const session = await sessionRecording(cwd, "anthropic/parent-model", "medium");
	const child = await launch(cwd, session, "openai/child-model", "high");

	const launched = await child.launched;
	// A restart now, before its first request is answered: its own session says what it runs on.
	const saved = await reopened(session);

	assert.equal(saved.model, "openai/child-model");
	assert.equal(saved.thinkingLevel, "high");
	assert.ok(
		saved.seqs.every((seq) => seq !== undefined && seq <= (launched.leafSeq ?? 0)),
		"recorded before the launch, so they are the launch's own settings, not changes after it",
	);
	child.gate.resolve();
	assert.equal((await child.running.promise).status, "ok");
});

test("a child is not prompted before its launch's model is recorded; a restart before that restores it as before", async () => {
	const cwd = root();
	const store = new HeldModelChangeStore("child-model");
	const session = await sessionRecording(cwd, "anthropic/parent-model", "medium", store);
	const child = await launch(cwd, session, "openai/child-model", "medium");

	await store.appending.promise;

	assert.equal(existsSync(child.promptLog), false, "nothing was sent while its model was not recorded");
	assert.equal(
		session.getLatestBranchSettings().model?.entry.modelId,
		"parent-model",
		"the store has not taken the change: a restart now finds the session as it was",
	);
	store.release.resolve();
	await child.launched;
	assert.equal((await reopened(session)).model, "openai/child-model");
	child.gate.resolve();
	assert.equal((await child.running.promise).status, "ok");
});

test("a child launched on the model and level its session records writes nothing", async () => {
	const cwd = root();
	const session = await sessionRecording(cwd, "openai/child-model", "high");
	const child = await launch(cwd, session, "openai/child-model", "high");

	await child.launched;

	assert.equal((await reopened(session)).settings, 2, "only the settings the session already had");
	child.gate.resolve();
	assert.equal((await child.running.promise).status, "ok");
});

test("a relaunch on a fallback model records the model, and a resumed session on another effort records the effort", async () => {
	for (const [model, level, expected] of [
		["openai/fallback-model", "medium", { model: "openai/fallback-model", thinkingLevel: "medium", added: 1 }],
		["anthropic/own-model", "xhigh", { model: "anthropic/own-model", thinkingLevel: "xhigh", added: 1 }],
	] as const) {
		const cwd = root();
		const session = await sessionRecording(cwd, "anthropic/own-model", "medium");
		const child = await launch(cwd, session, model, level, { resumeSession: true });

		await child.launched;
		const saved = await reopened(session);

		assert.deepEqual({ model: saved.model, thinkingLevel: saved.thinkingLevel, added: saved.settings - 2 }, expected);
		child.gate.resolve();
		assert.equal((await child.running.promise).status, "ok");
	}
});

test("a stop while a launch's model is being recorded stops the child at once, with nothing sent", async () => {
	const cwd = root();
	const store = new HeldModelChangeStore("child-model");
	const session = await sessionRecording(cwd, "anthropic/parent-model", "medium", store);
	const child = await launch(cwd, session, "openai/child-model", "medium");
	await store.appending.promise;

	// The store never answers; the user stops the child.
	child.interrupt.abort();
	const ended = await child.running.promise;

	assert.equal(ended.status, "interrupted");
	assert.equal(existsSync(child.promptLog), false);
	store.release.resolve();
});

test("an attempt that recorded its launch's model leaves nothing listening on signals that outlive it", async () => {
	const cwd = root();
	const session = await sessionRecording(cwd, "anthropic/parent-model", "medium");
	const child = await launch(cwd, session, "openai/child-model", "high");
	await child.launched;
	child.gate.resolve();

	assert.equal((await child.running.promise).status, "ok");
	assert.deepEqual(
		[
			getEventListeners(child.abort.signal, "abort").length,
			getEventListeners(child.interrupt.signal, "abort").length,
		],
		[0, 0],
	);
});

test("a later launch that does not know its leaf's position or level keeps none of an earlier launch's in the record", async () => {
	const owner = SessionManager.inMemory("/repo");
	const ctx = { sessionManager: owner } as unknown as ExtensionContext;
	const sink = createSubagentChildRecordSink(
		{ appendEntry: async (type, data) => void (await owner.appendCustomEntry(type, data)) },
		ctx,
	);
	const child = { runId: "relaunched", index: 0, agent: "worker", state: "running" as const, cwd: "/repo" };
	sink.record({
		...child,
		childSessionId: "first-session",
		launchModel: "anthropic/first-model",
		launchThinkingLevel: "high",
		launchLeafId: "first-leaf",
		launchLeafSeq: 20,
	});
	// A later launch, through a session that cannot tell its entries' positions, on a model with no thinking level.
	sink.record({
		...child,
		childSessionId: "second-session",
		launchModel: "openai/second-model",
		launchLeafId: "second-leaf",
	});
	await sink.flushed?.();

	const launchOf = (record: Record<string, unknown> | undefined) => ({
		model: record?.launchModel,
		thinkingLevel: record?.launchThinkingLevel,
		leafId: record?.launchLeafId,
		leafSeq: record?.launchLeafSeq,
	});
	const expected = {
		model: "openai/second-model",
		thinkingLevel: undefined,
		leafId: "second-leaf",
		leafSeq: undefined,
	};
	assert.deepEqual(
		launchOf({ ...subagentChildRecordOf(owner.getSessionId(), "relaunched:0") }),
		expected,
		"in memory",
	);
	assert.deepEqual(
		launchOf({ ...readSubagentChildRecords(owner.getEntries()).get("relaunched:0") }),
		expected,
		"saved",
	);
});
