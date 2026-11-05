import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageRollbackError, StorageUnavailableError } from "@bastani/atomic/storage";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	ForkClaimReleaseError,
	ForkConfigError,
	ForkCopyFailedError,
	ForkDefinitionMismatchError,
	ForkJournalUnavailableError,
	ForkJournalUnsupportedError,
	ForkSessionNotFoundError,
	ForkSessionUnavailableError,
	ForkSourceBusyError,
	ForkSourceNotFoundError,
	ForkTargetNotFoundError,
	isForkConfigError,
	isForkCopyFailedError,
	isForkDefinitionMismatchError,
	isForkJournalUnavailableError,
	isForkJournalUnsupportedError,
	isForkSessionNotFoundError,
	isForkSessionUnavailableError,
	isForkSourceBusyError,
	isForkSourceNotFoundError,
	isForkTargetNotFoundError,
	isRetryableForkError,
} from "../../packages/workflows/src/durable/fork-errors.js";
import { durableForkPoints, forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import {
	type JournalEntry,
	type RunJournal,
	StaleLeaseError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { claimsOf, pendingForks, pendingResumes } from "../../packages/workflows/src/durable/run-claims.js";
import { inspectRun } from "../../packages/workflows/src/runs/background/run-inspect.js";
import { forkRun, listForkPoints } from "../../packages/workflows/src/runs/foreground/sdk-fork.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowUIAdapter } from "../../packages/workflows/src/shared/types.js";
import { testRunId } from "../helpers/run-id.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

afterEach(async () => {
	setDurableBackend(undefined);
	vi.restoreAllMocks();
	await closeMemoryTestBackends();
});

async function journalEvents(journal: RunJournal, runId: string): Promise<JournalEntry[]> {
	const entries: JournalEntry[] = [];
	for await (const entry of journal.read(runId)) entries.push(entry);
	return entries;
}

function promptUi(answers: string[], asked: string[]): WorkflowUIAdapter {
	return {
		input: async (prompt) => {
			asked.push(prompt);
			return answers.shift() ?? `answer:${prompt}`;
		},
		confirm: async () => true,
		select: async (_message, options) => options[0]!,
		editor: async (initial) => initial ?? "",
		custom: async () => {
			throw new Error("custom prompts are not used");
		},
	};
}

function linearWorkflow(counters: { prepare: number; after: number; completions: string[] }) {
	return workflow({
		name: "fork-linear",
		description: "",
		inputs: { objective: Type.String({ default: "first" }) },
		outputs: { review: Type.String() },
		run: async (ctx) => {
			await ctx.tool("prepare", {}, async () => {
				counters.prepare++;
				return "prepared";
			});
			const before = await ctx.ui.input("before the point");
			await ctx.stage("plan").complete(`plan ${ctx.inputs.objective} ${before}`);
			const at = await ctx.ui.input("at the point");
			await ctx.stage("implement").complete(`implement ${ctx.inputs.objective} ${at}`);
			await ctx.tool("after", {}, async () => {
				counters.after++;
				return "after";
			});
			const review = await ctx.stage("review").complete(`review ${ctx.inputs.objective}`);
			return { review: String(review) };
		},
	});
}

const complete = (completions: string[]) => ({
	complete: {
		complete: async (text: string) => {
			completions.push(text);
			return text;
		},
	},
});

async function linearSource(seed: string) {
	const backend = await createMemoryTestBackend();
	const counters = { prepare: 0, after: 0, completions: [] as string[] };
	const def = linearWorkflow(counters);
	const asked: string[] = [];
	const runId = testRunId(seed);
	const sourceStore = createStore();
	const result = await run(
		def,
		{},
		{
			runId,
			durableBackend: backend,
			store: sourceStore,
			cwd: process.cwd(),
			adapters: complete(counters.completions),
			ui: promptUi([], asked),
		},
	);
	assert.equal(result.status, "completed", result.error);
	assert.equal("forkedFrom" in sourceStore.run(runId)!, false, "a run that is not a fork records no lineage");
	return { backend, counters, def, asked, runId };
}

test("forkRun re-runs from a stage, replays earlier tools and prompts, and leaves the source untouched (#4321)", async () => {
	const { backend, counters, def, runId } = await linearSource("fork-linear-source");
	const sourceHandle = structuredClone(backend.getWorkflow(runId));
	const sourceCheckpoints = structuredClone(backend.listCheckpoints(runId));
	const sourceEvents = await journalEvents(backend.journal, runId);
	const asked: string[] = [];
	const completions: string[] = [];
	const store = createStore();
	const forked = await forkRun(runId, {
		fromStage: "implement",
		inputs: { objective: "second" },
		durableBackend: backend,
		definition: def,
		store,
		cwd: process.cwd(),
		adapters: complete(completions),
		ui: promptUi([], asked),
	});
	const events: string[] = [];
	for await (const event of forked.events) events.push(event.type);
	const result = await forked.result;
	assert.equal(result.status, "completed", result.error);
	assert.notEqual(forked.runId, runId);
	assert.deepEqual(forked.forkedFrom, { runId, stagePath: "implement" });
	assert.equal(counters.prepare, 1, "the tool before the fork point replays from its checkpoint");
	assert.equal(counters.after, 2, "the tool after the fork point runs again");
	assert.deepEqual(asked, [], "prompts answered before the fork point replay their answers");
	assert.deepEqual(completions, ["implement second answer:at the point", "review second"]);
	assert.equal(events[0], "run_start");
	assert.equal(events.at(-1), "run_end");
	assert.ok(events.includes("stage_end"));
	assert.deepEqual(backend.getWorkflow(runId), sourceHandle);
	assert.deepEqual(backend.listCheckpoints(runId), sourceCheckpoints);
	assert.deepEqual(await journalEvents(backend.journal, runId), sourceEvents);
	assert.equal(await backend.workflowOwnership(runId), "available");
	assert.deepEqual(backend.getWorkflow(forked.runId)?.forkedFrom, { runId, stagePath: "implement" });
	assert.deepEqual(backend.getWorkflow(forked.runId)?.inputs, { objective: "second" });
	const inspected = inspectRun(forked.runId, { store });
	assert.ok(inspected.ok);
	assert.deepEqual(inspected.detail.forkedFrom, { runId, stagePath: "implement" });
	assert.deepEqual(store.run(forked.runId)?.forkedFrom, { runId, stagePath: "implement" });
});

test("listForkPoints yields each completed stage once with a unique dot path, in completion order (#4321)", async () => {
	const { backend, runId } = await linearSource("fork-points-source");
	const points = [];
	for await (const point of listForkPoints(runId, { durableBackend: backend })) points.push(point);
	assert.deepEqual(
		points.map((point) => point.stagePath),
		["plan", "implement", "review"],
	);
	for (const point of points) {
		assert.equal(typeof point.completedAt, "number");
		assert.equal(point.sessionId, undefined);
		assert.equal(point.entryId, undefined);
	}
});

test("carryMessages all carries prompt answers after the fork point; before re-asks them (#4321)", async () => {
	for (const carryMessages of ["before", "all"] as const) {
		const { backend, def, runId } = await linearSource(`fork-carry-${carryMessages}`);
		const asked: string[] = [];
		const forked = await forkRun(runId, {
			fromStage: "plan",
			carryMessages,
			durableBackend: backend,
			definition: def,
			store: createStore(),
			cwd: process.cwd(),
			adapters: complete([]),
			ui: promptUi([], asked),
		});
		assert.equal((await forked.result).status, "completed");
		assert.deepEqual(asked, carryMessages === "before" ? ["at the point"] : [], carryMessages);
	}
});

test("forkRun into another cwd records that directory and copies stage sessions into its store (#4321)", async () => {
	const root = mkdtempSync(join(tmpdir(), "fork-other-cwd-"));
	try {
		const backend = await createMemoryTestBackend();
		const sourceStore = new MemorySessionStore();
		const destination = new MemorySessionStore();
		const session = await SessionManager.create(sourceStore, root);
		await session.appendMessage({ role: "user", content: "source conversation", timestamp: 1 });
		const def = workflow({
			name: "fork-sessions",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("saved", { prompt: "saved" });
				await ctx.stage("next").complete("next");
				return {};
			},
		});
		const runId = testRunId("fork-sessions-source");
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: def.name,
			inputs: {},
			status: "completed",
			createdAt: 1,
			invocationCwd: join(root, "source"),
		});
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: "task:stage:task:saved:1",
			name: "saved",
			replayKey: "stage:task:saved:1",
			sessionId: session.getSessionId(),
			output: { name: "saved", stageName: "saved", text: "saved", sessionId: session.getSessionId() },
			completedAt: 2,
		});
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: "stage:stage:next:1",
			name: "next",
			replayKey: "stage:next:1",
			output: "next",
			completedAt: 3,
		});
		const points = [];
		for await (const point of listForkPoints(runId, { durableBackend: backend, sourceSessionStore: sourceStore }))
			points.push(point);
		const sourceEntries = (await sourceStore.load(session.getSessionId())).entries;
		assert.deepEqual(points[0], {
			stagePath: "saved",
			sessionId: session.getSessionId(),
			entryId: sourceEntries.at(-1)!.id,
			completedAt: 2,
		});
		const target = join(root, "target");
		const fork = await forkDurableRun(backend, {
			source: "sdk",
			runId,
			fromStage: "next",
			cwd: root,
			carryMessages: "before",
			definition: def,
			sessionStore: destination,
			sourceSessionStore: sourceStore,
		});
		const handle = backend.getWorkflow(fork.runId)!;
		assert.equal(handle.invocationCwd, root);
		assert.equal(handle.status, "paused");
		const copied = backend.listCheckpoints(fork.runId).find((checkpoint) => checkpoint.kind === "stage");
		assert.ok(copied?.kind === "stage");
		assert.notEqual(copied.sessionId, session.getSessionId());
		const copiedSession = await destination.load(copied.sessionId!);
		assert.equal(copiedSession.header.parentSessionId, session.getSessionId());
		assert.equal(copiedSession.header.cwd, root);
		assert.deepEqual(copiedSession.entries, sourceEntries);
		assert.equal((await sourceStore.load(session.getSessionId())).entries.length, sourceEntries.length);
		assert.equal(target.length > 0, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("nested dot paths fork inside a child workflow and replay the child's earlier stages (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const completions: string[] = [];
	const child = workflow({
		name: "implement-api",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("review-1").complete("review-1");
			await ctx.stage("review-2").complete("review-2");
			return {};
		},
	});
	const def = workflow({
		name: "nested-parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("setup").complete("setup");
			await ctx.workflow(child, { stageName: "implement-api" });
			await ctx.stage("ship").complete("ship");
			return {};
		},
	});
	const runId = testRunId("fork-nested-source");
	assert.equal(
		(await run(def, {}, { runId, durableBackend: backend, store: createStore(), adapters: complete([]) })).status,
		"completed",
	);
	const points = [];
	for await (const point of listForkPoints(runId, { durableBackend: backend })) points.push(point.stagePath);
	assert.deepEqual(points, ["setup", "implement-api.review-1", "implement-api.review-2", "implement-api", "ship"]);
	const forked = await forkRun(runId, {
		fromStage: "implement-api.review-2",
		durableBackend: backend,
		definition: def,
		store: createStore(),
		adapters: complete(completions),
	});
	assert.equal((await forked.result).status, "completed", (await forked.result).error);
	assert.deepEqual(completions, ["review-2", "ship"]);
});

