import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableHash } from "../../packages/workflows/src/durable/durable-hash.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	ForkClaimReleaseError,
	ForkConfigError,
	ForkCopyFailedError,
	ForkDefinitionMismatchError,
	ForkSessionNotFoundError,
	ForkSourceBusyError,
	ForkSourceNotFoundError,
	isForkClaimReleaseError,
} from "../../packages/workflows/src/durable/fork-errors.js";
import {
	durableForkPoints,
	forkDurableRun,
	validateForkOptions,
} from "../../packages/workflows/src/durable/fork-run.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import type { JournalEntry } from "../../packages/workflows/src/durable/journal/types.js";
import { isDurableWorkflowResumable } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { prepareTargetedDurableResumable } from "../../packages/workflows/src/durable/resume-runtime.js";
import { RUN_RESULT_CHECKPOINT_NAME } from "../../packages/workflows/src/durable/run-result.js";
import type { DurableCheckpoint, DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import type { PendingStageMessage } from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";

afterEach(async () => {
	setDurableBackend(undefined);
	vi.restoreAllMocks();
	await closeMemoryTestBackends();
});

const definition = workflow({ name: "copy-source", description: "", inputs: {}, outputs: {}, run: async () => ({}) });
const request = (runId: string) => ({ source: "sdk" as const, runId, carryMessages: "before" as const, definition });

function stage(
	runId: string,
	checkpointId: string,
	name: string,
	replayKey: string,
	extra: Partial<DurableStageCheckpoint> = {},
): DurableStageCheckpoint {
	return { kind: "stage", workflowId: runId, checkpointId, name, replayKey, completedAt: 1, ...extra };
}

async function register(backend: MemoryJournalBackend, runId: string, extra: object = {}) {
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: definition.name,
		inputs: {},
		status: "paused",
		createdAt: 1,
		invocationCwd: "/source",
		...extra,
	});
}

async function commit(backend: MemoryJournalBackend, checkpoints: readonly DurableCheckpoint[]) {
	for (const checkpoint of checkpoints) await backend.commitCheckpoint(checkpoint);
}

async function events(backend: MemoryJournalBackend, runId: string): Promise<JournalEntry[]> {
	const entries: JournalEntry[] = [];
	for await (const entry of backend.journal.read(runId)) entries.push(entry);
	return entries;
}

