import assert from "node:assert/strict";
import { isToolDetachmentError, isWorkspaceBindingError, ToolDetachmentError } from "@bastani/atomic";
import { test } from "vitest";
import { applyFailureToStage } from "../../packages/workflows/src/runs/foreground/executor-lifecycle.js";
import { MAX_CAUSE_DEPTH } from "../../packages/workflows/src/shared/error-cause-chain.js";
import {
	readSerializedError,
	rehydrateError,
	type SerializedError,
	serializeError,
} from "../../packages/workflows/src/shared/error-codec.js";
import { SERIALIZABLE_ERROR_FAMILIES } from "../../packages/workflows/src/shared/serializable-error-families.js";
import {
	isStageWaitError,
	StageRehydrationError,
	StageReleaseError,
	StageWaitError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { typedFailureDetail } from "../../packages/workflows/src/shared/typed-failure-detail.js";
import { PoolProtocolError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { classifyWorkflowFailure } from "../../packages/workflows/src/shared/workflow-failures-classifier.js";
import type { WorkerRequest } from "../../packages/workflows/src/workers/protocol.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { assertSameFamilyError, FAMILY_CASES, SERIALIZABLE_FAMILY_CASES } from "./serializable-error-family-cases.js";

useTemporaryAgentDir();

/** What the root reads after a worker sends `result` over its IPC channel, which encodes messages as JSON. */
function throughWorkerProtocol(detail: SerializedError | undefined): unknown {
	const message: WorkerRequest = {
		id: 1,
		kind: "complete",
		result: {
			runId: "child",
			status: "failed",
			error: "failed",
			...(detail === undefined ? {} : { failureDetail: detail }),
			stages: [],
			toolNodes: [],
		},
	};
	const received = JSON.parse(JSON.stringify(message)) as { readonly result: { readonly failureDetail?: unknown } };
	return received.result.failureDetail;
}

function read(value: unknown): Error {
	const reading = readSerializedError(value);
	assert.equal(reading.ok, true, reading.ok ? "" : `${reading.error.field}: ${reading.error.expected}`);
	return reading.error;
}

function refusal(value: unknown): PoolProtocolError {
	const reading = readSerializedError(value);
	assert.equal(reading.ok, false, `read as ${reading.error.name}`);
	return reading.error as PoolProtocolError;
}

test.each(FAMILY_CASES)(
	"a $family error a stage failed on crosses the worker protocol and rehydrates as itself (#4378)",
	(kase) => {
		const original = kase.make();
		// The stage's failure wraps the typed error; the detail is found down its cause chain.
		const detail = typedFailureDetail(
			new Error("stage failed", { cause: new Error("turn failed", { cause: original }) }),
		);
		assert.equal(detail?.family, kase.family);

		const rebuilt = read(throughWorkerProtocol(detail));

		assertSameFamilyError(rebuilt, original, kase);
	},
);

test("each family with its own JSON form is named by its envelope and has a crossing case (#4378)", () => {
	assert.deepEqual(
		SERIALIZABLE_FAMILY_CASES.map((kase) => kase.family).sort(),
		Object.keys(SERIALIZABLE_ERROR_FAMILIES).sort(),
	);
	for (const kase of SERIALIZABLE_FAMILY_CASES) assert.equal(serializeError(kase.make()).family, kase.family);
});

/** The family the codec carries the errors of each exported rehydration as, the codec's own `rehydrateError` aside. */
const REHYDRATION_FAMILIES: Readonly<Record<string, string>> = {
	deserializeStageWaitError: "stage-wait",
	deserializeToolDetachmentError: "tool-detachment",
	rehydrateGitProvisionError: "git-provision",
	rehydrateWorkflowGitRequiredError: "git-required",
	rehydrateWorkspaceError: "workspace",
	rehydrateSessionStartError: "session-start",
	rehydrateDecisionError: "decision",
	rehydrateTaskEvictedError: "task-evicted",
	rehydrateAgentRehydrateError: "agent-rehydrate",
	rehydrateBackgroundCompactionError: "background-compaction",
	deserializeGitHubCopilotError: "github-copilot",
	rehydrateDebugError: "debug",
	rehydrateEditToolError: "edit-tool",
	rehydrateWriteSelectorError: "write-selector",
	rehydrateShellToolError: "shell-tool",
	rehydrateLlamaServerError: "llama-server",
	rehydrateStartupBenchmarkError: "startup-benchmark",
	// Team profile errors are storage errors, and cross with the storage family.
	rehydrateStorageError: "storage",
	rehydrateTeamError: "storage",
	rehydrateJournalStoreError: "journal-store",
	rehydrateForkError: "fork",
	rehydrateTaskCleanupError: "task-cleanup",
	rehydrateWorkerPlacementError: "worker-placement",
	rehydrateWorkflowInfrastructureError: "workflow-infrastructure",
};

test("every error family @bastani/atomic and its workflows can rehydrate crosses the worker protocol through the codec (#4378)", async () => {
	const atomic = await import("@bastani/atomic");
	const workflows = await import("../../packages/workflows/src/sdk-surface.js");
	const exported = new Set(
		[...Object.keys(atomic), ...Object.keys(workflows)].filter((name) =>
			/^(rehydrate|deserialize)\w+Error$/.test(name),
		),
	);

	assert.deepEqual([...exported].sort(), Object.keys(REHYDRATION_FAMILIES).sort());
	const codecFamilies = new Set<string | undefined>([
		...FAMILY_CASES.map((kase) => serializeError(kase.make()).family),
		"journal-store",
		"fork",
		"task-cleanup",
	]);
	for (const [rehydration, family] of Object.entries(REHYDRATION_FAMILIES))
		assert.ok(codecFamilies.has(family), `${rehydration}: ${family}`);
});

test("a family error keeps a typed cause typed, and its own JSON form's other members in extra (#4378)", () => {
	const gitRequired = SERIALIZABLE_FAMILY_CASES.find((kase) => kase.family === "git-required")!.make();
	const sent = serializeError(gitRequired);
	assert.equal(sent.cause?.family, "git-provision");
	assert.equal(Object.hasOwn(sent, "extra"), false, "a form with no other members has no extra");

	const workspace = serializeError(SERIALIZABLE_FAMILY_CASES.find((kase) => kase.family === "workspace")!.make());
	assert.deepEqual(workspace.extra, { reason: "history-rewritten" });
	const rebuilt = rehydrateError(JSON.parse(JSON.stringify(workspace)));
	assert.ok(isWorkspaceBindingError(rebuilt));
	assert.equal(rebuilt.reason, "history-rewritten");

	const compaction = serializeError(
		SERIALIZABLE_FAMILY_CASES.find((kase) => kase.family === "background-compaction")!.make(),
	);
	assert.deepEqual(compaction.extra, { phase: "persist" });
});

test("the detail is the first error of a known family in the chain, outermost first, with what is below it (#4378)", () => {
	const inner = new StageReleaseError("stage-busy", { stageId: "stage-1", stageName: "review" });
	const outer = new ToolDetachmentError("stage-parked", { sessionId: "session-1" }, { cause: inner });

	const rebuilt = read(throughWorkerProtocol(typedFailureDetail(new Error("wrapper", { cause: outer }))));

	assert.ok(isToolDetachmentError(rebuilt));
	assert.ok(rebuilt.cause instanceof StageReleaseError);
	assert.equal(rebuilt.cause.code, "stage-busy");
});

test("a rehydrated StageRehydrationError keeps the store failure it wraps, with its code (#4309)", () => {
	const original = new StageRehydrationError(
		{ runId: "run-1", stageId: "stage-1", stageName: "review", sessionId: "session-1" },
		{ cause: Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }) },
	);

	const cause = read(throughWorkerProtocol(typedFailureDetail(original))).cause as Error & { readonly code?: string };

	assert.ok(cause instanceof Error);
	assert.equal(cause.message, "database is locked");
	assert.equal(cause.code, "SQLITE_BUSY");
});