test("ForkTargetNotFoundError lists at most 10 valid stage paths and nothing is written (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const def = workflow({
		name: "many-stages",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			for (let index = 0; index < 12; index++) await ctx.stage(`stage-${index}`).complete("done");
			await ctx.stage("stage-0").complete("again");
			return {};
		},
	});
	const runId = testRunId("fork-many-stages");
	await run(def, {}, { runId, durableBackend: backend, store: createStore(), adapters: complete([]) });
	const runsBefore = await backend.journal.listRuns();
	const error = await forkRun(runId, { fromStage: "stage-99", durableBackend: backend, definition: def }).then(
		() => assert.fail("fork must fail"),
		(failure: Error) => failure,
	);
	assert.ok(error instanceof ForkTargetNotFoundError);
	assert.ok(isForkTargetNotFoundError(error));
	assert.equal(error.code, "target-not-found");
	assert.equal(error.runId, runId);
	assert.equal(error.fromStage, "stage-99");
	assert.equal(error.validStagePaths.length, 10);
	assert.equal(error.totalValidStagePaths, 13);
	assert.deepEqual(error.validStagePaths.slice(0, 2), ["stage-0", "stage-1"]);
	assert.equal(error.retryable, false);
	assert.deepEqual(await backend.journal.listRuns(), runsBefore);
	const points = [];
	for await (const point of listForkPoints(runId, { durableBackend: backend })) points.push(point.stagePath);
	assert.equal(points.at(-1), "stage-0#2", "a repeated stage name gets an occurrence suffix");
	assert.equal(await backend.workflowOwnership(runId), "available");
});

test("ForkDefinitionMismatchError reports each mismatch reason before copying (#4321)", async () => {
	const { backend, def, runId } = await linearSource("fork-definition-mismatch");
	const other = workflow({ name: "other", description: "", inputs: {}, outputs: {}, run: async () => ({}) });
	const strict = workflow({
		name: "fork-linear",
		description: "",
		inputs: { objective: Type.Number() },
		outputs: {},
		run: async () => ({}),
	});
	const request = { source: "sdk" as const, runId, fromStage: "implement", carryMessages: "before" as const };
	const cases = [
		{
			fork: () => forkDurableRun(backend, { ...request, definition: other }),
			reason: "name-changed",
			definition: "other",
		},
		{ fork: () => forkDurableRun(backend, { ...request, definition: strict }), reason: "inputs-incompatible" },
		{
			fork: () => forkDurableRun(backend, { ...request, resolveDefinition: async () => undefined }),
			reason: "definition-unavailable",
		},
	] as const;
	const runsBefore = await backend.journal.listRuns();
	for (const testCase of cases) {
		const error = await testCase.fork().then(
			() => assert.fail("fork must fail"),
			(failure: Error) => failure,
		);
		assert.ok(isForkDefinitionMismatchError(error), testCase.reason);
		assert.ok(error instanceof ForkDefinitionMismatchError);
		assert.equal(error.code, "definition-mismatch");
		assert.equal(error.reason, testCase.reason);
		assert.equal(error.workflow, def.name);
		assert.equal(error.definition, "definition" in testCase ? testCase.definition : undefined);
		assert.equal(error.runId, runId);
		assert.equal(error.cause instanceof Error, testCase.reason === "inputs-incompatible", testCase.reason);
	}
	assert.deepEqual(await backend.journal.listRuns(), runsBefore);
});

test("replacement inputs that fail the definition are a ForkConfigError naming inputs (#4321)", async () => {
	const { backend, def, runId } = await linearSource("fork-bad-inputs");
	const error = await forkRun(runId, {
		fromStage: "implement",
		inputs: { objective: 3 },
		durableBackend: backend,
		definition: def,
	}).then(
		() => assert.fail("fork must fail"),
		(failure: Error) => failure,
	);
	assert.ok(isForkConfigError(error));
	assert.equal(error.code, "invalid-option");
	assert.equal(error.source, "sdk");
	assert.equal(error.field, "inputs");
	assert.equal(error.expected, 'inputs that satisfy workflow "fork-linear"');
	assert.ok(error.cause instanceof Error);
	assert.match(error.cause.message, /invalid inputs for workflow "fork-linear"/);
	assert.equal((await backend.journal.listRuns()).length, 1);
});

test("ForkConfigError reports every invalid option in one pass before any journal call (#4321)", async () => {
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal);
	const calls: string[] = [];
	for (const method of ["getRun", "listRuns", "read", "takeoverExpired", "createRunWithEvents"] as const)
		vi.spyOn(journal, method).mockImplementation(() => {
			calls.push(method);
			throw new Error(`${method} must not be called`);
		});
	try {
		const error = await forkRun("", {
			fromStage: "",
			cwd: join(tmpdir(), "missing-fork-directory"),
			carryMessages: "later" as "all",
			inputs: [] as never,
			durableBackend: backend,
		}).then(
			() => assert.fail("fork must fail"),
			(failure: Error) => failure,
		);
		assert.ok(error instanceof ForkConfigError);
		assert.equal(error.code, "invalid-option");
		assert.equal(error.field, "runId");
		assert.deepEqual(
			error.issues.map((issue) => issue.field),
			["runId", "fromStage", "inputs", "cwd", "carryMessages"],
		);
		assert.deepEqual(calls, []);
	} finally {
		await backend.close();
	}
});

test("ForkSourceNotFoundError distinguishes not-found, malformed and ambiguous ids within bounded journal reads (#4321)", async () => {
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal);
	try {
		for (const suffix of ["1", "2"]) {
			await journal.createRun({
				runId: `aaaaaaaa-0000-4000-8000-00000000000${suffix}`,
				name: "x",
				cwd: "/",
				createdAt: 1,
				status: "paused",
			});
		}
		const reads = vi.spyOn(journal, "read");
		const getRun = vi.spyOn(journal, "getRun");
		const listRuns = vi.spyOn(journal, "listRuns");
		const operations = () => getRun.mock.calls.length + listRuns.mock.calls.length + reads.mock.calls.length;
		const notFound = await forkRun(testRunId("missing-source"), { durableBackend: backend }).catch(
			(error: Error) => error,
		);
		assert.ok(isForkSourceNotFoundError(notFound));
		assert.equal(notFound.code, "source-not-found");
		assert.equal(notFound.reason, "not-found");
		assert.deepEqual(notFound.storage, { adapter: "memory", scope: "local-only" });
		assert.match(notFound.hint, /atomic team join <url> --token-file <path>/);
		assert.equal(operations(), 1, "a full id costs one lookup");
		const malformed = await forkRun("not-a-run", { durableBackend: backend }).catch((error: Error) => error);
		assert.ok(malformed instanceof ForkSourceNotFoundError);
		assert.equal(malformed.reason, "malformed");
		assert.equal(operations(), 1, "a malformed id costs no journal operation");
		const ambiguous = await forkRun("aaaaaaaa", { durableBackend: backend }).catch((error: Error) => error);
		assert.ok(ambiguous instanceof ForkSourceNotFoundError);
		assert.equal(ambiguous.reason, "ambiguous");
		assert.deepEqual(ambiguous.matches, [
			"aaaaaaaa-0000-4000-8000-000000000001",
			"aaaaaaaa-0000-4000-8000-000000000002",
		]);
		assert.equal(operations(), 2, "a prefix costs one listing");
		assert.equal(reads.mock.calls.length, 0);
		assert.deepEqual(await journal.leaseState("aaaaaaaa-0000-4000-8000-000000000001"), undefined);
	} finally {
		await backend.close();
	}
});