test("a fork from a stage copies the checkpoints before it under new run ids and drops unfinished work (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const planSession = await SessionManager.create(sessions, "/source");
	await planSession.appendMessage({ role: "user", content: "plan", timestamp: 1 });
	const sourceId = testRunId("copy-cut");
	const childId = testRunId("copy-cut-child");
	const boundaryKey = "workflow:impl:fp:1";
	await register(backend, sourceId);
	await commit(backend, [
		{
			kind: "tool",
			workflowId: sourceId,
			checkpointId: "tool:a",
			name: "a",
			argsHash: "a",
			output: "A",
			completedAt: 1,
			topology: {
				version: 1,
				nodeId: "tool:a",
				ordinal: 1,
				order: 0,
				parentIds: [],
				run: { runId: sourceId, runName: "root", rootRunId: sourceId },
			},
		},
		{
			kind: "tool",
			workflowId: sourceId,
			checkpointId: "tool:untopologized",
			name: "b",
			argsHash: "b",
			output: "B",
			completedAt: 1,
		},
		{
			kind: "tool",
			workflowId: sourceId,
			checkpointId: "run-result:1",
			name: RUN_RESULT_CHECKPOINT_NAME,
			argsHash: RUN_RESULT_CHECKPOINT_NAME,
			output: { result: {} },
			completedAt: 1,
		},
		stage(sourceId, "stage-session:plan", "plan", "stage:plan:1", {
			sessionId: planSession.getSessionId(),
			sessionFile: "/old/plan.jsonl",
		}),
		stage(sourceId, "stage:plan", "plan", "stage:plan:1", {
			output: "planned",
			sessionId: planSession.getSessionId(),
			sessionFile: "/old/plan.jsonl",
			topology: {
				version: 1,
				stageId: "plan-id",
				parentIds: [],
				intercomGroup: "workflow:x",
				run: { runId: sourceId, runName: "root" },
			},
		}),
		stage(sourceId, "stage-session:half", "half", "stage:half:1", { sessionId: "unfinished-session" }),
		stage(sourceId, `boundary-start:${boundaryKey}`, "impl", boundaryKey, {
			topology: {
				version: 1,
				stageId: "impl-id",
				parentIds: [],
				run: { runId: sourceId, runName: "root" },
				boundary: {
					version: 1,
					event: "start",
					status: "running",
					replayScope: boundaryKey,
					alias: "impl",
					workflow: "impl",
					invocationFingerprint: "fp",
					child: {
						runId: childId,
						runName: "impl",
						parentRunId: sourceId,
						parentStageId: "impl-id",
						rootRunId: sourceId,
					},
				},
			},
		}),
		stage(sourceId, `${boundaryKey}:stage:review`, "review", `${boundaryKey}:stage:review:1`, {
			output: "reviewed",
			topology: {
				version: 1,
				stageId: "review-id",
				parentIds: [],
				run: { runId: childId, runName: "impl", parentRunId: sourceId, rootRunId: sourceId },
			},
		}),
		stage(sourceId, "stage-session:deploy", "deploy", "stage:deploy:1", { sessionId: "deploy-session" }),
		stage(sourceId, "stage:deploy", "deploy", "stage:deploy:1", { output: "deployed" }),
		stage(sourceId, "stage:after", "after", "stage:after:1", { output: "after" }),
	]);
	const points = [];
	for await (const point of durableForkPoints(backend, sourceId, { sourceSessionStore: sessions }))
		points.push(point.stagePath);
	assert.deepEqual(points, ["plan", "impl.review", "deploy", "after"]);
	const fork = await forkDurableRun(backend, {
		...request(sourceId),
		fromStage: "deploy",
		cwd: "/target",
		sessionStore: sessions,
		sourceSessionStore: sessions,
	});
	assert.deepEqual(fork.forkedFrom, { runId: sourceId, stagePath: "deploy" });
	assert.equal(fork.cwd, "/target");
	const copied = backend.listCheckpoints(fork.runId);
	assert.deepEqual(
		copied.map((checkpoint) => checkpoint.checkpointId),
		[
			"tool:a",
			"tool:untopologized",
			"stage-session:plan",
			"stage:plan",
			`boundary-start:${boundaryKey}`,
			`${boundaryKey}:stage:review`,
		],
	);
	for (const checkpoint of copied) assert.equal(checkpoint.workflowId, fork.runId);
	const [tool, untopologized, , plan, boundary, review] = copied;
	assert.ok(tool?.kind === "tool" && tool.topology?.run !== undefined);
	assert.deepEqual(tool.topology.run, { runId: fork.runId, runName: "root", rootRunId: fork.runId });
	assert.ok(untopologized?.kind === "tool");
	assert.equal(untopologized.topology, undefined);
	assert.ok(plan?.kind === "stage");
	assert.notEqual(plan.sessionId, planSession.getSessionId());
	assert.equal(plan.sessionFile, undefined, "a copied memory session has no file");
	assert.equal(plan.topology?.intercomGroup, undefined);
	assert.deepEqual(plan.topology?.run, { runId: fork.runId, runName: "root" });
	const copiedSession = await sessions.load(plan.sessionId!);
	assert.equal(copiedSession.header.parentSessionId, planSession.getSessionId());
	assert.deepEqual(copiedSession.header.workflow, { runId: fork.runId, stageId: "plan-id", stageName: "plan" });
	assert.equal(copiedSession.header.internal, true);
	assert.equal(copiedSession.header.cwd, "/target");
	assert.ok(boundary?.kind === "stage" && boundary.topology?.boundary !== undefined);
	const child = boundary.topology.boundary.child;
	assert.notEqual(child.runId, childId);
	assert.deepEqual([child.parentRunId, child.rootRunId, child.parentStageId], [fork.runId, fork.runId, "impl-id"]);
	assert.ok(review?.kind === "stage");
	assert.deepEqual(review.topology?.run, {
		runId: child.runId,
		runName: "impl",
		parentRunId: fork.runId,
		rootRunId: fork.runId,
	});
	const seed = await events(backend, fork.runId);
	assert.deepEqual(
		seed.map((entry) => entry.event.type),
		["RunStarted", ...copied.map(() => "CheckpointRecorded"), "StatusChanged"],
	);
	assert.deepEqual(
		seed.slice(1, -1).map((entry) => entry.key),
		copied.map((checkpoint) => JSON.stringify(["CheckpointRecorded", checkpoint.kind, checkpoint.checkpointId])),
	);
	assert.equal((seed.at(-1)!.event.payload as { completedCheckpoints: number }).completedCheckpoints, copied.length);
	const whole = await forkDurableRun(backend, {
		...request(sourceId),
		cwd: "/target",
		sessionStore: sessions,
		sourceSessionStore: sessions,
	}).catch((error: Error) => error);
	assert.ok(whole instanceof ForkSessionNotFoundError, "a whole-run fork also copies the unfinished sessions");
	assert.deepEqual([whole.sessionId, whole.runId], ["unfinished-session", sourceId]);
});