test("an error rebuilt without a cause gets none, and its cleanup cause comes back beside it (#4378)", () => {
	const plain = read(serializeError(new StageReleaseError("stage-busy", { stageName: "review" })));
	assert.equal(Object.hasOwn(plain, "cause"), false);

	const failed = Object.assign(new StageReleaseError("stage-busy", { stageName: "review" }), {
		cleanupCause: new ToolDetachmentError("session-closed", { sessionId: "session-1" }),
	});
	const rebuilt = read(JSON.parse(JSON.stringify(serializeError(failed)))) as Error & { cleanupCause?: unknown };
	assert.ok(rebuilt.cleanupCause instanceof ToolDetachmentError);
});

test("a family error's envelope holds only the members its form has, and its rebuilt cause is a native one (#4378)", () => {
	const sent = serializeError(new StageReleaseError("stage-busy", { stageName: "review", stageId: undefined }));
	assert.deepEqual(Object.keys(sent).sort(), ["code", "family", "fields", "hint", "message", "name", "retryable"]);
	assert.deepEqual(sent.fields, { stageName: "review" });

	const native = Object.getOwnPropertyDescriptor(new Error("failed", { cause: new Error("cause") }), "cause");
	const rebuilt = read(serializeError(SERIALIZABLE_FAMILY_CASES[0]!.make()));
	const descriptor = Object.getOwnPropertyDescriptor(rebuilt, "cause");
	assert.ok(descriptor?.value instanceof Error);
	assert.deepEqual({ ...descriptor, value: undefined }, { ...native, value: undefined });
});