test("ForkSourceBusyError covers a pending fork, a pending resume, a live execution and a foreign lease (#4321)", async () => {
	const { backend, def, runId } = await linearSource("fork-busy-source");
	const request = {
		source: "sdk" as const,
		runId,
		fromStage: "implement",
		carryMessages: "before" as const,
		definition: def,
	};
	const expectBusy = async (reason: string, options: { readonly isLiveRun?: (id: string) => boolean } = {}) => {
		const error = await forkDurableRun(backend, { ...request, ...options }).then(
			() => assert.fail("fork must fail"),
			(failure: Error) => failure,
		);
		assert.ok(isForkSourceBusyError(error), reason);
		assert.ok(error instanceof ForkSourceBusyError);
		assert.equal(error.code, "source-busy");
		assert.equal(error.reason, reason);
		assert.equal(error.retryable, true);
		assert.ok(isRetryableForkError(new Error("wrapped", { cause: error })));
		return error;
	};
	const runsBefore = await backend.journal.listRuns();
	claimsOf(pendingForks, backend).add(runId);
	await expectBusy("fork-in-progress");
	claimsOf(pendingForks, backend).delete(runId);
	claimsOf(pendingResumes, backend).add(runId);
	await expectBusy("resume-in-progress");
	claimsOf(pendingResumes, backend).delete(runId);
	await expectBusy("live-execution", { isLiveRun: (id) => id === runId });
	await backend.withWorkflowLease(runId, () => expectBusy("live-execution"));
	const foreign = await backend.journal.takeoverExpired(runId, "other-process", 60_000);
	assert.equal(foreign.status, "acquired");
	const held = await expectBusy("foreign-lease");
	assert.equal(held.holderId, "other-process");
	assert.deepEqual(await backend.journal.listRuns(), runsBefore);
});

test("an aborted fork rejects with the signal's reason and creates no run (#4321)", async () => {
	const { backend, def, runId } = await linearSource("fork-abort-source");
	const reason = new Error("caller cancelled");
	const controller = new AbortController();
	controller.abort(reason);
	const runsBefore = await backend.journal.listRuns();
	await assert.rejects(
		forkRun(runId, { fromStage: "implement", durableBackend: backend, definition: def, signal: controller.signal }),
		(error) => error === reason,
	);
	const midway = new AbortController();
	const read = backend.journal.read.bind(backend.journal);
	vi.spyOn(backend.journal, "read").mockImplementation((id, fromSeq) => {
		midway.abort(reason);
		return read(id, fromSeq);
	});
	await assert.rejects(
		forkDurableRun(backend, {
			source: "sdk",
			runId,
			fromStage: "implement",
			carryMessages: "before",
			definition: def,
			signal: midway.signal,
		}),
		(error) => error === reason,
	);
	assert.deepEqual(await backend.journal.listRuns(), runsBefore);
	assert.equal(await backend.workflowOwnership(runId), "available");
});

test("ForkJournalUnsupportedError rejects a journal without atomic run creation before reading it (#4321)", async () => {
	const journal = new MemoryRunJournal();
	Object.defineProperty(journal, "createRunWithEvents", { value: undefined });
	const backend = await JournalDurableBackend.open(journal);
	try {
		const read = vi.spyOn(journal, "getRun");
		const error = await forkRun(testRunId("unsupported"), { durableBackend: backend }).catch(
			(failure: Error) => failure,
		);
		assert.ok(isForkJournalUnsupportedError(error));
		assert.ok(error instanceof ForkJournalUnsupportedError);
		assert.equal(error.code, "journal-unsupported");
		assert.equal(error.capability, "createRunWithEvents");
		assert.equal(read.mock.calls.length, 0);
	} finally {
		await backend.close();
	}
});

test("a failed journal copy is a retryable ForkCopyFailedError that leaves no run and no copied session (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const session = await SessionManager.create(sessions, process.cwd());
	await session.appendMessage({ role: "user", content: "saved", timestamp: 1 });
	const def = workflow({ name: "copy-fails", description: "", inputs: {}, outputs: {}, run: async () => ({}) });
	const runId = testRunId("fork-copy-fails");
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: def.name,
		inputs: {},
		status: "paused",
		createdAt: 1,
		invocationCwd: process.cwd(),
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: "stage:saved",
		name: "saved",
		replayKey: "saved",
		sessionId: session.getSessionId(),
		output: "saved",
		completedAt: 2,
	});
	const storageFailure = new Error("disk full");
	vi.spyOn(backend.journal, "createRunWithEvents").mockRejectedValue(storageFailure);
	const created = vi.spyOn(sessions, "create");
	const error = await forkDurableRun(backend, {
		source: "sdk",
		runId,
		carryMessages: "before",
		definition: def,
		sessionStore: sessions,
		sourceSessionStore: sessions,
	}).catch((failure: Error) => failure);
	assert.ok(isForkCopyFailedError(error));
	assert.ok(error instanceof ForkCopyFailedError);
	assert.equal(error.code, "copy-failed");
	assert.equal(error.phase, "journal");
	assert.equal(error.retryable, true);
	assert.equal(error.cause, storageFailure);
	assert.equal(error.runId, runId);
	assert.equal(created.mock.calls.length, 1);
	const copiedId = created.mock.calls[0]![0].id;
	assert.equal(await sessions.readHeader(copiedId), undefined, "the copied session was removed");
	assert.equal(await backend.journal.getRun(error.forkRunId), undefined);
	assert.deepEqual(
		(await backend.journal.listRuns()).map((entry) => entry.runId),
		[runId],
	);
});

async function copySource(seed: string) {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const session = await SessionManager.create(sessions, process.cwd());
	await session.appendMessage({ role: "user", content: "saved", timestamp: 1 });
	const def = workflow({ name: seed, description: "", inputs: {}, outputs: {}, run: async () => ({}) });
	const runId = testRunId(seed);
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: def.name,
		inputs: {},
		status: "paused",
		createdAt: 1,
		invocationCwd: process.cwd(),
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: "stage:saved",
		name: "saved",
		replayKey: "saved",
		sessionId: session.getSessionId(),
		output: "saved",
		completedAt: 2,
	});
	const created = vi.spyOn(sessions, "create");
	const fork = (signal?: AbortSignal) =>
		forkDurableRun(backend, {
			source: "sdk",
			runId,
			carryMessages: "before",
			definition: def,
			sessionStore: sessions,
			sourceSessionStore: sessions,
			signal,
		});
	const copyKept = async () => (await sessions.readHeader(created.mock.calls[0]![0].id)) !== undefined;
	const forkRuns = async () => (await backend.journal.listRuns()).filter((entry) => entry.runId !== runId);
	return { backend, sessions, runId, fork, created, copyKept, forkRuns, sharedJournal: () => sharedJournal(backend) };
}

/** A journal reached over the network: a rejected write there is not proof that nothing was committed. */
function sharedJournal(backend: { readonly journal: RunJournal }) {
	return Object.defineProperty(backend.journal, "descriptor", {
		value: { adapter: "libsql", location: "libsql://journal.example" },
	});
}

/** A write that commits and then fails, like a lost reply or a failed close after the commit. */
function failAfterCommit(journal: RunJournal, failure: Error) {
	const write = journal.createRunWithEvents!.bind(journal);
	return vi.spyOn(journal, "createRunWithEvents").mockImplementation(async (header, events) => {
		await write(header, events);
		throw failure;
	});
}

test("a write that commits and then fails resolves the fork the journal holds, keeps its sessions and forks once (#4321)", async () => {
	for (const shared of [false, true]) {
		const { backend, fork, created, copyKept, forkRuns, sharedJournal } = await copySource(`fork-late-${shared}`);
		if (shared) sharedJournal();
		const failure = new Error("connection closed before the commit reply");
		const write = failAfterCommit(backend.journal, failure);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const forked = await fork();
		const [written] = await forkRuns();
		assert.equal(forked.runId, written?.runId, "the result names the fork the journal holds");
		assert.deepEqual([write.mock.calls.length, created.mock.calls.length, await copyKept()], [1, 1, true]);
		assert.equal(backend.getWorkflow(forked.runId)?.forkedFrom?.runId, forked.forkedFrom.runId, "it is hydrated");
		assert.equal(warn.mock.calls.length, 1, "the journal's error is logged once, as a typed error");
		const [logged] = warn.mock.calls[0]!;
		assert.ok(logged instanceof ForkJournalUnavailableError);
		assert.deepEqual([logged.phase, logged.forkRunId, logged.cause], ["commit-confirmed", forked.runId, failure]);
		assert.equal((await forkRuns()).length, 1);
		vi.restoreAllMocks();
	}
});

test("an unconfirmed write keeps the copied sessions and names the fork run in a non-retryable error (#4321)", async () => {
	const { backend, runId, fork, copyKept, forkRuns, sharedJournal } = await copySource("fork-unconfirmed");
	sharedJournal();
	const failure = new Error("timed out waiting for the commit reply");
	vi.spyOn(backend.journal, "createRunWithEvents").mockRejectedValue(failure);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const error = await fork().catch((problem: Error) => problem);
	assert.ok(isForkJournalUnavailableError(error), String(error));
	assert.ok(error instanceof ForkJournalUnavailableError);
	assert.deepEqual(
		[error.code, error.phase, error.runId, error.retryable, error.storage, error.cause],
		["journal-unavailable", "commit", runId, false, { adapter: "libsql", scope: "shared" }, failure],
	);
	assert.equal(isRetryableForkError(error), false);
	assert.ok(error.forkRunId !== undefined && error.hint.includes(`/workflow resume ${error.forkRunId}`));
	assert.ok(!error.hint.includes("fork again."), "the hint never advises forking again");
	assert.equal(await copyKept(), true, "a fork that may exist keeps its sessions");
	assert.equal((await forkRuns()).length, 0);
	assert.equal(claimsOf(pendingForks, backend).has(runId), false, "the source claim was released");
	assert.equal(warn.mock.calls.length, 0, "a thrown uncertainty is not logged as well");
});