test("a fork re-keys prompt answers to its own root and copies other answers as they are (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("copy-ui");
	await register(backend, sourceId);
	const identity = (scope: string, root = sourceId) => ({
		rootWorkflowId: root,
		scope,
		authorCallsite: "h1",
		descriptor: { kind: "input", message: "Name?", details: null },
	});
	const answer = (checkpointId: string, promptHash: string, message: string): DurableCheckpoint => ({
		kind: "ui",
		workflowId: sourceId,
		checkpointId,
		promptKind: "input",
		message,
		promptHash,
		response: "Ada",
		completedAt: 1,
	});
	const rootHash = durableHash(identity("root"));
	const scopedHash = durableHash(identity("workflow:child:fp:1"));
	const foreignHash = durableHash(identity("root", "other-run"));
	await commit(backend, [
		answer(`ui:${rootHash}`, rootHash, JSON.stringify(identity("root"))),
		answer(
			`workflow:child:fp:1:ui:${scopedHash}`,
			`workflow:child:fp:1:${scopedHash}`,
			JSON.stringify(identity("workflow:child:fp:1")),
		),
		answer("ui:legacy", "legacy", "What is your name?"),
		answer(`ui:${foreignHash}`, foreignHash, JSON.stringify(identity("root", "other-run"))),
		answer("ui:mismatched", "mismatched", JSON.stringify(identity("root"))),
		answer("ui:array", "array", "[1,2]"),
		answer("ui:null", "null", "null"),
		answer(`ui:${rootHash}:other`, rootHash, JSON.stringify(identity("root"))),
		answer(`x:ui:${rootHash}`, "other", JSON.stringify(identity("root"))),
	]);
	const fork = await forkDurableRun(backend, request(sourceId));
	const [root, scoped, legacy, foreign, mismatched, array, nothing, hashOnly, idOnly] = backend.listCheckpoints(
		fork.runId,
	);
	const forkHash = durableHash(identity("root", fork.runId));
	const forkScopedHash = durableHash(identity("workflow:child:fp:1", fork.runId));
	assert.ok(root?.kind === "ui");
	assert.deepEqual(
		[root.checkpointId, root.promptHash, JSON.parse(root.message)],
		[`ui:${forkHash}`, forkHash, identity("root", fork.runId)],
	);
	assert.equal(backend.getUiResponse(fork.runId, forkHash), "Ada");
	assert.ok(scoped?.kind === "ui");
	assert.deepEqual(
		[scoped.checkpointId, scoped.promptHash],
		[`workflow:child:fp:1:ui:${forkScopedHash}`, `workflow:child:fp:1:${forkScopedHash}`],
	);
	for (const [copy, original, checkpointId] of [
		[legacy, "legacy", "ui:legacy"],
		[foreign, foreignHash, `ui:${foreignHash}`],
		[mismatched, "mismatched", "ui:mismatched"],
		[array, "array", "ui:array"],
		[nothing, "null", "ui:null"],
		[hashOnly, rootHash, `ui:${rootHash}:other`],
		[idOnly, "other", `x:ui:${rootHash}`],
	] as const) {
		assert.ok(copy?.kind === "ui");
		assert.equal(copy.promptHash, original);
		assert.equal(copy.checkpointId, checkpointId);
		assert.equal(copy.workflowId, fork.runId);
	}
});

function pending(runId: string, id: string, stage: string): PendingStageMessage {
	return {
		id,
		runId,
		stageKey: `workflow:${runId}/${stage}`,
		targetPath: `workflow:${runId}/${stage}`,
		from: { id: "sender", name: "sender" },
		message: { id: `${id}-message`, timestamp: 1, content: { text: id } },
		queuedAt: new Date(1).toISOString(),
		admissionOrder: 1,
		status: "queued",
		deliveries: [
			{ runId, stageId: "stage-id", sessionId: "delivered-session", deliveredAt: new Date(2).toISOString() },
		],
	} as PendingStageMessage;
}

test("carryMessages decides whether Intercom messages and receipts after the fork point are carried (#4321)", async () => {
	for (const carryMessages of ["before", "all"] as const) {
		const backend = await createMemoryTestBackend();
		const sourceId = testRunId(`copy-messages-${carryMessages}`);
		await register(backend, sourceId);
		const early = pending(sourceId, "early", "review");
		const late = pending(sourceId, "late", "ship");
		await backend.persistPendingStageMessages(sourceId, [early]);
		await backend.archivePendingStageMessage(sourceId, { ...early, status: "delivered" });
		await backend.archivePendingStageDeliveryReceipt(sourceId, "early", early.deliveries![0]!, {
			messageRunId: sourceId,
			deliveryCount: 1,
		});
		await commit(backend, [
			stage(sourceId, "stage:plan", "plan", "stage:plan:1", { output: "planned" }),
			stage(sourceId, "stage:review", "review", "stage:review:1", { output: "reviewed" }),
		]);
		await backend.persistPendingStageMessages(sourceId, [early, late]);
		await backend.archivePendingStageMessage(sourceId, { ...late, status: "delivered" });
		await backend.archivePendingStageDeliveryReceipt(sourceId, "late", {
			runId: sourceId,
			stageId: "ship-id",
			deliveredAt: new Date(3).toISOString(),
		});
		const fork = await forkDurableRun(backend, { ...request(sourceId), fromStage: "review", carryMessages });
		const carried = backend.getWorkflow(fork.runId)!.pendingStageMessages ?? [];
		assert.deepEqual(
			carried.map((message) => message.id),
			carryMessages === "all" ? ["early", "late"] : ["early"],
		);
		for (const message of carried) {
			assert.equal(message.runId, fork.runId);
			assert.ok(message.stageKey.startsWith(`workflow:${fork.runId}/`));
			assert.ok(message.targetPath?.startsWith(`workflow:${fork.runId}/`));
			assert.equal(message.deliveries?.[0]?.runId, fork.runId);
			assert.equal(message.deliveries?.[0]?.sessionId, "delivered-session");
		}
		assert.equal((await backend.readSettledPendingStageMessage(fork.runId, "early", fork.runId))?.runId, fork.runId);
		assert.equal(
			(await backend.readSettledPendingStageMessage(fork.runId, "late", fork.runId)) !== undefined,
			carryMessages === "all",
		);
		assert.equal(
			await backend.hasPendingStageDeliveryReceipt(
				fork.runId,
				"early",
				{ runId: fork.runId, stageId: "stage-id", sessionId: "delivered-session" },
				fork.runId,
			),
			true,
		);
		assert.equal(backend.getPendingStageMessageDeliveryCount(fork.runId, "early", fork.runId), 1);
		assert.equal(
			await backend.hasPendingStageDeliveryReceipt(
				fork.runId,
				"late",
				{ runId: fork.runId, stageId: "ship-id" },
				fork.runId,
			),
			carryMessages === "all",
		);
		const keys = (await events(backend, fork.runId))
			.filter((entry) => entry.event.type === "MessageSettled")
			.map((entry) => entry.key);
		assert.ok(
			keys.every((key) => key?.includes(fork.runId) && !key.includes(sourceId)),
			JSON.stringify(keys),
		);
	}
});