test("a family error's causes and cleanup causes are bounded as any chain's are (#4378)", () => {
	const deep = (levels: number): Error => {
		let error = new Error("bottom");
		for (let level = 0; level < levels; level++) error = new Error(`level ${level}`, { cause: error });
		return error;
	};
	const length = (envelope: SerializedError | undefined): number =>
		envelope === undefined ? 0 : 1 + length(envelope.cause);
	const failed = Object.assign(new ToolDetachmentError("session-busy", { sessionId: "s" }, { cause: deep(20) }), {
		cleanupCause: deep(20),
	});

	const sent = serializeError(failed);

	assert.equal(length(sent), MAX_CAUSE_DEPTH);
	assert.equal(length(sent.cleanupCause), MAX_CAUSE_DEPTH - 1);
});

test("an error without a known family in its chain, a cancellation included, has no failure detail (#4309, #4378)", () => {
	assert.equal(typedFailureDetail(new Error("plain", { cause: new Error("still plain") })), undefined);
	assert.equal(typedFailureDetail("text"), undefined);
	assert.equal(typedFailureDetail(new DOMException("The operation was aborted", "AbortError")), undefined);
	assert.equal(typedFailureDetail({ name: "StageReleaseError", code: "stage-busy" }), undefined, "a copy is no error");
});

test("a stage-wait error of a name this side does not know rehydrates as the family base, keeping name and code (#4309)", () => {
	const detail = serializeError(new StageReleaseError("stage-busy", { stageId: "stage-1", stageName: "review" }));

	const rebuilt = read({ ...detail, name: "StageFutureError", code: "future-code" });

	assert.ok(rebuilt instanceof StageWaitError);
	const { name, code, fields }: { name: string; code: string; fields: object } = rebuilt;
	assert.deepEqual(
		[name, code, fields],
		["StageFutureError", "future-code", { stageId: "stage-1", stageName: "review" }],
	);
});

test("a tool-detachment error of a name this side does not know rehydrates as its family base (#4309)", () => {
	const detail = serializeError(new ToolDetachmentError("session-busy", { sessionId: "session-1" }));

	const rebuilt = read({ ...detail, name: "ToolDetachmentFutureError", code: "future-code" });

	assert.ok(rebuilt instanceof ToolDetachmentError);
	assert.equal(isStageWaitError(rebuilt), false);
	const { name, code, fields }: { name: string; code: string; fields: object } = rebuilt;
	assert.deepEqual([name, code, fields], ["ToolDetachmentFutureError", "future-code", { sessionId: "session-1" }]);
});

const valid = serializeError(new StageReleaseError("not-reopenable", { stageName: "review" }));

test("a family envelope without a code, or one its family refuses, is refused naming the member (#4378)", () => {
	const noCode = refusal({ ...valid, code: undefined });
	assert.deepEqual([noCode.field, noCode.expected], ["error.code", "a stage-wait error code"]);

	const copilot = serializeError(FAMILY_CASES.find((kase) => kase.family === "github-copilot")!.make());
	const unknownCode = refusal({ ...copilot, code: "not-a-copilot-code" });
	assert.deepEqual(
		[unknownCode.field, unknownCode.expected],
		["error", "a github-copilot error its family can rebuild"],
	);

	const gitRequired = serializeError(FAMILY_CASES.find((kase) => kase.family === "git-required")!.make());
	const withoutGit = refusal({ ...gitRequired, cause: undefined });
	assert.deepEqual([withoutGit.field, withoutGit.expected], ["error", "a git-required error its family can rebuild"]);
});