test("a cancelled caller gets the signal's reason from an unconfirmed write, with the sessions kept and the uncertainty logged once (#4321)", async () => {
	const { backend, runId, fork, copyKept, sharedJournal } = await copySource("fork-unconfirmed-cancelled");
	sharedJournal();
	const failure = new Error("timed out waiting for the commit reply");
	const reason = new Error("caller cancelled");
	const controller = new AbortController();
	vi.spyOn(backend.journal, "createRunWithEvents").mockImplementation(async () => {
		controller.abort(reason);
		throw failure;
	});
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const error = await fork(controller.signal).catch((problem: unknown) => problem);
	assert.equal(error, reason, "the exact signal reason, not a ForkError");
	assert.equal(await copyKept(), true, "the possible fork keeps its sessions");
	assert.equal(claimsOf(pendingForks, backend).has(runId), false, "the source claim was released");
	assert.equal(warn.mock.calls.length, 1);
	const [logged] = warn.mock.calls[0]!;
	assert.ok(logged instanceof ForkJournalUnavailableError);
	assert.deepEqual([logged.phase, logged.retryable, logged.cause], ["commit", false, failure]);
});

test("a cancelled local write that did not commit propagates the signal reason and removes its copies (#4321)", async () => {
	const { backend, runId, fork, copyKept, forkRuns } = await copySource("fork-local-cancelled");
	const reason = new Error("caller cancelled");
	const controller = new AbortController();
	vi.spyOn(backend.journal, "createRunWithEvents").mockImplementation(async () => {
		controller.abort(reason);
		throw new Error("local transaction rolled back");
	});
	const error = await fork(controller.signal).catch((problem: unknown) => problem);
	assert.equal(error, reason);
	assert.equal(await copyKept(), false);
	assert.deepEqual(await forkRuns(), []);
	assert.equal(claimsOf(pendingForks, backend).has(runId), false);
});

test("a write failure whose read-back also fails keeps the sessions and carries both failures (#4321)", async () => {
	const { backend, fork, copyKept, forkRuns } = await copySource("fork-readback-fails");
	const failure = new Error("commit reply lost");
	failAfterCommit(backend.journal, failure);
	const unreachable = new StorageUnavailableError({ adapter: "memory", location: ":memory:" }, new Error("reset"));
	const getRun = backend.journal.getRun.bind(backend.journal);
	vi.spyOn(backend.journal, "getRun").mockImplementation(async (id) => {
		if (id !== (await forkRuns())[0]?.runId) return getRun(id);
		throw unreachable;
	});
	const error = await fork().catch((problem: Error) => problem);
	assert.ok(error instanceof ForkJournalUnavailableError);
	assert.deepEqual([error.phase, error.retryable], ["commit", false]);
	assert.equal(error.forkRunId, (await forkRuns())[0]?.runId, "it names the fork that was in fact written");
	assert.ok(error.cause instanceof AggregateError);
	assert.deepEqual(error.cause.errors, [failure, unreachable]);
	assert.equal(error.cause.message, `Writing fork run ${error.forkRunId} failed, and reading it back failed too`);
	assert.equal(await copyKept(), true);
});

test("a rejected write the journal proves unwritten is a retryable ForkCopyFailedError that removes the copies (#4321)", async () => {
	const cases = [
		{ name: "a local journal", shared: false, write: () => Promise.reject(new Error("disk full")) },
		{
			name: "a shared journal that returned an answer",
			shared: true,
			write: () => Promise.resolve("exists" as const),
		},
	];
	for (const { name, shared, write } of cases) {
		const { backend, fork, copyKept, forkRuns, sharedJournal } = await copySource(`fork-proven-${shared}`);
		if (shared) sharedJournal();
		vi.spyOn(backend.journal, "createRunWithEvents").mockImplementation(write);
		const error = await fork().catch((problem: Error) => problem);
		assert.ok(error instanceof ForkCopyFailedError, `${name}: ${String(error)}`);
		assert.deepEqual([error.retryable, error.phase], [true, "journal"], name);
		assert.equal(await copyKept(), false, `${name}: the copied session was removed`);
		assert.equal((await forkRuns()).length, 0, name);
		vi.restoreAllMocks();
	}
});

test("a failed journal write with no sessions does not attempt session cleanup (#4321)", async () => {
	const { backend, def, runId } = await linearSource("fork-no-session-rollback");
	vi.spyOn(backend.journal, "createRunWithEvents").mockRejectedValue(new Error("local transaction rolled back"));
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const error = await forkRun(runId, { durableBackend: backend, definition: def }).catch((failure: Error) => failure);
	assert.ok(error instanceof ForkCopyFailedError);
	assert.equal(error.code, "copy-failed");
	assert.equal(error.phase, "journal");
	assert.equal(error.cleanupCause, undefined);
	assert.equal(warn.mock.calls.length, 0);
	assert.equal((await backend.journal.listRuns()).length, 1);
});

test("a write that returns exists is a ForkCopyFailedError even when a run with that id is in the journal (#4321)", async () => {
	const { backend, fork, copyKept, forkRuns } = await copySource("fork-returned-exists");
	const write = backend.journal.createRunWithEvents!.bind(backend.journal);
	vi.spyOn(backend.journal, "createRunWithEvents").mockImplementation(async (header, events) => {
		await write(header, events);
		return "exists";
	});
	const getRun = vi.spyOn(backend.journal, "getRun");
	const lookups = getRun.mock.calls.length;
	const error = await fork().catch((problem: Error) => problem);
	assert.ok(error instanceof ForkCopyFailedError, String(error));
	assert.deepEqual([error.retryable, error.phase], [true, "journal"]);
	assert.equal((error.cause as Error).message, `Run ${error.forkRunId} already exists`);
	assert.equal(await copyKept(), false, "the answer is definite, so nothing is read back and the copies go");
	assert.equal((await forkRuns()).length, 1, "the other run is not touched");
	const afterFork = getRun.mock.calls.filter(([id]) => id === error.forkRunId).length;
	assert.equal(afterFork, 0, `the fork id is not read back (${lookups} earlier lookups)`);
});