test("the fork's handle keeps lineage and bindings, clears ownership and failure, and keeps paths only in the same directory (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("copy-handle");
	await register(backend, sourceId, {
		status: "failed",
		error: "boom",
		failureKind: "workflow",
		exited: true,
		exitReason: "stopped",
		label: "Saved objective",
		modelOwner: "owner-a",
		workflowCwd: "/source/worktree",
		repositoryRoot: "/source",
		gitWorktreeRoot: "/source/worktree",
		summary: "Halfway there",
		summarizedThrough: 2,
		possibleStages: ["plan", "ship"],
	});
	await commit(backend, [
		stage(sourceId, "stage:plan", "plan", "stage:plan:1", { output: "planned" }),
		stage(sourceId, "stage:ship", "ship", "stage:ship:1", { output: "shipped" }),
	]);
	const sameDirectory = await forkDurableRun(backend, { ...request(sourceId), cwd: "/source", modelOwner: "owner-b" });
	const same = backend.getWorkflow(sameDirectory.runId)!;
	assert.deepEqual(
		[same.workflowCwd, same.repositoryRoot, same.gitWorktreeRoot, same.invocationCwd],
		["/source/worktree", "/source", "/source/worktree", "/source"],
	);
	assert.deepEqual(
		[same.status, same.resumable, same.pendingPrompts, same.modelOwner],
		["paused", true, 0, "owner-b"],
	);
	assert.deepEqual(
		[same.error, same.failureKind, same.exited, same.exitReason],
		[undefined, undefined, undefined, undefined],
	);
	assert.deepEqual(
		[same.label, same.summary, same.summarizedThrough, same.possibleStages],
		["Saved objective", "Halfway there", 2, ["plan", "ship"]],
	);
	assert.deepEqual(same.forkedFrom, { runId: sourceId });
	assert.equal(same.rootWorkflowId, undefined);
	const elsewhere = await forkDurableRun(backend, { ...request(sourceId), cwd: "/elsewhere", fromStage: "ship" });
	const other = backend.getWorkflow(elsewhere.runId)!;
	assert.deepEqual(
		[other.workflowCwd, other.repositoryRoot, other.gitWorktreeRoot, other.invocationCwd],
		[undefined, undefined, undefined, "/elsewhere"],
	);
	assert.deepEqual(
		[other.summary, other.modelOwner],
		[undefined, undefined],
		"a fork from a stage drops the later summary",
	);
	const unbound = testRunId("copy-handle-unbound");
	await register(backend, unbound, { invocationCwd: undefined });
	await commit(backend, [stage(unbound, "stage:plan", "plan", "stage:plan:1", { output: "planned" })]);
	const defaulted = await forkDurableRun(backend, request(unbound));
	assert.equal(defaulted.cwd, process.cwd());
	const relative = await forkDurableRun(backend, { ...request(unbound), cwd: "relative/dir" });
	assert.equal(relative.cwd, join(process.cwd(), "relative/dir"));
});