test("a family whose rehydration throws on what it received refuses it, keeping what it threw as the cause (#4378)", () => {
	const thrown = new Error("fields would not read");
	const fields = new Proxy(
		{},
		{
			get() {
				throw thrown;
			},
		},
	);

	const refused = refusal({ ...valid, fields });

	assert.deepEqual([refused.field, refused.expected], ["error", "a stage-wait error its family can rebuild"]);
	assert.equal(refused.cause, thrown);
});

test("extra members that are not a JSON object are refused (#4378)", () => {
	for (const extra of [[1], "reason", null, { reason: Number.NaN }, { nested: { value: () => 1 } }]) {
		const refused = refusal({ ...valid, extra });
		assert.deepEqual(
			[refused.field, refused.expected],
			["error.extra", "an object of JSON strings, finite numbers, booleans, nulls, arrays or objects"],
			JSON.stringify(extra),
		);
	}
	assert.ok(
		read({ ...valid, extra: { reason: "kept", list: [1, "a", null, { ok: true }] } }) instanceof StageReleaseError,
	);
});

const MALFORMED: readonly (readonly [string, unknown])[] = [
	["null", null],
	["a string", "StageReleaseError"],
	["an array", [valid]],
	["the old shape's family", { ...valid, family: "StageWaitError" }],
	["an unknown family", { ...valid, family: "future-family" }],
	["a numeric name", { ...valid, name: 7 }],
	["a non-boolean retryable", { ...valid, retryable: "yes" }],
	["null fields", { ...valid, fields: null }],
	["a cause without a message", { ...valid, cause: { name: "Error", fields: {} } }],
];

test.each(MALFORMED)("a malformed failure detail (%s) is refused, never thrown (#4309)", (_label, detail) => {
	const refused = refusal(JSON.parse(JSON.stringify({ detail })).detail);
	assert.ok(refused instanceof PoolProtocolError);
	assert.equal(refused.code, "pool_protocol_invalid");
});

test("a failure detail that describes a PoolProtocolError is read as one, not refused (#4378)", () => {
	const reading = readSerializedError(serializeError(new PoolProtocolError({ field: "x", expected: "y" })));
	assert.equal(reading.ok, true);
	assert.ok(reading.error instanceof PoolProtocolError);
	assert.equal(reading.error.field, "x");
});

test("a failure detail whose cause chain never ends keeps only the bounded chain (#4309)", () => {
	let cause: Record<string, unknown> = { name: "Error", message: "bottom", fields: {} };
	for (let depth = 0; depth < 100; depth++) cause = { name: "Error", message: `level ${depth}`, fields: {}, cause };

	assert.ok(read({ ...valid, cause }) instanceof StageReleaseError);
});

test("URL credentials in the text of a family error's plain cause never reach the detail (#4378)", () => {
	const SENTINEL = "SENTINEL-TOKEN";
	const original = new StageRehydrationError(
		{ runId: "run-1", stageId: "stage-1", stageName: "review", sessionId: "session-1" },
		{
			cause: new Error(`connect https://user:${SENTINEL}@db.example/x failed`, {
				cause: `git+ssh://u:${SENTINEL}@h`,
			}),
		},
	);

	const detail = typedFailureDetail(original);

	assert.equal(JSON.stringify(detail).includes(SENTINEL), false, JSON.stringify(detail));
	const rebuilt = read(throughWorkerProtocol(detail));
	assert.equal((rebuilt.cause as Error).message, "connect https://db.example/x failed");
	assert.equal(((rebuilt.cause as Error).cause as Error).message, "git+ssh://h");
});

test("a stage ended from another copy of its snapshot, as on a resumed run, keeps its failure detail in the store (#4309)", () => {
	const store = createStore();
	const restored: StageSnapshot = { id: "stage-1", name: "review", status: "running", parentIds: [], toolEvents: [] };
	store.recordRunStart({
		id: "run-1",
		name: "resumed",
		inputs: {},
		status: "running",
		stages: [restored],
		toolNodes: [],
		startedAt: 1,
	});
	const live: StageSnapshot = { ...restored, toolEvents: [] };
	applyFailureToStage(
		live,
		classifyWorkflowFailure(
			new StageRehydrationError({ runId: "run-1", stageId: "stage-1", stageName: "review", sessionId: "s" }),
		),
	);

	store.recordStageEnd("run-1", live);

	assert.equal(store.run("run-1")?.stages[0]?.failureDetail?.name, "StageRehydrationError");
});