/** A fork stopped in its first session copy until `open()`, on a controlled journal clock and timers. */
async function slowCopy(seed: string, options: { readonly ownLease?: boolean } = {}) {
	const source = await copySource(seed);
	if (options.ownLease !== true) {
		// A source this process does not hold: the fork takes its lease. (Registering it left this backend holding it.)
		const held = (await source.backend.journal.leaseState(source.runId))!;
		await source.backend.journal.release({ runId: source.runId, holderId: held.holderId, epoch: held.epoch });
	}
	// The store's own method: `copySource` already spies on the instance's.
	const create = MemorySessionStore.prototype.create.bind(source.sessions);
	let open!: () => void;
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	vi.spyOn(source.sessions, "create").mockImplementation(async (...args) => {
		enter();
		await gate;
		return create(...args);
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const release = vi.spyOn(source.backend.journal, "release");
	const realRenew = source.backend.journal.renew.bind(source.backend.journal);
	const renew = vi.spyOn(source.backend.journal, "renew");
	const holder = async () => (await source.backend.journal.leaseState(source.runId))?.holderId;
	return { ...source, open, entered, release, renew, realRenew, holder };
}

const QUARTER_WINDOW_MS = 30_000;

test("a slow copy keeps its claim fresh on the journal clock, so a resume cannot take the source over mid-fork (#4321)", async () => {
	const { backend, runId, fork, open, entered, release, renew, forkRuns, holder } =
		await slowCopy("fork-claim-renews");
	const scheduled = vi.spyOn(globalThis, "setTimeout");
	const assertUnreferenced = () => {
		let renewals = 0;
		for (const [index, result] of scheduled.mock.results.entries()) {
			if (scheduled.mock.calls[index]?.[1] !== QUARTER_WINDOW_MS) continue;
			assert.ok(result.type === "return");
			assert.equal(result.value.hasRef(), false, "background renewal must not keep the host process alive");
			renewals++;
		}
		assert.ok(renewals > 0);
	};
	try {
		const forking = fork();
		await entered;
		assertUnreferenced();
		const forkHolder = await holder();
		assert.ok(forkHolder?.startsWith("fork:"));
		await vi.advanceTimersByTimeAsync(3 * 60_000);
		assert.equal(renew.mock.calls.length, 8, "two checks before the copy, then one renewal every quarter window");
		assertUnreferenced();
		const resume = await backend.journal.takeoverExpired(runId, "resumer", 120_000);
		assert.equal(resume.status, "held", "after 180 s the claim is still the fork's");
		assert.equal(await holder(), forkHolder);
		open();
		const forked = await forking;
		assert.equal((await forkRuns()).length, 1);
		assert.ok(forked.runId);
		assert.equal(release.mock.calls.length, 1);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		assert.equal(renew.mock.calls.length, 9, "one more check before the write, and none once the claim is released");
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		scheduled.mockRestore();
		vi.useRealTimers();
	}
});

test("a lease this process already holds is kept alive during the fork and left to its holder afterwards (#4321)", async () => {
	const { backend, runId, fork, open, entered, release, renew, holder, forkRuns } = await slowCopy("fork-claim-own", {
		ownLease: true,
	});
	try {
		const own = await holder();
		assert.equal(own, backend.holderId);
		const forking = fork();
		await entered;
		await vi.advanceTimersByTimeAsync(3 * 60_000);
		assert.equal(renew.mock.calls.length, 8);
		assert.equal((await backend.journal.takeoverExpired(runId, "resumer", 120_000)).status, "held");
		open();
		await forking;
		assert.equal((await forkRuns()).length, 1);
		assert.equal(release.mock.calls.length, 0, "the lease was not the fork's to release");
		assert.equal(await holder(), own);
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		vi.useRealTimers();
	}
});

test("a takeover the renewal timer finds stops the fork before it writes, and its copies are removed (#4321)", async () => {
	const { backend, runId, fork, open, entered, release, copyKept, forkRuns, holder } =
		await slowCopy("fork-claim-lost");
	try {
		const write = vi.spyOn(backend.journal, "createRunWithEvents");
		const forking = fork();
		await entered;
		const forkHolder = (await holder())!;
		const taken = await backend.journal.takeover(runId, "resumer", forkHolder);
		assert.equal(taken.status, "acquired");
		await vi.advanceTimersByTimeAsync(QUARTER_WINDOW_MS);
		open();
		const error = await forking.catch((problem: Error) => problem);
		assert.ok(error instanceof ForkSourceBusyError, String(error));
		assert.deepEqual([error.reason, error.retryable], ["lease-lost", true]);
		assert.equal(write.mock.calls.length, 0, "nothing was written");
		assert.equal(await copyKept(), false);
		assert.equal((await forkRuns()).length, 0);
		assert.equal(release.mock.calls.length, 0, "a claim that was lost is not released over its new holder");
		assert.equal(await holder(), "resumer");
		assert.equal(claimsOf(pendingForks, backend).has(runId), false);
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		vi.useRealTimers();
	}
});

test("the check before the write catches a takeover no renewal saw, and never writes a mixed snapshot (#4321)", async () => {
	const { backend, runId, fork, open, entered, copyKept, forkRuns, holder } =
		await slowCopy("fork-claim-stale-holder");
	try {
		const write = vi.spyOn(backend.journal, "createRunWithEvents");
		const forking = fork();
		await entered;
		await backend.journal.takeover(runId, "resumer", (await holder())!);
		open();
		const error = await forking.catch((problem: Error) => problem);
		assert.ok(error instanceof ForkSourceBusyError, String(error));
		assert.equal(error.reason, "lease-lost");
		assert.ok(error.cause instanceof StaleLeaseError, "the stale lease is the cause");
		assert.equal(write.mock.calls.length, 0);
		assert.equal(await copyKept(), false);
		assert.equal((await forkRuns()).length, 0);
	} finally {
		vi.useRealTimers();
	}
});

test("a journal that cannot renew is retried and logged once, and a failed check before the write is a retryable ForkJournalUnavailableError (#4321)", async () => {
	const { fork, open, entered, renew, realRenew, copyKept, forkRuns } = await slowCopy("fork-claim-journal");
	try {
		const unavailable = new StorageUnavailableError({ adapter: "memory", location: ":memory:" }, new Error("reset"));
		const real = realRenew;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const forking = fork();
		await entered;
		renew.mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable);
		await vi.advanceTimersByTimeAsync(2 * QUARTER_WINDOW_MS);
		assert.equal(warn.mock.calls.length, 1, "two failed renewals in a row are logged once");
		const [logged] = warn.mock.calls[0]!;
		assert.ok(logged instanceof ForkJournalUnavailableError);
		assert.deepEqual([logged.phase, logged.retryable, logged.cause], ["claim", true, unavailable]);
		await vi.advanceTimersByTimeAsync(QUARTER_WINDOW_MS);
		assert.equal(warn.mock.calls.length, 1, "the next renewal succeeded");
		renew.mockImplementation(real);
		renew.mockRejectedValueOnce(unavailable);
		open();
		const error = await forking.catch((problem: Error) => problem);
		assert.ok(error instanceof ForkJournalUnavailableError, String(error));
		assert.deepEqual([error.phase, error.retryable, error.cause], ["claim", true, unavailable]);
		assert.equal(await copyKept(), false);
		assert.equal((await forkRuns()).length, 0);
	} finally {
		vi.useRealTimers();
	}
});

test("a stale lease that crossed a realm boundary is still a lost source, by name and never by message (#4321)", async () => {
	const { fork, open, entered, renew, copyKept, forkRuns } = await slowCopy("fork-claim-foreign-realm");
	try {
		const forking = fork();
		await entered;
		const stale = Object.assign(new Error("some other wording"), { name: "StaleLeaseError" });
		renew.mockRejectedValueOnce(stale);
		open();
		const error = await forking.catch((problem: Error) => problem);
		assert.ok(error instanceof ForkSourceBusyError, String(error));
		assert.deepEqual([error.reason, error.cause], ["lease-lost", stale]);
		assert.equal(await copyKept(), false);
		assert.equal((await forkRuns()).length, 0);
	} finally {
		vi.useRealTimers();
	}
});

test("a renewal that fails unexpectedly is logged once with its cause, while the check before the write rethrows it unchanged (#4321)", async () => {
	const { fork, open, entered, renew, copyKept, forkRuns } = await slowCopy("fork-claim-unexpected");
	try {
		const unexpected = new TypeError("renew misbehaved");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const forking = fork();
		await entered;
		renew.mockRejectedValueOnce(unexpected).mockRejectedValueOnce(unexpected);
		await vi.advanceTimersByTimeAsync(2 * QUARTER_WINDOW_MS);
		assert.equal(warn.mock.calls.length, 1, "a streak of unexpected failures is logged once");
		const [logged] = warn.mock.calls[0]!;
		assert.ok(logged instanceof ForkJournalUnavailableError);
		assert.deepEqual([logged.phase, logged.retryable, logged.cause], ["claim", true, unexpected]);
		renew.mockRejectedValueOnce(unexpected);
		open();
		assert.equal(
			await forking.catch((problem: unknown) => problem),
			unexpected,
			"the foreground failure is not wrapped",
		);
		assert.equal(await copyKept(), false);
		assert.equal((await forkRuns()).length, 0);
	} finally {
		vi.useRealTimers();
	}
});

test("a check whose renewal committed but whose reply is late still fails when a periodic renewal found the takeover meanwhile (#4321)", async () => {
	const { backend, runId, fork, open, entered, renew, realRenew, holder, copyKept, forkRuns } =
		await slowCopy("fork-claim-late-reply");
	try {
		const write = vi.spyOn(backend.journal, "createRunWithEvents");
		const real = realRenew;
		let committed!: () => void;
		const renewed = new Promise<void>((resolve) => {
			committed = resolve;
		});
		let reply!: () => void;
		const late = new Promise<void>((resolve) => {
			reply = resolve;
		});
		const forking = fork();
		await entered;
		const forkHolder = (await holder())!;
		renew.mockImplementationOnce(async (lease) => {
			await real(lease);
			committed();
			await late;
		});
		open();
		await renewed;
		assert.equal((await backend.journal.takeover(runId, "resumer", forkHolder)).status, "acquired");
		await vi.advanceTimersByTimeAsync(QUARTER_WINDOW_MS);
		reply();
		const error = await forking.catch((problem: Error) => problem);
		assert.ok(error instanceof ForkSourceBusyError, String(error));
		assert.equal(error.reason, "lease-lost");
		assert.equal(write.mock.calls.length, 0, "the write never started");
		assert.equal(await copyKept(), false);
		assert.equal((await forkRuns()).length, 0);
	} finally {
		vi.useRealTimers();
	}
});

test("a failure of the renewal timer's own report does not stop the release, and is reported once it was attempted (#4321)", async () => {
	const { backend, runId, fork, open, entered, renew, release, forkRuns } = await slowCopy("fork-claim-report-fails");
	try {
		const sink = new Error("log sink failed");
		const warn = vi
			.spyOn(console, "warn")
			.mockImplementationOnce(() => {
				throw sink;
			})
			.mockImplementation(() => undefined);
		const forking = fork();
		await entered;
		renew.mockRejectedValueOnce(new Error("journal hiccup"));
		await vi.advanceTimersByTimeAsync(QUARTER_WINDOW_MS);
		open();
		await forking;
		assert.equal((await forkRuns()).length, 1, "the fork was written");
		assert.equal(release.mock.calls.length, 1, "the journal release was still attempted");
		assert.equal(claimsOf(pendingForks, backend).has(runId), false, "and the local claim cleared");
		assert.equal(vi.getTimerCount(), 0);
		const reported = warn.mock.calls.at(-1)![0];
		assert.ok(reported instanceof ForkClaimReleaseError, String(reported));
		assert.equal(reported.cause, sink);
	} finally {
		vi.useRealTimers();
	}
});

/**
 * A source with three stage sessions whose first `load` or `create` waits until `open()`, on a controlled
 * journal clock and timers: the fork is stopped inside its read loop or its copy loop.
 */
async function threeSessions(seed: string, gated: "load" | "create") {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const def = workflow({ name: seed, description: "", inputs: {}, outputs: {}, run: async () => ({}) });
	const runId = testRunId(seed);
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: def.name,
		inputs: {},
		status: "paused",
		createdAt: 1,
		invocationCwd: process.cwd(),
	});
	for (const name of ["one", "two", "three"]) {
		const session = await SessionManager.create(sessions, process.cwd());
		await session.appendMessage({ role: "user", content: name, timestamp: 1 });
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: `stage:${name}`,
			name,
			replayKey: name,
			sessionId: session.getSessionId(),
			output: name,
			completedAt: 2,
		});
	}
	const held = (await backend.journal.leaseState(runId))!;
	await backend.journal.release({ runId, holderId: held.holderId, epoch: held.epoch });
	let open!: () => void;
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const operations = { load: 0, create: 0 };
	const load = MemorySessionStore.prototype.load.bind(sessions);
	const create = MemorySessionStore.prototype.create.bind(sessions);
	vi.spyOn(sessions, "load").mockImplementation(async (...args) => {
		if (++operations.load === 1 && gated === "load") {
			enter();
			await gate;
		}
		return load(...args);
	});
	vi.spyOn(sessions, "create").mockImplementation(async (...args) => {
		if (++operations.create === 1 && gated === "create") {
			enter();
			await gate;
		}
		return create(...args);
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const renew = vi.spyOn(backend.journal, "renew");
	const fork = () =>
		forkDurableRun(backend, {
			source: "sdk",
			runId,
			carryMessages: "before",
			definition: def,
			sessionStore: sessions,
			sourceSessionStore: sessions,
		});
	const stealLease = async () => {
		const forkHolder = (await backend.journal.leaseState(runId))!.holderId;
		await backend.journal.takeover(runId, "resumer", forkHolder);
		await vi.advanceTimersByTimeAsync(QUARTER_WINDOW_MS);
	};
	const forkRuns = async () => (await backend.journal.listRuns()).filter((entry) => entry.runId !== runId);
	const stored = async () => {
		let count = 0;
		for await (const _summary of sessions.list({ includeInternal: true })) count++;
		return count;
	};
	return { backend, runId, fork, open, entered, operations, renew, stealLease, forkRuns, stored };
}

test("a lost lease stops the source reads before the next session is loaded, not only at the final check (#4321)", async () => {
	const { fork, open, entered, operations, renew, stealLease, forkRuns } = await threeSessions(
		"fork-claim-read-loop",
		"load",
	);
	try {
		const forking = fork();
		await entered;
		await stealLease();
		const renewals = renew.mock.calls.length;
		open();
		const error = await forking.catch((problem: Error) => problem);
		assert.ok(error instanceof ForkSourceBusyError, String(error));
		assert.equal(error.reason, "lease-lost");
		assert.equal(operations.load, 1, "the second and third sessions were never loaded");
		assert.equal(operations.create, 0, "nothing was copied");
		assert.equal(renew.mock.calls.length, renewals, "a source known to be lost is not renewed again");
		assert.equal((await forkRuns()).length, 0);
	} finally {
		vi.useRealTimers();
	}
});

test("a lost lease stops the session copy before the next session is created, and removes what was copied (#4321)", async () => {
	const { fork, open, entered, operations, renew, stealLease, forkRuns, stored } = await threeSessions(
		"fork-claim-copy-loop",
		"create",
	);
	try {
		const forking = fork();
		await entered;
		assert.equal(operations.load, 3, "every session was read under the claim");
		await stealLease();
		const renewals = renew.mock.calls.length;
		open();
		const error = await forking.catch((problem: Error) => problem);
		assert.ok(error instanceof ForkSourceBusyError, String(error));
		assert.equal(error.reason, "lease-lost");
		assert.equal(operations.create, 1, "the second and third sessions were never created");
		assert.equal(renew.mock.calls.length, renewals, "a source known to be lost is not renewed again");
		assert.equal(await stored(), 3, "the one copy made was removed");
		assert.equal((await forkRuns()).length, 0);
	} finally {
		vi.useRealTimers();
	}
});

test("a lost lease is not logged as a renewal failure and ends the renewals while the fork is still blocked (#4321)", async () => {
	const { backend, runId, fork, open, entered, renew, holder } = await slowCopy("fork-claim-lost-quiet");
	try {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const forking = fork();
		await entered;
		await backend.journal.takeover(runId, "resumer", (await holder())!);
		await vi.advanceTimersByTimeAsync(QUARTER_WINDOW_MS);
		assert.equal(warn.mock.calls.length, 0, "the loss is thrown by the check, not logged");
		assert.equal(vi.getTimerCount(), 0, "no renewal is scheduled for a lost claim");
		const renewals = renew.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		assert.equal(renew.mock.calls.length, renewals);
		open();
		assert.ok((await forking.catch((problem: unknown) => problem)) instanceof ForkSourceBusyError);
		assert.equal(renew.mock.calls.length, renewals, "the check before the write did not renew a lost claim");
	} finally {
		vi.useRealTimers();
	}
});

test("renewal failures are logged once per streak: a renewal that succeeds starts a new streak (#4321)", async () => {
	const { fork, open, entered, renew } = await slowCopy("fork-claim-streaks");
	try {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const forking = fork();
		await entered;
		renew.mockRejectedValueOnce(new Error("first streak"));
		await vi.advanceTimersByTimeAsync(QUARTER_WINDOW_MS);
		assert.equal(warn.mock.calls.length, 1);
		await vi.advanceTimersByTimeAsync(QUARTER_WINDOW_MS);
		assert.equal(warn.mock.calls.length, 1, "a renewal that succeeds logs nothing");
		renew.mockRejectedValueOnce(new Error("second streak"));
		await vi.advanceTimersByTimeAsync(QUARTER_WINDOW_MS);
		assert.equal(warn.mock.calls.length, 2, "the next failure is a new streak");
		open();
		await forking;
	} finally {
		vi.useRealTimers();
	}
});

test("releasing while a renewal's reply is in flight leaves no timer and no later renewal (#4321)", async () => {
	const { fork, open, entered, renew, realRenew, release, copyKept } = await slowCopy("fork-claim-release-in-flight");
	try {
		const real = realRenew;
		let reply!: () => void;
		const late = new Promise<void>((resolve) => {
			reply = resolve;
		});
		const reason = new Error("caller cancelled");
		const controller = new AbortController();
		let settled = false;
		const forking = fork(controller.signal).finally(() => {
			settled = true;
		});
		const outcome = forking.catch((problem: unknown) => problem);
		await entered;
		renew.mockImplementationOnce(async (lease) => {
			await real(lease);
			await late;
		});
		await vi.advanceTimersByTimeAsync(QUARTER_WINDOW_MS);
		controller.abort(reason);
		open();
		await vi.advanceTimersByTimeAsync(10);
		assert.equal(settled, false, "the release waits for the renewal in flight");
		reply();
		assert.equal(await outcome, reason);
		assert.equal(release.mock.calls.length, 1);
		assert.equal(vi.getTimerCount(), 0, "the renewal that finished after the release did not schedule another");
		const renewals = renew.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		assert.equal(renew.mock.calls.length, renewals);
		assert.equal(await copyKept(), false);
	} finally {
		vi.useRealTimers();
	}
});

test("a report that fails does not stop the renewals, and its failure is combined with a failed release in order (#4321)", async () => {
	const { backend, runId, fork, open, entered, renew, release, forkRuns } = await slowCopy("fork-claim-aggregate");
	try {
		const sink = new Error("log sink failed");
		const releaseFailure = new Error("release refused");
		const warn = vi
			.spyOn(console, "warn")
			.mockImplementationOnce(() => {
				throw sink;
			})
			.mockImplementation(() => undefined);
		release.mockRejectedValueOnce(releaseFailure);
		const forking = fork();
		await entered;
		renew.mockRejectedValueOnce(new Error("journal hiccup"));
		await vi.advanceTimersByTimeAsync(QUARTER_WINDOW_MS);
		const renewals = renew.mock.calls.length;
		await vi.advanceTimersByTimeAsync(QUARTER_WINDOW_MS);
		assert.equal(renew.mock.calls.length, renewals + 1, "the next renewal was still scheduled");
		open();
		await forking;
		assert.equal((await forkRuns()).length, 1);
		assert.equal(claimsOf(pendingForks, backend).has(runId), false, "the local claim was cleared");
		const reported = warn.mock.calls.at(-1)![0];
		assert.ok(reported instanceof ForkClaimReleaseError, String(reported));
		assert.ok(reported.cause instanceof AggregateError);
		assert.deepEqual(reported.cause.errors, [sink, releaseFailure]);
		assert.equal(reported.cause.message, "The claim was not released");
	} finally {
		vi.useRealTimers();
	}
});

test("a cancelled fork rejects with the exact reason, stops its renewals and releases the claim once (#4321)", async () => {
	const source = await slowCopy("fork-claim-cancelled");
	try {
		const reason = new Error("caller cancelled");
		const controller = new AbortController();
		const forking = source.fork(controller.signal);
		await source.entered;
		await vi.advanceTimersByTimeAsync(QUARTER_WINDOW_MS);
		controller.abort(reason);
		source.open();
		assert.equal(await forking.catch((problem: unknown) => problem), reason);
		assert.equal(source.release.mock.calls.length, 1);
		assert.equal(vi.getTimerCount(), 0);
		const renewals = source.renew.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		assert.equal(source.renew.mock.calls.length, renewals, "no renewal after the claim was released");
		assert.equal(await source.copyKept(), false);
	} finally {
		vi.useRealTimers();
	}
});

test("cancellation during the final claim renewal rejects its exact reason before any fork write (#4321)", async () => {
	const source = await slowCopy("fork-cancel-final-renewal");
	const controller = new AbortController();
	const reason = new Error("caller cancelled during the final renewal");
	const renew = source.realRenew;
	try {
		source.renew.mockImplementation(async (lease) => {
			await renew(lease);
			if (source.renew.mock.calls.length === 3) controller.abort(reason);
		});
		const write = vi.spyOn(source.backend.journal, "createRunWithEvents");
		const forking = source.fork(controller.signal).catch((error: unknown) => error);
		await source.entered;
		source.open();
		assert.equal(await forking, reason);
		assert.equal(write.mock.calls.length, 0);
		assert.deepEqual(await source.forkRuns(), []);
		assert.equal(await source.copyKept(), false);
		assert.equal(source.release.mock.calls.length, 1);
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		source.open();
		vi.useRealTimers();
	}
});

test("a journal storage failure is a ForkJournalUnavailableError that says whether a retry is safe (#4321)", async () => {
	const { backend, def, runId } = await linearSource("fork-journal-unavailable");
	const request = {
		source: "sdk" as const,
		runId,
		fromStage: "implement",
		carryMessages: "before" as const,
		definition: def,
	};
	const sourceEvents = await journalEvents(backend.journal, runId);
	const unavailable = new StorageUnavailableError({ adapter: "memory", location: ":memory:" }, new Error("reset"));
	const failedFork = () =>
		forkDurableRun(backend, request).then(
			() => assert.fail("fork must fail"),
			(failure: Error) => failure,
		);
	const expectUnavailable = (error: Error, phase: "read" | "claim" | "hydrate", cause: Error) => {
		assert.ok(isForkJournalUnavailableError(error), String(error));
		assert.ok(error instanceof ForkJournalUnavailableError);
		assert.deepEqual(
			[error.code, error.phase, error.runId, error.storage, error.cause],
			["journal-unavailable", phase, runId, { adapter: "memory", scope: "local-only" }, cause],
		);
		assert.equal(claimsOf(pendingForks, backend).has(runId), false, "the source claim was released");
		return error;
	};

	vi.spyOn(backend.journal, "getRun").mockRejectedValueOnce(unavailable);
	const read = expectUnavailable(await failedFork(), "read", unavailable);
	assert.deepEqual([read.retryable, read.forkRunId, isRetryableForkError(read)], [true, undefined, true]);
	vi.spyOn(backend.journal, "leaseState").mockRejectedValueOnce(unavailable);
	expectUnavailable(await failedFork(), "claim", unavailable);
	const rollback = new StorageRollbackError(unavailable, new Error("rollback failed"));
	vi.spyOn(backend.journal, "takeoverExpired").mockRejectedValueOnce(rollback);
	const claim = expectUnavailable(await failedFork(), "claim", rollback);
	assert.equal(claim.retryable, true);
	assert.equal((await backend.journal.listRuns()).length, 1, "nothing was written before the copy");

	vi.spyOn(backend, "hydrateWorkflow").mockRejectedValueOnce(unavailable);
	const hydrate = expectUnavailable(await failedFork(), "hydrate", unavailable);
	assert.equal(hydrate.retryable, false, "the fork run exists, so forking again would duplicate it");
	assert.equal(isRetryableForkError(hydrate), false);
	assert.ok(hydrate.forkRunId !== undefined);
	assert.equal((await backend.journal.getRun(hydrate.forkRunId))?.runId, hydrate.forkRunId);
	assert.match(hydrate.hint, new RegExp(`/workflow resume ${hydrate.forkRunId}`));

	const bug = new TypeError("not a storage failure");
	vi.spyOn(backend.journal, "getRun").mockRejectedValueOnce(bug);
	assert.equal(await failedFork(), bug, "other failures are not disguised as storage failures");
	vi.spyOn(backend.journal, "getRun").mockRejectedValueOnce(unavailable);
	const points = await (async () => {
		for await (const point of durableForkPoints(backend, runId)) return point;
	})().catch((failure: Error) => failure);
	expectUnavailable(points as Error, "read", unavailable);

	assert.deepEqual(await journalEvents(backend.journal, runId), sourceEvents, "the source run is unchanged");
	const recovered = await forkDurableRun(backend, request);
	assert.equal(recovered.forkedFrom.stagePath, "implement");
});

test("a session missing from the store the caller passed is a ForkSessionNotFoundError that says so, before anything is written (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const def = workflow({ name: "lost-session", description: "", inputs: {}, outputs: {}, run: async () => ({}) });
	const runId = testRunId("fork-lost-session");
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: def.name,
		inputs: {},
		status: "paused",
		createdAt: 1,
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: "stage:saved",
		name: "saved",
		replayKey: "saved",
		sessionId: "missing-session",
		output: "saved",
		completedAt: 2,
	});
	const created = vi.spyOn(sessions, "create");
	const error = await forkDurableRun(backend, {
		source: "sdk",
		runId,
		carryMessages: "before",
		definition: def,
		sessionStore: sessions,
		sourceSessionStore: sessions,
	}).catch((failure: Error) => failure);
	assert.ok(isForkSessionNotFoundError(error));
	assert.ok(error instanceof ForkSessionNotFoundError);
	assert.equal(error.code, "session-not-found");
	assert.equal(error.sessionId, "missing-session");
	assert.deepEqual([error.storage, error.storeSource], [{ adapter: "memory", scope: "local-only" }, "supplied"]);
	assert.equal(
		error.hint,
		"The store passed as sourceSessionStore does not hold it; pass the session store of the project that ran the run.",
	);
	assert.equal(created.mock.calls.length, 0);
	assert.equal((await backend.journal.listRuns()).length, 1);
	const failing = new MemorySessionStore();
	const outage = Object.assign(new Error("Storage unavailable: sessions"), { name: "StorageUnavailableError" });
	vi.spyOn(failing, "load").mockRejectedValueOnce(outage);
	const unavailable = await forkDurableRun(backend, {
		source: "sdk",
		runId,
		carryMessages: "before",
		definition: def,
		sessionStore: sessions,
		sourceSessionStore: failing,
	}).catch((failure: Error) => failure);
	assert.ok(isForkSessionUnavailableError(unavailable), String(unavailable));
	assert.ok(unavailable instanceof ForkSessionUnavailableError);
	assert.deepEqual(
		[unavailable.code, unavailable.retryable, unavailable.sessionId, unavailable.runId, unavailable.cause],
		["session-unavailable", true, "missing-session", runId, outage],
	);
	vi.spyOn(failing, "load").mockRejectedValueOnce(
		new StorageUnavailableError({ adapter: "libsql", location: "sessions" }, new Error("reset")),
	);
	const coreOutage = await forkDurableRun(backend, {
		source: "sdk",
		runId,
		carryMessages: "before",
		definition: def,
		sessionStore: sessions,
		sourceSessionStore: failing,
	}).catch((failure: Error) => failure);
	assert.ok(coreOutage instanceof ForkSessionUnavailableError, String(coreOutage));
	vi.spyOn(failing, "load").mockRejectedValueOnce(new StorageRollbackError(new Error("write"), new Error("rollback")));
	const rolledBack = await forkDurableRun(backend, {
		source: "sdk",
		runId,
		carryMessages: "before",
		definition: def,
		sessionStore: sessions,
		sourceSessionStore: failing,
	}).catch((failure: Error) => failure);
	assert.ok(rolledBack instanceof ForkSessionUnavailableError, String(rolledBack));
	const lookalike = { name: "SessionNotFoundError", message: "not an Error" };
	vi.spyOn(failing, "load").mockRejectedValueOnce(lookalike);
	const passedThrough = await forkDurableRun(backend, {
		source: "sdk",
		runId,
		carryMessages: "before",
		definition: def,
		sessionStore: sessions,
		sourceSessionStore: failing,
	}).catch((failure: Error) => failure);
	assert.equal(passedThrough, lookalike, "a rejection that is not an Error is passed through as it is");
	const bug = new TypeError("not a session store failure");
	vi.spyOn(failing, "load").mockRejectedValueOnce(bug);
	const propagated = await forkDurableRun(backend, {
		source: "sdk",
		runId,
		carryMessages: "before",
		definition: def,
		sessionStore: sessions,
		sourceSessionStore: failing,
	}).catch((failure: Error) => failure);
	assert.equal(propagated, bug);
	assert.equal((await backend.journal.listRuns()).length, 1, "nothing was written by any of them");
});