test("validateForkOptions accepts valid options and names each invalid one (#4321)", () => {
	const directory = mkdtempSync(join(tmpdir(), "fork-options-"));
	const file = join(directory, "file.txt");
	writeFileSync(file, "x");
	try {
		const runId = testRunId("options");
		validateForkOptions("sdk", runId, {});
		validateForkOptions("sdk", runId, {
			fromStage: "a.b",
			inputs: {},
			cwd: directory,
			carryMessages: "all",
			definition,
			signal: new AbortController().signal,
		});
		validateForkOptions("cli", runId, { carryMessages: "before" });
		const expectedText: Record<string, string> = {
			runId: "a run id or 8-character prefix",
			fromStage: "a stage path from listForkPoints",
			inputs: "an object of workflow inputs",
			cwd: "an existing directory",
			carryMessages: '"before" or "all"',
			definition: "a workflow definition created with workflow()",
			signal: "an AbortSignal",
		};
		const invalid = (field: string, value: unknown) => {
			const error = (() => {
				try {
					validateForkOptions(
						"sdk",
						field === "runId" ? value : runId,
						field === "runId" ? {} : { [field]: value },
					);
				} catch (failure) {
					return failure;
				}
				return undefined;
			})();
			assert.ok(error instanceof ForkConfigError, `${field}=${String(value)}`);
			assert.deepEqual(error.issues, [{ field, expected: expectedText[field] }]);
			assert.equal(error.expected, expectedText[field]);
			if (field !== "cwd") assert.equal(Object.hasOwn(error, "cause"), false, field);
			return error;
		};
		for (const value of [undefined, 7, "", "   "]) invalid("runId", value);
		for (const value of ["", 7]) invalid("fromStage", value);
		for (const value of [null, [], "text", 7]) invalid("inputs", value);
		for (const value of ["", 7, file]) invalid("cwd", value);
		assert.ok(
			invalid("cwd", join(directory, "missing")).cause instanceof Error,
			"a missing directory keeps its cause",
		);
		for (const value of [file, "", 7, ["not-a-path"]])
			assert.equal(Object.hasOwn(invalid("cwd", value), "cause"), false, String(value));
		for (const value of ["later", 1]) invalid("carryMessages", value);
		for (const value of [{}, "workflow"]) invalid("definition", value);
		for (const value of [null, {}, "signal"]) invalid("signal", value);
		const all = invalid("runId", "");
		assert.equal(all.source, "sdk");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("forkDurableRun rejects an empty cwd and a child run id before claiming anything (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("copy-root");
	const childId = testRunId("copy-root-child");
	await register(backend, sourceId);
	await register(backend, childId, { rootWorkflowId: sourceId });
	const emptyCwd = await forkDurableRun(backend, { ...request(sourceId), cwd: "" }).catch((error: Error) => error);
	assert.ok(emptyCwd instanceof ForkConfigError);
	assert.deepEqual([emptyCwd.field, emptyCwd.expected], ["cwd", "a directory path"]);
	const child = await forkDurableRun(backend, request(childId)).catch((error: Error) => error);
	assert.ok(child instanceof ForkSourceNotFoundError);
	assert.deepEqual([child.reason, child.rootRunId], ["not-root", sourceId]);
	await backend.journal.createRun({
		runId: testRunId("copy-empty"),
		name: "x",
		cwd: "/",
		createdAt: 1,
		status: "paused",
	});
	const empty = await forkDurableRun(backend, request(testRunId("copy-empty"))).catch((error: Error) => error);
	assert.ok(empty instanceof ForkSourceNotFoundError, "a run with no handle event is not a fork source");
	assert.equal((await backend.journal.leaseState(sourceId))?.holderId, backend.holderId, "no fork claim was taken");
});

test("journal storage reports libSQL files and in-process journals as local-only, servers as shared (#4321)", async () => {
	const missing = testRunId("storage-missing");
	for (const [descriptor, scope] of [
		[{ adapter: "libsql", location: "file:/tmp/x.db" }, "local-only"],
		[{ adapter: "libsql", location: "FILE:/tmp/x.db" }, "local-only"],
		[{ adapter: "libsql", location: "https://db.example" }, "shared"],
		[{ adapter: "libsql", location: "https://db.example/file:x.db" }, "shared"],
		[{ adapter: "custom", location: "file:/tmp/x.db" }, "shared"],
		[{ adapter: "memory", location: ":memory:" }, "local-only"],
		[{ adapter: "node-sqlite", location: "/tmp/x.db" }, "local-only"],
		[{ adapter: "jsonl", location: "/tmp" }, "local-only"],
		[{ adapter: "custom", location: "custom journal" }, "shared"],
	] as const) {
		const journal = new MemoryRunJournal();
		Object.defineProperty(journal, "descriptor", { value: descriptor });
		const backend = await JournalDurableBackend.open(journal);
		try {
			const error = await forkDurableRun(backend, request(missing)).catch((failure: Error) => failure);
			assert.ok(error instanceof ForkSourceNotFoundError);
			assert.deepEqual(error.storage, { adapter: descriptor.adapter, scope }, descriptor.location);
		} finally {
			await backend.close();
		}
	}
});

test("a failed session copy removes the sessions it created and reports a cleanup failure without hiding the cause (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const sourceId = testRunId("copy-sessions-fail");
	await register(backend, sourceId);
	const ids: string[] = [];
	for (const name of ["one", "two", "three"]) {
		const session = await SessionManager.create(sessions, "/source");
		await session.appendMessage({ role: "user", content: name, timestamp: 1 });
		ids.push(session.getSessionId());
		await commit(backend, [
			stage(sourceId, `stage:${name}`, name, `stage:${name}:1`, { output: name, sessionId: session.getSessionId() }),
		]);
	}
	await commit(backend, [
		stage(sourceId, "stage:again", "one", "stage:one:2", { output: "again", sessionId: ids[0] }),
	]);
	const create = sessions.create.bind(sessions);
	const created: string[] = [];
	const failure = new Error("store full");
	vi.spyOn(sessions, "create").mockImplementation(async (header, entries) => {
		if (created.length === 2) throw failure;
		created.push(header.id);
		return create(header, entries);
	});
	const deleteFailure = new Error("delete failed");
	vi.spyOn(sessions, "delete").mockRejectedValue(deleteFailure);
	const error = await forkDurableRun(backend, {
		...request(sourceId),
		sessionStore: sessions,
		sourceSessionStore: sessions,
	}).catch((problem: Error) => problem);
	assert.ok(error instanceof ForkCopyFailedError);
	assert.deepEqual([error.phase, error.cause], ["sessions", failure]);
	assert.ok(error.cleanupCause instanceof AggregateError);
	assert.deepEqual((error.cleanupCause as AggregateError).errors, [deleteFailure, deleteFailure]);
	assert.equal(error.cleanupCause.message, "Copied fork sessions were not removed");
	assert.equal(await backend.journal.getRun(error.forkRunId), undefined);
	vi.restoreAllMocks();
	const single = vi.spyOn(sessions, "create").mockImplementationOnce(create).mockRejectedValueOnce(failure);
	const deletes = vi.spyOn(sessions, "delete").mockRejectedValueOnce(deleteFailure);
	const one = await forkDurableRun(backend, {
		...request(sourceId),
		sessionStore: sessions,
		sourceSessionStore: sessions,
	}).catch((problem: Error) => problem);
	assert.ok(one instanceof ForkCopyFailedError);
	assert.equal(one.cleanupCause, deleteFailure, "one failed removal is reported as itself");
	assert.equal(deletes.mock.calls.length, 1);
	assert.equal(single.mock.calls.length, 2);
	vi.restoreAllMocks();
	const removed = vi.spyOn(sessions, "delete");
	vi.spyOn(sessions, "create").mockImplementationOnce(create).mockRejectedValueOnce(failure);
	const clean = await forkDurableRun(backend, {
		...request(sourceId),
		sessionStore: sessions,
		sourceSessionStore: sessions,
	}).catch((problem: Error) => problem);
	assert.ok(clean instanceof ForkCopyFailedError);
	assert.equal(Object.hasOwn(clean, "cleanupCause"), false);
	assert.equal(removed.mock.calls.length, 1);
	assert.equal(await sessions.readHeader(removed.mock.calls[0]![0]), undefined);
});

test("an abort while copying sessions rejects with its reason and removes the copies (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const sourceId = testRunId("copy-sessions-abort");
	await register(backend, sourceId);
	for (const name of ["one", "two"]) {
		const session = await SessionManager.create(sessions, "/source");
		await session.appendMessage({ role: "user", content: name, timestamp: 1 });
		await commit(backend, [
			stage(sourceId, `stage:${name}`, name, `stage:${name}:1`, { output: name, sessionId: session.getSessionId() }),
		]);
	}
	const controller = new AbortController();
	const reason = new Error("stop");
	const create = sessions.create.bind(sessions);
	const created: string[] = [];
	vi.spyOn(sessions, "create").mockImplementation(async (header, entries) => {
		created.push(header.id);
		const result = await create(header, entries);
		controller.abort(reason);
		return result;
	});
	await assert.rejects(
		forkDurableRun(backend, {
			...request(sourceId),
			sessionStore: sessions,
			sourceSessionStore: sessions,
			signal: controller.signal,
		}),
		(error) => error === reason,
	);
	assert.equal(created.length, 1);
	assert.equal(await sessions.readHeader(created[0]!), undefined);
	assert.equal((await backend.journal.listRuns()).length, 1);
});