test("a session missing from the source project's own store names that project and the join command (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const projects = mkdtempSync(join(tmpdir(), "fork-project-store-"));
	try {
		const def = workflow({
			name: "project-session",
			description: "",
			inputs: {},
			outputs: {},
			run: async () => ({}),
		});
		const runId = testRunId("fork-project-session");
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: def.name,
			inputs: {},
			status: "paused",
			createdAt: 1,
			invocationCwd: projects,
		});
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: "stage:saved",
			name: "saved",
			replayKey: "saved",
			sessionId: "missing-session",
			output: "saved",
			completedAt: 2,
		});
		const error = await forkDurableRun(backend, {
			source: "sdk",
			runId,
			carryMessages: "before",
			definition: def,
			sessionStore: new MemorySessionStore(),
		}).catch((failure: Error) => failure);
		assert.ok(error instanceof ForkSessionNotFoundError, String(error));
		assert.equal(error.storeSource, "project");
		assert.equal(error.storage?.scope, "local-only");
		assert.match(
			error.hint,
			/not joined to the shared storage; run atomic team join <url> --token-file <path>, or fork from the project that ran the run/,
		);
	} finally {
		rmSync(projects, { recursive: true, force: true });
	}
});

test("a journal run without a run record is not found, with the journal it was read from (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const runId = testRunId("fork-headless-run");
	await backend.journal.createRun({ runId, name: "headless", cwd: process.cwd(), createdAt: 1, status: "paused" });
	const error = await forkDurableRun(backend, { source: "sdk", runId, carryMessages: "before" }).catch(
		(failure: Error) => failure,
	);
	assert.ok(error instanceof ForkSourceNotFoundError, String(error));
	assert.deepEqual(
		[error.runId, error.reason, error.storage],
		[runId, "not-found", { adapter: "memory", scope: "local-only" }],
	);
});