test("a journal that reports the fork run as existing fails the copy without keeping its sessions (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const sourceId = testRunId("copy-exists");
	await register(backend, sourceId);
	const session = await SessionManager.create(sessions, "/source");
	await session.appendMessage({ role: "user", content: "x", timestamp: 1 });
	await commit(backend, [
		stage(sourceId, "stage:x", "x", "stage:x:1", { output: "x", sessionId: session.getSessionId() }),
	]);
	vi.spyOn(backend.journal, "createRunWithEvents").mockResolvedValue("exists");
	const created = vi.spyOn(sessions, "create");
	const error = await forkDurableRun(backend, {
		...request(sourceId),
		sessionStore: sessions,
		sourceSessionStore: sessions,
	}).catch((problem: Error) => problem);
	assert.ok(error instanceof ForkCopyFailedError);
	assert.equal(error.phase, "journal");
	assert.equal((error.cause as Error).message, `Run ${error.forkRunId} already exists`);
	assert.equal(await sessions.readHeader(created.mock.calls[0]![0].id), undefined);
});

test("the source claim is released after every fork, and a release failure after success is logged once (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("copy-claim");
	await register(backend, sourceId);
	await commit(backend, [stage(sourceId, "stage:x", "x", "stage:x:1", { output: "x" })]);
	await backend.releaseWorkflow(sourceId);
	const takeover = vi.spyOn(backend.journal, "takeoverExpired");
	const release = vi.spyOn(backend.journal, "release");
	await forkDurableRun(backend, request(sourceId));
	assert.equal(takeover.mock.calls.length, 1);
	assert.match(takeover.mock.calls[0]![1], /^fork:[0-9a-f-]{36}$/);
	assert.equal(takeover.mock.calls[0]![2], 120_000);
	assert.equal(release.mock.calls.length, 1);
	assert.equal(await backend.journal.leaseState(sourceId), undefined);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	release.mockRejectedValueOnce(new Error("release failed"));
	const forked = await forkDurableRun(backend, request(sourceId));
	assert.ok(forked.runId);
	assert.equal(warn.mock.calls.length, 1);
	const [warned, ...extra] = warn.mock.calls[0]!;
	assert.ok(isForkClaimReleaseError(warned));
	assert.ok(warned instanceof ForkClaimReleaseError);
	assert.deepEqual(
		[warned.code, warned.runId, warned.claimExpiresInMs, warned.retryable, (warned.cause as Error).message, extra],
		["claim-release-failed", sourceId, 120_000, false, "release failed", []],
	);
	takeover.mockResolvedValueOnce({ status: "held", holderId: null, epoch: 3 });
	const busy = await forkDurableRun(backend, request(sourceId)).catch((error: Error) => error);
	assert.ok(busy instanceof ForkSourceBusyError);
	assert.deepEqual([busy.reason, busy.holderId, "holderId" in busy.fields], ["foreign-lease", undefined, false]);
});

test("a source whose lease this backend already holds is forked without taking a second claim (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("copy-own-lease");
	await register(backend, sourceId);
	await commit(backend, [stage(sourceId, "stage:x", "x", "stage:x:1", { output: "x" })]);
	const held = await backend.journal.leaseState(sourceId);
	assert.equal(held?.holderId, backend.holderId);
	const takeover = vi.spyOn(backend.journal, "takeoverExpired");
	const release = vi.spyOn(backend.journal, "release");
	await forkDurableRun(backend, request(sourceId));
	assert.equal(takeover.mock.calls.length, 0);
	assert.equal(release.mock.calls.length, 0);
	assert.deepEqual(await backend.journal.leaseState(sourceId).then((lease) => [lease?.holderId, lease?.epoch]), [
		held?.holderId,
		held?.epoch,
	]);
	await backend.commitWorkflowStatus(sourceId, "paused", 0, true);
});

test("fork points list sessions lazily, open the source store once and close only a store they opened (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const sourceId = testRunId("copy-points");
	await register(backend, sourceId);
	const session = await SessionManager.create(sessions, "/source");
	await session.appendMessage({ role: "user", content: "x", timestamp: 1 });
	const empty = await SessionManager.create(sessions, "/source");
	await sessions.create({ ...(await sessions.load(empty.getSessionId())).header, id: "empty-session" }, []);
	await commit(backend, [
		stage(sourceId, "stage:a", "a", "stage:a:1", { output: "a" }),
		stage(sourceId, "stage:b", "b", "stage:b:1", { output: "b", sessionId: session.getSessionId() }),
		stage(sourceId, "stage:c", "c", "stage:c:1", { output: "c", sessionId: "empty-session" }),
		stage(sourceId, "stage:x#2", "x#2", "stage:x#2:1", { output: "literal" }),
		stage(sourceId, "stage:x", "x", "stage:x:1", { output: "x1" }),
		stage(sourceId, "stage:x2", "x", "stage:x:2", { output: "x2" }),
		stage(sourceId, "prompt", "input", "prompt:input:1", {
			output: "answer",
			topology: { version: 1, stageId: "p", parentIds: [], occurrenceKey: "p" },
		}),
	]);
	const loads = vi.spyOn(sessions, "load");
	const closes = vi.spyOn(sessions, "close");
	const points = [];
	for await (const point of durableForkPoints(backend, sourceId, { sourceSessionStore: sessions })) points.push(point);
	assert.deepEqual(points, [
		{ stagePath: "a", completedAt: 1 },
		{
			stagePath: "b",
			sessionId: session.getSessionId(),
			entryId: (await sessions.load(session.getSessionId())).entries.at(-1)!.id,
			completedAt: 1,
		},
		{ stagePath: "c", sessionId: "empty-session", completedAt: 1 },
		{ stagePath: "x#2", completedAt: 1 },
		{ stagePath: "x", completedAt: 1 },
		{ stagePath: "x#3", completedAt: 1 },
	]);
	assert.equal(loads.mock.calls.length, 3);
	assert.equal(closes.mock.calls.length, 0, "a borrowed store stays open");
});

test("nested dot paths name every enclosing workflow stage, outermost first (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("copy-nested");
	await register(backend, sourceId);
	const boundary = (key: string, name: string) =>
		stage(sourceId, `boundary-start:${key}`, name, key, {
			topology: {
				version: 1,
				stageId: `${name}-id`,
				parentIds: [],
				boundary: {
					version: 1,
					event: "start",
					status: "running",
					replayScope: key,
					alias: name,
					workflow: name,
					invocationFingerprint: "fp",
					child: {
						runId: testRunId(name),
						runName: name,
						parentRunId: sourceId,
						parentStageId: `${name}-id`,
						rootRunId: sourceId,
					},
				},
			},
		});
	const outer = "workflow:outer:fp:1";
	const inner = `${outer}:workflow:inner:fp:1`;
	await commit(backend, [
		boundary(outer, "outer"),
		boundary(inner, "inner"),
		stage(sourceId, `${inner}:stage:deep`, "deep", `${inner}:stage:deep:1`, { output: "deep" }),
		stage(sourceId, `${outer}:stage:mid`, "mid", `${outer}:stage:mid:1`, { output: "mid" }),
		stage(sourceId, "workflow:outerx:fp:1:stage:other", "other", "workflow:outerx:fp:1:stage:other:1", {
			output: "x",
		}),
	]);
	const points = [];
	for await (const point of durableForkPoints(backend, sourceId)) points.push(point.stagePath);
	assert.deepEqual(points, ["outer.inner.deep", "outer.mid", "other"]);
});