test("a nested run id is reported as a nested run of its root, never as storage that is not joined (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const child = workflow({
		name: "nested-child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("step", {}, async () => "done");
			return {};
		},
	});
	const def = workflow({
		name: "nested-root",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.workflow(child, { stageName: "child" });
			return {};
		},
	});
	const runId = testRunId("fork-nested-root");
	const store = createStore();
	assert.equal((await run(def, {}, { runId, durableBackend: backend, store })).status, "completed");
	const childId = store.runs().find((snapshot) => snapshot.parentRunId === runId)!.id;
	const expectNotRoot = (error: Error) => {
		assert.ok(isForkSourceNotFoundError(error), String(error));
		assert.ok(error instanceof ForkSourceNotFoundError);
		assert.deepEqual([error.reason, error.rootRunId, error.storage], ["not-root", runId, undefined]);
		assert.equal(error.hint, `Fork the root run ${runId}; listForkPoints("${runId}") lists the nested stage paths.`);
		assert.doesNotMatch(error.message, /atomic team join/);
	};
	const refused = (options: Parameters<typeof forkRun>[1]) =>
		forkRun(childId, options).then(
			() => assert.fail("a nested run is not forked"),
			(error: Error) => error,
		);
	expectNotRoot(await refused({ durableBackend: backend, definition: def, store }));
	expectNotRoot(
		(await (async () => {
			for await (const point of listForkPoints(childId, { durableBackend: backend, store })) return point;
		})().catch((error: Error) => error)) as Error,
	);
	const unknown = await refused({ durableBackend: backend, definition: def, store: createStore() });
	assert.ok(unknown instanceof ForkSourceNotFoundError);
	assert.equal(unknown.reason, "not-found", "a store that never saw the nested run cannot tell it apart");
	assert.deepEqual(unknown.storage, { adapter: "memory", scope: "local-only" });
	assert.equal(
		unknown.hint,
		"This node uses a local-only journal and is not joined to the shared storage; run atomic team join <url> --token-file <path> to fork runs started on other nodes, or pass a root run id from /workflow list (a nested workflow's run is forked through its root run).",
		"the hint names both remedies: joining the shared storage and forking the root run",
	);
	const unlistable = await (async () => {
		for await (const point of listForkPoints(childId, { durableBackend: backend, store: createStore() }))
			return point;
	})().catch((error: Error) => error);
	assert.ok(unlistable instanceof ForkSourceNotFoundError, String(unlistable));
	assert.equal(unlistable.reason, "not-found");
	const selfRooted = createStore();
	selfRooted.recordRunStart({
		id: childId,
		name: child.name,
		inputs: {},
		status: "completed",
		toolNodes: [],
		stages: [],
		startedAt: 1,
		rootRunId: childId,
	});
	const ownRoot = await refused({ durableBackend: backend, definition: def, store: selfRooted });
	assert.ok(ownRoot instanceof ForkSourceNotFoundError);
	assert.equal(ownRoot.reason, "not-found", "a run whose root is itself is not a nested run");
	await backend.commitWorkflowRegistration({
		workflowId: childId,
		name: child.name,
		inputs: {},
		status: "completed",
		createdAt: 1,
		rootWorkflowId: runId,
	});
	expectNotRoot(await refused({ durableBackend: backend, definition: child, store: createStore() }));
	assert.equal((await backend.journal.listRuns()).length, 2, "no fork was written");
});