test("a fork that copies no checkpoint is still resumable, so it can start from its first stage (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("copy-zero");
	await register(backend, sourceId);
	await commit(backend, [stage(sourceId, "stage:first", "first", "stage:first:1", { output: "first" })]);
	const fork = await forkDurableRun(backend, { ...request(sourceId), fromStage: "first" });
	const handle = backend.getWorkflow(fork.runId)!;
	assert.equal(handle.completedCheckpoints, 0);
	assert.equal(isDurableWorkflowResumable(handle), true);
	assert.equal(isDurableWorkflowResumable({ ...handle, forkedFrom: undefined }), false);
	assert.deepEqual(
		(await prepareTargetedDurableResumable(backend, [fork.runId])).map((entry) => entry.workflowId),
		[fork.runId],
	);
});

test("the memory journal's atomic run creation keeps its storage descriptor and reports failures as unavailable memory storage (#4321)", async () => {
	const journal = new MemoryRunJournal({ adapter: "memory", location: "test-store" });
	const header = { runId: "seeded", name: "w", cwd: "/", createdAt: 1, status: "running" };
	assert.equal(
		await journal.createRunWithEvents(header, [{ event: { type: "RunStarted", payload: null } }]),
		"created",
	);
	assert.deepEqual(await journal.getRun("seeded"), {
		...header,
		storage: { adapter: "memory", location: "test-store" },
	});
	assert.equal(
		(await journal.getRun("seeded"))?.status,
		"running",
		"a run without a status event keeps its header status",
	);
	const [entry] = await (async () => {
		const read = [];
		for await (const item of journal.read("seeded")) read.push(item);
		return read;
	})();
	assert.deepEqual([entry?.seq, entry?.epoch, "key" in entry!], [1, 0, false]);
	const duplicate = await journal
		.createRunWithEvents({ ...header, runId: "duplicate" }, [
			{ event: { type: "RunStarted", payload: null }, key: "k" },
			{ event: { type: "RunFinished", payload: null }, key: "k" },
		])
		.then(
			() => assert.fail("duplicate keys must fail"),
			(error: Error) => error,
		);
	assert.equal(duplicate.name, "StorageUnavailableError");
	assert.deepEqual(
		[(duplicate as Error & { adapter: string }).adapter, (duplicate as Error & { location: string }).location],
		["memory", ":memory:"],
	);
	assert.equal(((duplicate as Error).cause as Error).message, "Duplicate event key in run duplicate");
	const unserializable = await journal
		.createRunWithEvents({ ...header, runId: "bigint" }, [{ event: { type: "RunStarted", payload: 1n as never } }])
		.then(
			() => assert.fail("an unserializable payload must fail"),
			(error: Error) => error,
		);
	assert.equal(unserializable.name, "StorageUnavailableError");
	assert.equal((unserializable as Error & { location: string }).location, ":memory:");
	const badHeader = await journal
		.createRunWithEvents({ ...header, runId: "bad-header", inputs: 1n as never }, [])
		.then(
			() => assert.fail("an unserializable header must fail"),
			(error: Error) => error,
		);
	assert.equal((badHeader as Error & { location: string }).location, ":memory:");
	assert.equal(await journal.getRun("bigint"), undefined);
	await journal.close();
	await assert.rejects(journal.createRunWithEvents({ ...header, runId: "closed" }, []), {
		name: "StorageUnavailableError",
	});
});

test("a definition resolver that fails or returns something else is a definition-unavailable mismatch (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("copy-resolver");
	await register(backend, sourceId);
	await commit(backend, [stage(sourceId, "stage:x", "x", "stage:x:1", { output: "x" })]);
	const failure = new Error("discovery failed");
	const base = { source: "sdk" as const, runId: sourceId, carryMessages: "before" as const };
	const seen: (string | undefined)[][] = [];
	const thrown = await forkDurableRun(backend, {
		...base,
		resolveDefinition: async (name, cwd) => {
			seen.push([name, cwd]);
			throw failure;
		},
	}).catch((error: Error) => error);
	assert.ok(thrown instanceof ForkDefinitionMismatchError);
	assert.deepEqual([thrown.reason, thrown.cause], ["definition-unavailable", failure]);
	assert.deepEqual(seen, [[definition.name, "/source"]]);
	const other = await forkDurableRun(backend, { ...base, resolveDefinition: async () => ({}) as never }).catch(
		(error: Error) => error,
	);
	assert.ok(other instanceof ForkDefinitionMismatchError);
	assert.deepEqual([other.reason, other.cause], ["definition-unavailable", undefined]);
	const resolved = await forkDurableRun(backend, { ...base, resolveDefinition: async () => definition });
	assert.equal(resolved.definition, definition);
	assert.deepEqual(resolved.inputs, {});
	const none = await forkDurableRun(backend, base).catch((error: Error) => error);
	assert.ok(none instanceof ForkDefinitionMismatchError, "no definition and no resolver");
	assert.deepEqual([none.reason, none.cause], ["definition-unavailable", undefined]);
});