test("a failed claim release is attached to the primary fork error, never replacing it (#4321)", async () => {
	const { backend, def, runId } = await linearSource("fork-release-fails");
	const releaseFailure = new Error("release failed");
	vi.spyOn(backend.journal, "release").mockRejectedValue(releaseFailure);
	const error = await forkDurableRun(backend, {
		source: "sdk",
		runId,
		fromStage: "nowhere",
		carryMessages: "before",
		definition: def,
	}).catch((failure: Error) => failure);
	assert.ok(error instanceof ForkTargetNotFoundError);
	assert.ok(error.cleanupCause instanceof ForkClaimReleaseError);
	assert.deepEqual(
		[error.cleanupCause.code, error.cleanupCause.runId, error.cleanupCause.cause],
		["claim-release-failed", runId, releaseFailure],
	);
});

test("a fork without fromStage replays every recorded stage, so replacement inputs reach only tool calls whose arguments use them (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const counters = { fixed: 0, tagged: 0, completions: [] as string[] };
	const def = workflow({
		name: "fork-whole-run",
		description: "",
		inputs: { tag: Type.String({ default: "v1" }) },
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("fixed", {}, async () => {
				counters.fixed++;
				return "fixed";
			});
			const tagged = await ctx.tool("tagged", { tag: ctx.inputs.tag }, async () => {
				counters.tagged++;
				return `tagged ${ctx.inputs.tag}`;
			});
			await ctx.stage("build").complete(`build ${tagged}`);
			return {};
		},
	});
	const runId = testRunId("fork-whole-run");
	const options = { durableBackend: backend, cwd: process.cwd(), adapters: complete(counters.completions) };
	const source = await run(def, { tag: "v1" }, { ...options, runId, store: createStore() });
	assert.equal(source.status, "completed", source.error);
	const forked = await forkRun(runId, { ...options, inputs: { tag: "v2" }, definition: def, store: createStore() });
	const result = await forked.result;
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(forked.forkedFrom, { runId });
	assert.deepEqual(backend.getWorkflow(forked.runId)?.inputs, { tag: "v2" });
	assert.deepEqual(
		[counters.fixed, counters.tagged, counters.completions],
		[1, 2, ["build tagged v1"]],
		"no stage ran again; only the tool whose arguments changed did",
	);
});

test("a fork carries the source's workspace and snapshot bindings through its launch (#4321)", async () => {
	const { backend, def, runId } = await linearSource("fork-bindings");
	const binding = { remotes: ["git@github.com:acme/product.git"], head: "a1", tree: "t1", envHash: "e1" };
	const workspace = { ...binding, repository: "acme/product", branch: "feat/x", worktree: "/w", label: "ci" };
	await backend.commitWorkflowRegistration({
		...backend.getWorkflow(runId)!,
		workspace,
		snapshot: binding,
	});
	const forked = await forkRun(runId, {
		fromStage: "implement",
		durableBackend: backend,
		definition: def,
		store: createStore(),
		adapters: complete([]),
		ui: promptUi([], []),
	});
	assert.equal((await forked.result).status, "completed");
	assert.deepEqual(backend.getWorkflow(forked.runId)?.workspace, workspace);
	assert.deepEqual(backend.getWorkflow(forked.runId)?.snapshot, binding);
	assert.equal(backend.toMetadata(forked.runId)?.workspace?.label, "ci");
});

test("forkRun events mirror run()'s notifications and still reach the caller's callbacks (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	let mode: "ok" | "fail" | "exit" = "ok";
	const def = workflow({
		name: "fork-events",
		description: "",
		inputs: {},
		outputs: { done: Type.String() },
		run: async (ctx) => {
			await ctx.stage("plan").complete("plan");
			if (mode === "exit") ctx.exit({ status: "completed", reason: "stopped early" });
			await ctx.stage("ship").complete("ship");
			if (mode === "fail") throw new Error("ship failed");
			return { done: "yes" };
		},
	});
	const runId = testRunId("fork-events-source");
	await run(def, {}, { runId, durableBackend: backend, store: createStore(), adapters: complete([]) });
	const fork = async (fromStage: string) => {
		const calls: string[] = [];
		const forked = await forkRun(runId, {
			fromStage,
			durableBackend: backend,
			definition: def,
			store: createStore(),
			adapters: complete([]),
			onRunStart: (snapshot) => calls.push(`run_start:${snapshot.id}`),
			onStageStart: (id, stage) => calls.push(`stage_start:${id}:${stage.name}`),
			onStageEnd: (id, stage) => calls.push(`stage_end:${id}:${stage.name}`),
			onRunEnd: (id, status, result, error, exitReason) =>
				calls.push(`run_end:${id}:${status}:${JSON.stringify(result)}:${error}:${exitReason}`),
		});
		const events = [];
		for await (const event of forked.events) events.push(event);
		return { forked, calls, events, result: await forked.result };
	};
	const ok = await fork("ship");
	assert.equal(ok.result.status, "completed");
	const id = ok.forked.runId;
	const shape = ok.events.map((event) =>
		event.type === "run_start"
			? `run_start:${event.run.id}`
			: event.type === "stage_start" || event.type === "stage_end"
				? `${event.type}:${event.runId}:${event.stage.name}`
				: event.type === "run_end"
					? `run_end:${event.runId}:${event.status}:${JSON.stringify(event.result)}:${event.error}:${event.exitReason}`
					: event.type,
	);
	assert.deepEqual(shape, ok.calls, "events and callbacks report the same notifications");
	assert.equal(shape[0], `run_start:${id}`);
	assert.ok(shape.includes(`stage_start:${id}:ship`) && shape.includes(`stage_end:${id}:ship`));
	assert.equal(shape.at(-1), `run_end:${id}:completed:{"done":"yes"}:undefined:undefined`);
	const end = ok.events.at(-1)!;
	assert.ok(end.type === "run_end");
	assert.deepEqual(Object.keys(end).sort(), ["result", "runId", "status", "type"]);
	mode = "fail";
	const failed = await fork("ship");
	assert.equal(failed.result.status, "failed");
	const failedEnd = failed.events.at(-1)!;
	assert.ok(failedEnd.type === "run_end");
	assert.match(failedEnd.error ?? "", /ship failed/);
	assert.equal("result" in failedEnd, false);
	assert.equal("exitReason" in failedEnd, false);
	mode = "exit";
	const exited = await fork("plan");
	const exitEnd = exited.events.at(-1)!;
	assert.ok(exitEnd.type === "run_end");
	assert.equal(exitEnd.exitReason, "stopped early");
});

test("listForkPoints reads entry ids from the session store it is given (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const session = await SessionManager.create(sessions, process.cwd());
	await session.appendMessage({ role: "user", content: "saved", timestamp: 1 });
	const runId = testRunId("fork-points-store");
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "w",
		inputs: {},
		status: "completed",
		createdAt: 1,
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: "stage:s",
		name: "s",
		replayKey: "stage:s:1",
		output: { name: "s", stageName: "s", text: "done", sessionId: session.getSessionId() },
		completedAt: 5,
	});
	const points = [];
	for await (const point of listForkPoints(runId, {
		durableBackend: backend,
		sourceSessionStore: sessions,
		cwd: "/x",
	}))
		points.push(point);
	assert.deepEqual(points, [
		{
			stagePath: "s",
			sessionId: session.getSessionId(),
			entryId: (await sessions.load(session.getSessionId())).entries.at(-1)!.id,
			completedAt: 5,
		},
	]);
	await assert.rejects(async () => {
		for await (const _ of listForkPoints("", { durableBackend: backend })) assert.fail("no points");
	}, ForkConfigError);
});
