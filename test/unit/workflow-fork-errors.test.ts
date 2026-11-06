import assert from "node:assert/strict";
import { test } from "vitest";
import {
	FORK_ERROR_MAX_CAUSE_DEPTH,
	ForkClaimReleaseError,
	ForkCleanupError,
	ForkConfigError,
	ForkCopyFailedError,
	ForkDefinitionMismatchError,
	ForkEntryNotFoundError,
	ForkError,
	type ForkErrorFields,
	ForkJournalUnavailableError,
	ForkJournalUnsupportedError,
	ForkPoolSessionsUnavailableError,
	ForkSessionClaimError,
	type ForkSessionClaimReason,
	ForkSessionNotFoundError,
	ForkSessionUnavailableError,
	ForkSourceBusyError,
	ForkSourceNotFoundError,
	ForkSourceOwnershipError,
	ForkTargetNotFoundError,
	findForkError,
	isForkClaimReleaseError,
	isForkCleanupError,
	isForkConfigError,
	isForkCopyFailedError,
	isForkDefinitionMismatchError,
	isForkEntryNotFoundError,
	isForkError,
	isForkJournalUnavailableError,
	isForkJournalUnsupportedError,
	isForkPoolSessionsUnavailableError,
	isForkSessionClaimError,
	isForkSessionNotFoundError,
	isForkSessionUnavailableError,
	isForkSourceBusyError,
	isForkSourceNotFoundError,
	isForkSourceOwnershipError,
	isForkTargetNotFoundError,
	isRetryableForkError,
	type KnownForkError,
	rehydrateForkError,
	type SerializedForkError,
	serializeForkError,
} from "../../packages/workflows/src/durable/fork-errors.js";
import * as sdk from "../../packages/workflows/src/sdk-surface.js";

const runId = "3f2a0c1e-0000-4000-8000-000000000001";
const forkRunId = "9b1d0c1e-0000-4000-8000-000000000002";
const join = "atomic team join <url> --token-file <path>";

interface Case {
	readonly error: KnownForkError;
	readonly message: string;
	readonly hint: string;
	readonly fields: ForkErrorFields;
}

function assertCases(cases: readonly Case[]): void {
	for (const { error, message, hint, fields } of cases) {
		assert.equal(error.message, message);
		assert.equal(error.hint, hint);
		assert.deepEqual(error.fields, fields);
		assert.ok(error.message.endsWith(` (${error.code}). ${error.hint}`));
	}
}

const many = Array.from({ length: 12 }, (_, index) => `stage-${index}`);

test("ForkTargetNotFoundError renders the paths it lists as a stable message and hint (#4321)", () => {
	const listed = many.slice(0, 10).join(", ");
	assertCases([
		{
			error: new ForkTargetNotFoundError({ runId, fromStage: "x.y", validStagePaths: many }),
			message: `Fork target not found: stage "x.y" in run ${runId} (target-not-found). Pass one of: ${listed} (and 2 more); listForkPoints("${runId}") lists them all.`,
			hint: `Pass one of: ${listed} (and 2 more); listForkPoints("${runId}") lists them all.`,
			fields: { runId, fromStage: "x.y", validStagePaths: many.slice(0, 10), totalValidStagePaths: 12 },
		},
		{
			error: new ForkTargetNotFoundError({
				runId,
				fromStage: "x",
				validStagePaths: ["a", "b"],
				totalValidStagePaths: 5,
			}),
			message: `Fork target not found: stage "x" in run ${runId} (target-not-found). Pass one of: a, b (and 3 more); listForkPoints("${runId}") lists them all.`,
			hint: `Pass one of: a, b (and 3 more); listForkPoints("${runId}") lists them all.`,
			fields: { runId, fromStage: "x", validStagePaths: ["a", "b"], totalValidStagePaths: 5 },
		},
		{
			error: new ForkTargetNotFoundError({ runId, fromStage: "x", validStagePaths: ["a"] }),
			message: `Fork target not found: stage "x" in run ${runId} (target-not-found). Pass one of: a; listForkPoints("${runId}") lists them all.`,
			hint: `Pass one of: a; listForkPoints("${runId}") lists them all.`,
			fields: { runId, fromStage: "x", validStagePaths: ["a"], totalValidStagePaths: 1 },
		},
		{
			error: new ForkTargetNotFoundError({ runId, fromStage: "x", validStagePaths: [] }),
			message: `Fork target not found: stage "x" in run ${runId} (target-not-found). The run has no completed stage to fork from yet; listForkPoints("${runId}") lists stages once they complete.`,
			hint: `The run has no completed stage to fork from yet; listForkPoints("${runId}") lists stages once they complete.`,
			fields: { runId, fromStage: "x", validStagePaths: [], totalValidStagePaths: 0 },
		},
	]);
});

test("ForkDefinitionMismatchError renders each reason as a stable message and hint (#4321)", () => {
	const pass = `Pass the "goal" definition with the definition option, or register it in the registry option.`;
	assertCases([
		{
			error: new ForkDefinitionMismatchError({ runId, workflow: "goal", reason: "definition-unavailable" }),
			message: `Fork definition mismatch: workflow "goal" of run ${runId} could not be resolved (definition-mismatch). ${pass}`,
			hint: pass,
			fields: { runId, workflow: "goal", reason: "definition-unavailable" },
		},
		{
			error: new ForkDefinitionMismatchError({
				runId,
				workflow: "goal",
				reason: "name-changed",
				definition: "ralph",
			}),
			message: `Fork definition mismatch: definition "ralph" does not match workflow "goal" of run ${runId} (definition-mismatch). ${pass}`,
			hint: pass,
			fields: { runId, workflow: "goal", reason: "name-changed", definition: "ralph" },
		},
		{
			error: new ForkDefinitionMismatchError({ runId, workflow: "goal", reason: "inputs-incompatible" }),
			message: `Fork definition mismatch: the recorded inputs of run ${runId} no longer satisfy workflow "goal" (definition-mismatch). Pass replacement inputs that satisfy the current definition with the inputs option.`,
			hint: "Pass replacement inputs that satisfy the current definition with the inputs option.",
			fields: { runId, workflow: "goal", reason: "inputs-incompatible" },
		},
	]);
});

test("ForkSourceBusyError renders each reason as a stable message and hint (#4321)", () => {
	const retry = "Retry after the other fork or resume finishes.";
	const quit = `Pause or quit the run (/workflow quit ${runId}), then fork it.`;
	const leaseLost = `The fork lost its source claim before writing. Check /workflow status ${runId} and retry once the source is paused or idle.`;
	assertCases([
		{
			error: new ForkSourceBusyError({ runId, reason: "fork-in-progress" }),
			message: `Fork source busy: run ${runId} is already being forked (source-busy). ${retry}`,
			hint: retry,
			fields: { runId, reason: "fork-in-progress" },
		},
		{
			error: new ForkSourceBusyError({ runId, reason: "resume-in-progress" }),
			message: `Fork source busy: run ${runId} is being resumed (source-busy). ${retry}`,
			hint: retry,
			fields: { runId, reason: "resume-in-progress" },
		},
		{
			error: new ForkSourceBusyError({ runId, reason: "live-execution" }),
			message: `Fork source busy: run ${runId} is executing in this process (source-busy). ${quit}`,
			hint: quit,
			fields: { runId, reason: "live-execution" },
		},
		{
			error: new ForkSourceBusyError({ runId, reason: "lease-lost" }),
			message: `Fork source busy: run ${runId} no longer matches this fork's lease claim (source-busy). ${leaseLost}`,
			hint: leaseLost,
			fields: { runId, reason: "lease-lost" },
		},
		{
			error: new ForkSourceBusyError({ runId, reason: "foreign-lease", holderId: "host-b" }),
			message: `Fork source busy: run ${runId} is held by another Atomic process (source-busy). ${quit}`,
			hint: quit,
			fields: { runId, reason: "foreign-lease", holderId: "host-b" },
		},
	]);
});

test("a ForkSourceBusyError keeps its cause across the wire (#4321)", () => {
	const cause = Object.assign(new Error("Stale lease for run"), { name: "StaleLeaseError" });
	const busy = new ForkSourceBusyError({ runId, reason: "lease-lost" }, { cause });
	assert.equal(busy.cause, cause);
	const back = rehydrateForkError(JSON.parse(JSON.stringify(busy)) as SerializedForkError);
	assert.ok(back instanceof ForkSourceBusyError);
	assert.deepEqual(
		[back.reason, back.retryable, back.cause instanceof Error && back.cause.name],
		["lease-lost", true, "StaleLeaseError"],
	);
});

test("ForkEntryNotFoundError renders the entry and stage as a stable message and hint (#4321)", () => {
	const hint = "Pass an entry id from that session, for example a fork point's entryId from listForkPoints().";
	assertCases([
		{
			error: new ForkEntryNotFoundError({ sessionId: "s-1", entryId: "e-9", stageName: "retry-impl" }),
			message: `Fork entry not found: entry e-9 in session s-1 for stage "retry-impl" (entry-not-found). ${hint}`,
			hint,
			fields: { sessionId: "s-1", entryId: "e-9", stageName: "retry-impl" },
		},
		{
			error: new ForkEntryNotFoundError({ sessionId: "s-1", entryId: "e-9" }),
			message: `Fork entry not found: entry e-9 in session s-1 (entry-not-found). ${hint}`,
			hint,
			fields: { sessionId: "s-1", entryId: "e-9" },
		},
	]);
});

test("ForkSessionNotFoundError renders the session, where the store came from and the step that fixes it (#4321)", () => {
	const owningProject =
		"from the project that ran the run (with forkRun, pass that project's session store as sourceSessionStore)";
	const local = `This node reads sessions from local-only jsonl storage and is not joined to the shared storage; run ${join}, or fork ${owningProject}.`;
	const elsewhere = `Fork ${owningProject}.`;
	const supplied =
		"The store passed as sourceSessionStore does not hold it; pass the session store of the project that ran the run.";
	assertCases([
		{
			error: new ForkSessionNotFoundError({
				sessionId: "s-1",
				runId,
				stagePath: "plan",
				storage: { adapter: "jsonl", scope: "local-only" },
				storeSource: "project",
			}),
			message: `Fork session not found: session s-1 of stage "plan" in run ${runId} (session-not-found). ${local}`,
			hint: local,
			fields: {
				sessionId: "s-1",
				runId,
				stagePath: "plan",
				storage: { adapter: "jsonl", scope: "local-only" },
				storeSource: "project",
			},
		},
		{
			error: new ForkSessionNotFoundError({
				sessionId: "s-1",
				storage: { adapter: "libsql", scope: "shared" },
				storeSource: "project",
			}),
			message: `Fork session not found: session s-1 (session-not-found). ${elsewhere}`,
			hint: elsewhere,
			fields: { sessionId: "s-1", storage: { adapter: "libsql", scope: "shared" }, storeSource: "project" },
		},
		{
			error: new ForkSessionNotFoundError({ sessionId: "s-1", runId, storeSource: "project" }),
			message: `Fork session not found: session s-1 in run ${runId} (session-not-found). ${elsewhere}`,
			hint: elsewhere,
			fields: { sessionId: "s-1", runId, storeSource: "project" },
		},
		{
			error: new ForkSessionNotFoundError({
				sessionId: "s-1",
				runId,
				storage: { adapter: "memory", scope: "local-only" },
				storeSource: "supplied",
			}),
			message: `Fork session not found: session s-1 in run ${runId} (session-not-found). ${supplied}`,
			hint: supplied,
			fields: {
				sessionId: "s-1",
				runId,
				storage: { adapter: "memory", scope: "local-only" },
				storeSource: "supplied",
			},
		},
	]);
});

test("ForkSessionUnavailableError renders the session, its store and when to retry (#4321)", () => {
	const retry =
		"Nothing was written and the source run is unchanged; retry once the session store is reachable. atomic storage status shows the storage in use.";
	const cause = new Error("Storage unavailable: libsql at libsql://sessions");
	assertCases([
		{
			error: new ForkSessionUnavailableError(
				{ sessionId: "s-1", runId, stagePath: "plan", storage: { adapter: "libsql", scope: "shared" } },
				{ cause },
			),
			message: `Fork session unavailable: reading session s-1 of stage "plan" in run ${runId} from the shared libsql session store (session-unavailable). ${retry}`,
			hint: retry,
			fields: { sessionId: "s-1", runId, stagePath: "plan", storage: { adapter: "libsql", scope: "shared" } },
		},
		{
			error: new ForkSessionUnavailableError({ sessionId: "s-1" }, { cause }),
			message: `Fork session unavailable: reading session s-1 (session-unavailable). ${retry}`,
			hint: retry,
			fields: { sessionId: "s-1" },
		},
	]);
	const bare = new ForkSessionUnavailableError({ sessionId: "s-1" }, { cause });
	assert.deepEqual([bare.storage, bare.runId, bare.stagePath, bare.cause], [undefined, undefined, undefined, cause]);
});

test("ForkConfigError renders every invalid option at once as a stable message and hint (#4321)", () => {
	assertCases([
		{
			error: new ForkConfigError({ source: "sdk", field: "carryMessages", expected: `"before" or "all"` }),
			message: `Invalid fork option: sdk option carryMessages (invalid-option). Pass carryMessages as "before" or "all".`,
			hint: `Pass carryMessages as "before" or "all".`,
			fields: {
				source: "sdk",
				field: "carryMessages",
				expected: `"before" or "all"`,
				issues: [{ field: "carryMessages", expected: `"before" or "all"` }],
			},
		},
		{
			error: new ForkConfigError({
				source: "cli",
				issues: [
					{ field: "runId", expected: "a run id" },
					{ field: "fromStage", expected: "one stage path after --from" },
				],
			}),
			message:
				"Invalid fork option: cli arguments runId, fromStage (invalid-option). Pass runId as a run id. Pass fromStage as one stage path after --from.",
			hint: "Pass runId as a run id. Pass fromStage as one stage path after --from.",
			fields: {
				source: "cli",
				field: "runId",
				expected: "a run id",
				issues: [
					{ field: "runId", expected: "a run id" },
					{ field: "fromStage", expected: "one stage path after --from" },
				],
			},
		},
		{
			error: new ForkConfigError({ source: "cli", issues: [{ field: "runId", expected: "a run id" }] }),
			message: "Invalid fork option: cli argument runId (invalid-option). Pass runId as a run id.",
			hint: "Pass runId as a run id.",
			fields: {
				source: "cli",
				field: "runId",
				expected: "a run id",
				issues: [{ field: "runId", expected: "a run id" }],
			},
		},
	]);
});

test("ForkSourceNotFoundError renders each reason, its journal and the join command (#4321)", () => {
	const nested = "pass a root run id from /workflow list (a nested workflow's run is forked through its root run)";
	const local = `This node uses a local-only journal and is not joined to the shared storage; run ${join} to fork runs started on other nodes, or ${nested}.`;
	const list = "Pass a run id from /workflow list, or pass the journal that holds the run with the journal option.";
	const rootList =
		"Pass a root run id from /workflow list (a nested workflow's run is forked through its root run), or pass the journal that holds the run with the journal option.";
	const matches = Array.from({ length: 12 }, (_, index) => `aaaaaaaa-0000-4000-8000-0000000000${10 + index}`);
	assertCases([
		{
			error: new ForkSourceNotFoundError({
				runId,
				reason: "not-found",
				storage: { adapter: "node-sqlite", scope: "local-only" },
			}),
			message: `Fork source not found: no durable root run ${runId} in the local-only node-sqlite journal (source-not-found). ${local}`,
			hint: local,
			fields: { runId, reason: "not-found", matches: [], storage: { adapter: "node-sqlite", scope: "local-only" } },
		},
		{
			error: new ForkSourceNotFoundError({
				runId,
				reason: "not-found",
				storage: { adapter: "libsql", scope: "shared" },
			}),
			message: `Fork source not found: no durable root run ${runId} in the shared libsql journal (source-not-found). ${rootList}`,
			hint: rootList,
			fields: { runId, reason: "not-found", matches: [], storage: { adapter: "libsql", scope: "shared" } },
		},
		{
			error: new ForkSourceNotFoundError({ runId, reason: "not-found" }),
			message: `Fork source not found: no durable root run ${runId} (source-not-found). ${rootList}`,
			hint: rootList,
			fields: { runId, reason: "not-found", matches: [] },
		},
		{
			error: new ForkSourceNotFoundError({ runId: "abc", reason: "malformed" }),
			message: `Fork source not found: "abc" is neither a full run id nor an 8-character prefix (source-not-found). ${list}`,
			hint: list,
			fields: { runId: "abc", reason: "malformed", matches: [] },
		},
		{
			error: new ForkSourceNotFoundError({ runId: "aaaaaaaa", reason: "ambiguous", matches }),
			message: `Fork source not found: prefix "aaaaaaaa" matches ${matches.slice(0, 10).join(", ")} (and 2 more) (source-not-found). Pass the full run id.`,
			hint: "Pass the full run id.",
			fields: { runId: "aaaaaaaa", reason: "ambiguous", matches: matches.slice(0, 10) },
		},
		{
			error: new ForkSourceNotFoundError({ runId: forkRunId, reason: "not-root", rootRunId: runId }),
			message: `Fork source not found: run ${forkRunId} is a nested run of root run ${runId} (source-not-found). Fork the root run ${runId}; listForkPoints("${runId}") lists the nested stage paths.`,
			hint: `Fork the root run ${runId}; listForkPoints("${runId}") lists the nested stage paths.`,
			fields: { runId: forkRunId, reason: "not-root", matches: [], rootRunId: runId },
		},
		{
			error: new ForkSourceNotFoundError({ runId: forkRunId, reason: "not-root" }),
			message: `Fork source not found: run ${forkRunId} is a nested run (source-not-found). Fork its root run; listForkPoints on the root lists the nested stage paths.`,
			hint: "Fork its root run; listForkPoints on the root lists the nested stage paths.",
			fields: { runId: forkRunId, reason: "not-root", matches: [] },
		},
	]);
});

test("ForkSourceOwnershipError renders each reason as a stable message and hint (#4321)", () => {
	const foreign = `Fork it from the session that started it, or ask the user to run /workflow fork ${runId}.`;
	const unavailable = `Ask the user to run /workflow fork ${runId}.`;
	assertCases([
		{
			error: new ForkSourceOwnershipError({ runId, reason: "foreign-owner" }),
			message: `Fork source not owned: run ${runId} belongs to another session (source-not-owned). ${foreign}`,
			hint: foreign,
			fields: { runId, reason: "foreign-owner" },
		},
		{
			error: new ForkSourceOwnershipError({ runId, reason: "owner-unavailable" }),
			message: `Fork source not owned: run ${runId} was started by an agent whose session was not recorded (source-not-owned). ${unavailable}`,
			hint: unavailable,
			fields: { runId, reason: "owner-unavailable" },
		},
	]);
});

test("isForkSourceOwnershipError finds the error in a bounded cause chain, also after a wire round trip (#4321)", () => {
	const owned = new ForkSourceOwnershipError({ runId, reason: "owner-unavailable" });
	const wrap = (cause: unknown, links: number): unknown => {
		let value = cause;
		for (let index = 0; index < links; index++) value = new Error(`wrapper ${index}`, { cause: value });
		return value;
	};
	assert.equal(isForkSourceOwnershipError(wrap(owned, FORK_ERROR_MAX_CAUSE_DEPTH - 1)), true);
	assert.equal(isForkSourceOwnershipError(wrap(owned, FORK_ERROR_MAX_CAUSE_DEPTH)), false);
	assert.equal(
		isForkSourceOwnershipError(wrap({ name: "ForkSourceOwnershipError", code: "source-not-owned" }, 2)),
		true,
	);
	assert.equal(isForkSourceOwnershipError(wrap({ name: "ForkSourceOwnershipError", code: "source-busy" }, 2)), false);
	const wrapped = new ForkCopyFailedError({ runId, forkRunId, phase: "journal" }, { cause: owned });
	const back = rehydrateForkError(JSON.parse(JSON.stringify(wrapped)) as SerializedForkError);
	assert.ok(back instanceof ForkCopyFailedError);
	assert.equal(isForkSourceOwnershipError(back), true);
	const cause = back.cause;
	assert.ok(cause instanceof ForkSourceOwnershipError);
	assert.deepEqual([cause.runId, cause.reason, cause.retryable], [runId, "owner-unavailable", false]);
});

function claimError(reason: ForkSessionClaimReason): ForkSessionClaimError {
	return new ForkSessionClaimError({
		reason,
		sessionId: "copy",
		rootRunId: forkRunId,
		childRunId: "child",
		scope: "workflow:impl:fp:1",
		replayKey: "workflow:impl:fp:1:stage:implement:1",
		stageRunId: "child",
	});
}

test("ForkSessionClaimError renders each reason with the session, forked run and child as a stable message and hint (#4321)", () => {
	const hint = `This enqueue attempt changed no session owners. Inspect /workflow status ${forkRunId} before retrying; resume only with the fork's original journal and session copies. Do not fork again or reassign session owners blindly.`;
	const because: Record<ForkSessionClaimReason, string> = {
		"outside-scope": "its stage is outside the child's scope",
		"owned-by-other-work": "another work owns it",
		"claimed-for-other-stage": "the child's work already took it over for another stage",
		missing: "it is not in the pool tables",
		"not-fork-copy": "it is not a copy the fork made",
		"run-mismatch": "its header names another run than its stage",
	};
	assertCases(
		(Object.keys(because) as ForkSessionClaimReason[]).map((reason) => ({
			error: claimError(reason),
			message: `Fork session claim refused: session copy of forked run ${forkRunId} was not given to child run child because ${because[reason]} (session-claim-refused). ${hint}`,
			hint,
			fields: {
				reason,
				sessionId: "copy",
				rootRunId: forkRunId,
				childRunId: "child",
				scope: "workflow:impl:fp:1",
				replayKey: "workflow:impl:fp:1:stage:implement:1",
				stageRunId: "child",
			},
		})),
	);
	const wrap = (cause: unknown, links: number): unknown => {
		let value = cause;
		for (let index = 0; index < links; index++) value = new Error(`wrapper ${index}`, { cause: value });
		return value;
	};
	assert.equal(isForkSessionClaimError(wrap(claimError("missing"), FORK_ERROR_MAX_CAUSE_DEPTH - 1)), true);
	assert.equal(isForkSessionClaimError(wrap(claimError("missing"), FORK_ERROR_MAX_CAUSE_DEPTH)), false);
	const back = rehydrateForkError(
		JSON.parse(JSON.stringify(claimError("owned-by-other-work"))) as SerializedForkError,
	);
	assert.ok(back instanceof ForkSessionClaimError);
	assert.deepEqual(
		[back.reason, back.sessionId, back.rootRunId, back.childRunId, back.scope, back.replayKey, back.stageRunId],
		[
			"owned-by-other-work",
			"copy",
			forkRunId,
			"child",
			"workflow:impl:fp:1",
			"workflow:impl:fp:1:stage:implement:1",
			"child",
		],
	);
});

test("ForkJournalUnsupportedError and ForkCopyFailedError render stable messages and hints (#4321)", () => {
	const retry = "Retry the fork; the source run was not changed.";
	const cause = new Error("disk full");
	assertCases([
		{
			error: new ForkJournalUnsupportedError(),
			message:
				"Fork journal unsupported: the run journal has no atomic createRunWithEvents (journal-unsupported). Use the SQLite or memory run journal, or implement RunJournal.createRunWithEvents.",
			hint: "Use the SQLite or memory run journal, or implement RunJournal.createRunWithEvents.",
			fields: { capability: "createRunWithEvents" },
		},
		{
			error: new ForkCopyFailedError({ runId, forkRunId, phase: "journal" }, { cause }),
			message: `Fork copy failed: journal events of run ${runId} into ${forkRunId} (copy-failed). ${retry}`,
			hint: retry,
			fields: { runId, forkRunId, phase: "journal" },
		},
		{
			error: new ForkCopyFailedError({ runId, forkRunId, phase: "sessions" }, { cause }),
			message: `Fork copy failed: stage sessions of run ${runId} into ${forkRunId} (copy-failed). ${retry}`,
			hint: retry,
			fields: { runId, forkRunId, phase: "sessions" },
		},
	]);
});

test("ForkPoolSessionsUnavailableError names where each placement keeps the fork's pool tables and how to fork instead (#4357)", () => {
	const fromStage = `fork it from a stage before its child workflows ran with /workflow fork ${runId} --from <stage>`;
	const shared = `Nothing was written. No pool of run ${runId} ran on this journal; ${fromStage}.`;
	const machine = `Nothing was written. Fork run ${runId} on the machine that ran its local workers, or ${fromStage}.`;
	assertCases([
		{
			error: new ForkPoolSessionsUnavailableError({ runId, forkRunId, placement: "shared" }),
			message: `Fork pool sessions unavailable: fork ${forkRunId} of run ${runId} has no pool session tables in the journal, which keeps the pool of a root with shared placement (pool-sessions-unavailable). ${shared}`,
			hint: shared,
			fields: { runId, forkRunId, placement: "shared" },
		},
		{
			error: new ForkPoolSessionsUnavailableError({ runId, forkRunId, placement: "machine" }),
			message: `Fork pool sessions unavailable: fork ${forkRunId} of run ${runId} has no pool session tables in the pool tables this machine keeps for the journal (pool-sessions-unavailable). ${machine}`,
			hint: machine,
			fields: { runId, forkRunId, placement: "machine" },
		},
	]);
	const back = rehydrateForkError(
		JSON.parse(
			JSON.stringify(new ForkPoolSessionsUnavailableError({ runId, forkRunId, placement: "machine" })),
		) as SerializedForkError,
	);
	assert.ok(back instanceof ForkPoolSessionsUnavailableError && isForkPoolSessionsUnavailableError(back));
	assert.deepEqual(
		[back.runId, back.forkRunId, back.placement, back.retryable, back.hint],
		[runId, forkRunId, "machine", false, machine],
	);
});

test("ForkClaimReleaseError renders how long the source stays claimed and when to retry (#4321)", () => {
	const cause = new Error("lease lost");
	assertCases([
		{
			error: new ForkClaimReleaseError({ runId, claimExpiresInMs: 120_000 }, { cause }),
			message: `Fork claim release failed: run ${runId} stays claimed by this fork for up to 120 s (claim-release-failed). Forks and resumes of run ${runId} report it busy until the claim expires; retry them after 120 s.`,
			hint: `Forks and resumes of run ${runId} report it busy until the claim expires; retry them after 120 s.`,
			fields: { runId, claimExpiresInMs: 120_000 },
		},
		{
			error: new ForkClaimReleaseError({ runId, claimExpiresInMs: 1_500 }, { cause }),
			message: `Fork claim release failed: run ${runId} stays claimed by this fork for up to 2 s (claim-release-failed). Forks and resumes of run ${runId} report it busy until the claim expires; retry them after 2 s.`,
			hint: `Forks and resumes of run ${runId} report it busy until the claim expires; retry them after 2 s.`,
			fields: { runId, claimExpiresInMs: 1_500 },
		},
	]);
});

test("ForkCleanupError renders the step that failed, whose it was and what is left to do (#4321)", () => {
	const cause = new Error("EBUSY");
	const unaffected =
		"Nothing to undo: the outcome and the source run are unaffected. If it repeats, check the session storage with atomic storage status.";
	const leftover = `The fork was not created and the source run is unchanged; the leftover copies are internal sessions of run ${forkRunId} that nothing reads, so they can be deleted.`;
	assertCases([
		{
			error: new ForkCleanupError({ runId, step: "close-source-sessions" }, { cause }),
			message: `Fork cleanup failed: the session store read for run ${runId} was not closed (cleanup-failed). ${unaffected}`,
			hint: unaffected,
			fields: { runId, step: "close-source-sessions" },
		},
		{
			error: new ForkCleanupError({ runId, step: "close-destination-sessions", forkRunId }, { cause }),
			message: `Fork cleanup failed: the session store written for fork ${forkRunId} of run ${runId} was not closed (cleanup-failed). ${unaffected}`,
			hint: unaffected,
			fields: { runId, step: "close-destination-sessions", forkRunId },
		},
		{
			error: new ForkCleanupError({ runId, step: "remove-copied-sessions", forkRunId }, { cause }),
			message: `Fork cleanup failed: the stage sessions copied for fork ${forkRunId} of run ${runId} were not removed (cleanup-failed). ${leftover}`,
			hint: leftover,
			fields: { runId, step: "remove-copied-sessions", forkRunId },
		},
		{
			error: new ForkCleanupError({ runId, step: "remove-copied-sessions" }, { cause }),
			message: `Fork cleanup failed: the stage sessions copied for run ${runId} were not removed (cleanup-failed). The fork was not created and the source run is unchanged; the leftover copies are internal sessions of run ${runId} that nothing reads, so they can be deleted.`,
			hint: `The fork was not created and the source run is unchanged; the leftover copies are internal sessions of run ${runId} that nothing reads, so they can be deleted.`,
			fields: { runId, step: "remove-copied-sessions" },
		},
	]);
	const error = new ForkCleanupError({ runId, step: "close-source-sessions" }, { cause });
	assert.deepEqual(
		[error.runId, error.step, error.forkRunId, error.retryable, error.cause],
		[runId, "close-source-sessions", undefined, false, cause],
	);
});

test("ForkJournalUnavailableError renders each phase, its journal and whether to retry or resume (#4321)", () => {
	const status = "atomic storage status shows the storage in use.";
	const retry = `Nothing was written and run ${runId} is unchanged; retry the fork once the journal is reachable. ${status}`;
	const resume = `Fork run ${forkRunId} was written; resume it with /workflow resume ${forkRunId} once the journal is reachable instead of forking again. ${status}`;
	const commit = `Fork run ${forkRunId} may have been written, and its copied stage sessions were kept. Once the journal is reachable, inspect that exact run with /workflow status ${forkRunId} and resume it with /workflow resume ${forkRunId} if it exists. Do not fork run ${runId} again before that check: a missing run does not prove the write will never land. ${status}`;
	const confirmed = `Nothing to do: fork run ${forkRunId} was written and the fork continues. If the journal keeps failing, ${status}`;
	const cause = new Error("Storage unavailable: libsql at libsql://journal");
	const shared = { adapter: "libsql", scope: "shared" } as const;
	const local = { adapter: "node-sqlite", scope: "local-only" } as const;
	assertCases([
		{
			error: new ForkJournalUnavailableError({ runId, phase: "read", storage: shared }, { cause }),
			message: `Fork journal unavailable: reading run ${runId} from the shared libsql journal (journal-unavailable). ${retry}`,
			hint: retry,
			fields: { runId, phase: "read", storage: shared },
		},
		{
			error: new ForkJournalUnavailableError({ runId, phase: "claim", storage: local }, { cause }),
			message: `Fork journal unavailable: claiming run ${runId} in the local-only node-sqlite journal (journal-unavailable). ${retry}`,
			hint: retry,
			fields: { runId, phase: "claim", storage: local },
		},
		{
			error: new ForkJournalUnavailableError({ runId, phase: "commit", forkRunId, storage: shared }, { cause }),
			message: `Fork journal unavailable: writing fork run ${forkRunId} of run ${runId} to the shared libsql journal could not be confirmed (journal-unavailable). ${commit}`,
			hint: commit,
			fields: { runId, phase: "commit", forkRunId, storage: shared },
		},
		{
			error: new ForkJournalUnavailableError(
				{ runId, phase: "commit-confirmed", forkRunId, storage: shared },
				{ cause },
			),
			message: `Fork journal unavailable: writing fork run ${forkRunId} of run ${runId} to the shared libsql journal reported an error, but reading it back confirmed the fork run was written (journal-unavailable). ${confirmed}`,
			hint: confirmed,
			fields: { runId, phase: "commit-confirmed", forkRunId, storage: shared },
		},
		{
			error: new ForkJournalUnavailableError({ runId, phase: "hydrate", forkRunId, storage: shared }, { cause }),
			message: `Fork journal unavailable: loading fork run ${forkRunId} of run ${runId} from the shared libsql journal (journal-unavailable). ${resume}`,
			hint: resume,
			fields: { runId, phase: "hydrate", forkRunId, storage: shared },
		},
	]);
	const read = new ForkJournalUnavailableError({ runId, phase: "read", storage: shared }, { cause });
	const hydrate = new ForkJournalUnavailableError({ runId, phase: "hydrate", forkRunId, storage: shared }, { cause });
	assert.deepEqual([read.retryable, read.forkRunId, read.cause], [true, undefined, cause]);
	assert.deepEqual([hydrate.retryable, hydrate.forkRunId], [false, forkRunId]);
	assert.equal(isRetryableForkError(new Error("wrapped", { cause: hydrate })), false);
	const unconfirmed = new ForkJournalUnavailableError(
		{ runId, phase: "commit", forkRunId, storage: shared },
		{ cause: new AggregateError([cause, new Error("read-back failed")], "write and read-back failed") },
	);
	assert.deepEqual([unconfirmed.retryable, unconfirmed.forkRunId], [false, forkRunId]);
	assert.equal(isRetryableForkError(new Error("wrapped", { cause: unconfirmed })), false);
	const back = rehydrateForkError(JSON.parse(JSON.stringify(unconfirmed)) as SerializedForkError);
	assert.ok(isForkJournalUnavailableError(back) && back instanceof ForkJournalUnavailableError);
	assert.deepEqual([back.phase, back.forkRunId, back.retryable, back.hint], ["commit", forkRunId, false, commit]);
	assert.ok(back.cause instanceof AggregateError);
	assert.deepEqual(
		(back.cause.errors as Error[]).map((failure) => failure.message),
		[cause.message, "read-back failed"],
	);
	const rehydrated = rehydrateForkError(JSON.parse(JSON.stringify(hydrate)) as SerializedForkError);
	assert.ok(rehydrated instanceof ForkJournalUnavailableError);
	assert.deepEqual(
		[rehydrated.runId, rehydrated.phase, rehydrated.forkRunId, rehydrated.storage, rehydrated.retryable],
		[runId, "hydrate", forkRunId, shared, false],
	);
});

const samples: readonly { readonly error: KnownForkError; readonly guard: (value: unknown) => boolean }[] = [
	{
		error: new ForkTargetNotFoundError({ runId, fromStage: "x", validStagePaths: ["a"] }),
		guard: isForkTargetNotFoundError,
	},
	{
		error: new ForkDefinitionMismatchError(
			{ runId, workflow: "goal", reason: "name-changed", definition: "ralph" },
			{ cause: new TypeError("schema") },
		),
		guard: isForkDefinitionMismatchError,
	},
	{ error: new ForkSourceBusyError({ runId, reason: "foreign-lease", holderId: "h" }), guard: isForkSourceBusyError },
	{
		error: new ForkEntryNotFoundError({ sessionId: "s", entryId: "e", stageName: "x" }),
		guard: isForkEntryNotFoundError,
	},
	{
		error: new ForkSessionNotFoundError(
			{
				sessionId: "s",
				runId,
				stagePath: "p",
				storage: { adapter: "jsonl", scope: "local-only" },
				storeSource: "supplied",
			},
			{ cause: new Error("ENOENT") },
		),
		guard: isForkSessionNotFoundError,
	},
	{
		error: new ForkConfigError({ source: "cli", issues: [{ field: "runId", expected: "a run id" }] }),
		guard: isForkConfigError,
	},
	{
		error: new ForkSourceNotFoundError({
			runId,
			reason: "ambiguous",
			matches: ["a", "b"],
			storage: { adapter: "libsql", scope: "shared" },
		}),
		guard: isForkSourceNotFoundError,
	},
	{ error: new ForkJournalUnsupportedError(), guard: isForkJournalUnsupportedError },
	{
		error: new ForkJournalUnavailableError(
			{ runId, phase: "read", storage: { adapter: "libsql", scope: "shared" } },
			{ cause: Object.assign(new Error("fetch failed"), { name: "StorageUnavailableError" }) },
		),
		guard: isForkJournalUnavailableError,
	},
	{
		error: new ForkCopyFailedError(
			{ runId, forkRunId, phase: "journal" },
			{ cause: Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }) },
		),
		guard: isForkCopyFailedError,
	},
	{
		error: new ForkClaimReleaseError({ runId, claimExpiresInMs: 120_000 }, { cause: new Error("lease lost") }),
		guard: isForkClaimReleaseError,
	},
	{
		error: new ForkSessionUnavailableError(
			{ sessionId: "s", runId, stagePath: "p", storage: { adapter: "libsql", scope: "shared" } },
			{ cause: Object.assign(new Error("fetch failed"), { name: "StorageUnavailableError" }) },
		),
		guard: isForkSessionUnavailableError,
	},
	{
		error: new ForkPoolSessionsUnavailableError({ runId, forkRunId, placement: "shared" }),
		guard: isForkPoolSessionsUnavailableError,
	},
	{ error: new ForkSourceOwnershipError({ runId, reason: "foreign-owner" }), guard: isForkSourceOwnershipError },
	{ error: claimError("run-mismatch"), guard: isForkSessionClaimError },
	{
		error: new ForkCleanupError(
			{ runId, step: "remove-copied-sessions", forkRunId },
			{ cause: new AggregateError([new Error("one"), new Error("two")], "2 copied fork sessions were not removed") },
		),
		guard: isForkCleanupError,
	},
];

const guards = samples.map((sample) => sample.guard);

for (const { error, guard } of samples) {
	test(`${error.name} has its typed discriminants and matches only its own guard (#4321)`, () => {
		assert.ok(error instanceof ForkError);
		assert.ok(error instanceof Error);
		assert.ok(isForkError(error));
		assert.equal(error.name, error.constructor.name);
		const retryable = ["source-busy", "copy-failed", "journal-unavailable", "session-unavailable"].includes(
			error.code,
		);
		assert.equal(isRetryableForkError(error), retryable);
		assert.equal(error.retryable, retryable);
		assert.ok(guard({ name: error.name, code: error.code }), "the guard matches across realms by name and code");
		assert.ok(isForkError({ name: error.name, code: error.code }));
		assert.ok(!guard({ name: error.name, code: "other-code" }));
		assert.ok(!isForkError({ name: error.name, code: "other-code" }));
		for (const other of guards) if (other !== guard) assert.equal(other(error), false);
		assert.deepEqual(JSON.parse(JSON.stringify(error.fields)), error.fields, "fields are JSON-safe");
	});

	test(`${error.name} round-trips through its wire form as the same class (#4321)`, () => {
		const wire = JSON.parse(JSON.stringify(error)) as SerializedForkError;
		assert.deepEqual(wire, serializeForkError(error));
		assert.equal(wire.name, error.name);
		assert.equal(wire.code, error.code);
		assert.equal(wire.retryable, error.retryable);
		const rehydrated = rehydrateForkError(wire);
		assert.equal(rehydrated.constructor, error.constructor);
		assert.ok(guard(rehydrated));
		assert.equal(rehydrated.message, error.message);
		assert.equal(rehydrated.hint, error.hint);
		assert.equal(rehydrated.retryable, error.retryable);
		assert.deepEqual(rehydrated.fields, error.fields);
		assert.deepEqual(serializeForkError(rehydrated), wire);
		if (error.cause instanceof Error) {
			assert.ok(rehydrated.cause instanceof Error);
			assert.equal(rehydrated.cause.message, error.cause.message);
			assert.equal(rehydrated.cause.name, error.cause.name);
		} else assert.equal("cause" in rehydrated, false);
	});
}

test("rehydrated fork errors keep their typed fields (#4321)", () => {
	const typed = samples.map(({ error }) => rehydrateForkError(serializeForkError(error)));
	const [target, mismatch, busy, entry, session, config, source, journal, unavailable, copy, released, sessionDown] =
		typed;
	assert.ok(target instanceof ForkTargetNotFoundError);
	assert.deepEqual(
		[target.runId, target.fromStage, target.validStagePaths, target.totalValidStagePaths],
		[runId, "x", ["a"], 1],
	);
	assert.ok(mismatch instanceof ForkDefinitionMismatchError);
	assert.deepEqual(
		[mismatch.runId, mismatch.workflow, mismatch.reason, mismatch.definition],
		[runId, "goal", "name-changed", "ralph"],
	);
	assert.ok(busy instanceof ForkSourceBusyError);
	assert.deepEqual([busy.runId, busy.reason, busy.holderId], [runId, "foreign-lease", "h"]);
	assert.ok(entry instanceof ForkEntryNotFoundError);
	assert.deepEqual([entry.sessionId, entry.entryId, entry.stageName], ["s", "e", "x"]);
	assert.ok(session instanceof ForkSessionNotFoundError);
	assert.deepEqual(
		[session.sessionId, session.runId, session.stagePath, session.storage, session.storeSource],
		["s", runId, "p", { adapter: "jsonl", scope: "local-only" }, "supplied"],
	);
	assert.ok(sessionDown instanceof ForkSessionUnavailableError);
	assert.deepEqual(
		[sessionDown.sessionId, sessionDown.runId, sessionDown.stagePath, sessionDown.storage, sessionDown.retryable],
		["s", runId, "p", { adapter: "libsql", scope: "shared" }, true],
	);
	assert.equal((sessionDown.cause as Error).name, "StorageUnavailableError");
	const sessionDownBare = rehydrateForkError({ ...serializeForkError(sessionDown), cause: undefined });
	assert.match((sessionDownBare.cause as Error).message, /not serialized/);
	const notRoot = rehydrateForkError(
		serializeForkError(new ForkSourceNotFoundError({ runId: forkRunId, reason: "not-root", rootRunId: runId })),
	);
	assert.ok(notRoot instanceof ForkSourceNotFoundError);
	assert.deepEqual([notRoot.reason, notRoot.rootRunId], ["not-root", runId]);
	assert.ok(config instanceof ForkConfigError);
	assert.deepEqual(
		[config.source, config.field, config.expected, config.issues],
		["cli", "runId", "a run id", [{ field: "runId", expected: "a run id" }]],
	);
	assert.ok(source instanceof ForkSourceNotFoundError);
	assert.deepEqual(
		[source.runId, source.reason, source.matches, source.storage],
		[runId, "ambiguous", ["a", "b"], { adapter: "libsql", scope: "shared" }],
	);
	assert.ok(journal instanceof ForkJournalUnsupportedError);
	assert.equal(journal.capability, "createRunWithEvents");
	assert.ok(unavailable instanceof ForkJournalUnavailableError);
	assert.deepEqual(
		[unavailable.runId, unavailable.phase, unavailable.forkRunId, unavailable.storage, unavailable.retryable],
		[runId, "read", undefined, { adapter: "libsql", scope: "shared" }, true],
	);
	assert.equal((unavailable.cause as Error).name, "StorageUnavailableError");
	const unavailableBare = rehydrateForkError({ ...serializeForkError(unavailable), cause: undefined });
	assert.match((unavailableBare.cause as Error).message, /not serialized/);
	const unavailableNoStorage = rehydrateForkError({
		...serializeForkError(unavailable),
		fields: { runId, phase: "claim" },
	});
	assert.ok(unavailableNoStorage instanceof ForkJournalUnavailableError);
	assert.deepEqual(unavailableNoStorage.storage, { adapter: "unknown", scope: "shared" });
	assert.ok(copy instanceof ForkCopyFailedError);
	assert.deepEqual([copy.runId, copy.forkRunId, copy.phase], [runId, forkRunId, "journal"]);
	assert.equal((copy.cause as Error & { code?: string }).code, "SQLITE_BUSY");
	const bare = rehydrateForkError({ ...serializeForkError(copy), cause: undefined });
	assert.ok(bare instanceof ForkCopyFailedError);
	assert.match((bare.cause as Error).message, /not serialized/);
	assert.ok(released instanceof ForkClaimReleaseError);
	assert.deepEqual(
		[released.runId, released.claimExpiresInMs, released.retryable, (released.cause as Error).message],
		[runId, 120_000, false, "lease lost"],
	);
	const releasedBare = rehydrateForkError({ ...serializeForkError(released), cause: undefined, fields: { runId } });
	assert.ok(releasedBare instanceof ForkClaimReleaseError);
	assert.deepEqual(
		[releasedBare.claimExpiresInMs, (releasedBare.cause as Error).message],
		[0, "The release failure's cause was not serialized."],
	);
	const legacyConfig = rehydrateForkError({
		...serializeForkError(config),
		fields: { source: "sdk", field: "cwd", expected: "an existing directory" },
	});
	assert.ok(legacyConfig instanceof ForkConfigError);
	assert.deepEqual(legacyConfig.issues, [{ field: "cwd", expected: "an existing directory" }]);
	const noOptionals = rehydrateForkError(
		serializeForkError(new ForkSessionNotFoundError({ sessionId: "s", storeSource: "project" })),
	);
	assert.ok(noOptionals instanceof ForkSessionNotFoundError);
	assert.deepEqual(
		[noOptionals.runId, noOptionals.stagePath, noOptionals.storage, noOptionals.storeSource],
		[undefined, undefined, undefined, "project"],
	);
	assert.deepEqual(noOptionals.fields, { sessionId: "s", storeSource: "project" });
	const sourceless = rehydrateForkError({ ...serializeForkError(noOptionals), fields: { sessionId: "s" } });
	assert.ok(sourceless instanceof ForkSessionNotFoundError);
	assert.equal(sourceless.storeSource, "project");
	const cleanup = typed.at(-1);
	assert.ok(cleanup instanceof ForkCleanupError);
	assert.deepEqual(
		[cleanup.runId, cleanup.step, cleanup.forkRunId, cleanup.retryable],
		[runId, "remove-copied-sessions", forkRunId, false],
	);
	assert.ok(cleanup.cause instanceof AggregateError);
	assert.deepEqual(
		cleanup.cause.errors.map((error: Error) => error.message),
		["one", "two"],
	);
	const cleanupBare = rehydrateForkError({
		...serializeForkError(cleanup),
		cause: undefined,
		fields: { runId, step: "close-source-sessions" },
	});
	assert.ok(cleanupBare instanceof ForkCleanupError);
	assert.deepEqual(
		[cleanupBare.step, cleanupBare.forkRunId, (cleanupBare.cause as Error).message],
		["close-source-sessions", undefined, "The cleanup failure's cause was not serialized."],
	);
});

test("rehydration keeps every issue, count and cause, and tolerates missing fields (#4321)", () => {
	const config = new ForkConfigError(
		{
			source: "sdk",
			issues: [
				{ field: "runId", expected: "a run id" },
				{ field: "cwd", expected: "an existing directory" },
			],
		},
		{ cause: new Error("ENOENT") },
	);
	const rehydratedConfig = rehydrateForkError(serializeForkError(config));
	assert.ok(rehydratedConfig instanceof ForkConfigError);
	assert.deepEqual(rehydratedConfig.issues, config.issues);
	assert.equal((rehydratedConfig.cause as Error).message, "ENOENT");
	const target = new ForkTargetNotFoundError({
		runId,
		fromStage: "x",
		validStagePaths: many,
		totalValidStagePaths: 14,
	});
	const rehydratedTarget = rehydrateForkError(serializeForkError(target));
	assert.ok(rehydratedTarget instanceof ForkTargetNotFoundError);
	assert.deepEqual([rehydratedTarget.validStagePaths, rehydratedTarget.totalValidStagePaths], [many.slice(0, 10), 14]);
	const empty = rehydrateForkError({
		name: "ForkTargetNotFoundError",
		code: "target-not-found",
		message: "",
		retryable: false,
		fields: {},
	});
	assert.ok(empty instanceof ForkTargetNotFoundError);
	assert.deepEqual([empty.runId, empty.fromStage, empty.validStagePaths, empty.totalValidStagePaths], ["", "", [], 0]);
	const codeless = rehydrateForkError(
		serializeForkError(new ForkCopyFailedError({ runId, forkRunId, phase: "sessions" }, { cause: new Error("x") })),
	);
	assert.equal(Object.hasOwn(codeless.cause as Error, "code"), false, "a cause without a code gets none");
	assert.equal(new ForkSourceNotFoundError({ runId, reason: "not-found" }).storage, undefined);
	assert.equal(isForkTargetNotFoundError({ name: "ForkSourceBusyError", code: "target-not-found" }), false);
});

test("guards reject values that are not fork errors (#4321)", () => {
	for (const value of [
		undefined,
		null,
		"ForkTargetNotFoundError",
		7,
		new Error("plain"),
		{ name: "toString", code: "x" },
	])
		for (const guard of [isForkError, ...guards]) assert.equal(guard(value), false, String(value));
	assert.equal(isForkError({ name: "ForkFutureError", code: "future" }), false);
	assert.equal(isRetryableForkError({ name: "ForkSourceBusyError", code: "source-busy", retryable: false }), false);
	assert.equal(isRetryableForkError({ name: "ForkSourceBusyError", code: "source-busy", retryable: true }), true);
	assert.equal(isRetryableForkError(null), false);
	assert.equal(isRetryableForkError(new Error("x", { cause: "not an object" })), false);
});

test("findForkError and isRetryableForkError walk causes up to the bounded depth only (#4321)", () => {
	const busy = new ForkSourceBusyError({ runId, reason: "fork-in-progress" });
	const wrap = (error: Error, depth: number): Error => {
		let current = error;
		for (let index = 0; index < depth; index++) current = new Error(`wrapper ${index}`, { cause: current });
		return current;
	};
	assert.equal(findForkError(busy), busy);
	assert.equal(findForkError(wrap(busy, FORK_ERROR_MAX_CAUSE_DEPTH - 1)), busy);
	assert.equal(findForkError(wrap(busy, FORK_ERROR_MAX_CAUSE_DEPTH)), undefined);
	assert.equal(isRetryableForkError(wrap(busy, FORK_ERROR_MAX_CAUSE_DEPTH - 1)), true);
	assert.equal(isRetryableForkError(wrap(busy, FORK_ERROR_MAX_CAUSE_DEPTH)), false);
	const terminal = new ForkTargetNotFoundError({ runId, fromStage: "x", validStagePaths: [] });
	const nested = new ForkDefinitionMismatchError(
		{ runId, workflow: "w", reason: "definition-unavailable" },
		{ cause: busy },
	);
	assert.equal(findForkError(new Error("outer", { cause: nested })), nested, "the outermost fork error wins");
	assert.equal(isRetryableForkError(nested), true, "a retryable cause makes the chain retryable");
	assert.equal(isRetryableForkError(terminal), false);
	assert.equal(findForkError(new Error("x", { cause: null })), undefined);
	assert.equal(findForkError("not an error"), undefined);
});

test("an unknown fork error name rehydrates into ForkError keeping its name, code and message (#4321)", () => {
	const wire: SerializedForkError = {
		name: "ForkFutureError",
		code: "future-code",
		message: "Fork future: x (future-code). Upgrade.",
		hint: "Upgrade.",
		retryable: true,
		fields: { runId },
		cause: { name: "TypeError", message: "inner", code: "E_INNER", cause: { name: "Error", message: "deepest" } },
	};
	const error = rehydrateForkError(wire);
	assert.equal(error.constructor, ForkError);
	assert.equal(error.name, "ForkFutureError");
	assert.equal(error.code, "future-code");
	assert.equal(error.message, wire.message);
	assert.equal(error.hint, "Upgrade.");
	assert.equal(error.retryable, true);
	assert.deepEqual(error.fields, { runId });
	assert.ok(error.cause instanceof Error);
	assert.equal(error.cause.name, "TypeError");
	assert.equal((error.cause as Error & { code?: string }).code, "E_INNER");
	assert.equal((error.cause.cause as Error).message, "deepest");
	assert.deepEqual(serializeForkError(error), wire);
	const hintless = rehydrateForkError({ name: "ForkOther", code: "c", message: "m", retryable: false, fields: {} });
	assert.equal(hintless.hint, "");
	assert.equal("cause" in hintless, false);
	assert.equal(rehydrateForkError({ ...wire, name: "toString" }).constructor, ForkError);
});

test("a serialized error keeps at most the bounded number of causes and drops non-error causes (#4321)", () => {
	let cause: Error = new Error("root cause");
	for (let index = 0; index < FORK_ERROR_MAX_CAUSE_DEPTH + 4; index++) cause = new Error(`level ${index}`, { cause });
	const wire = serializeForkError(new ForkCopyFailedError({ runId, forkRunId, phase: "sessions" }, { cause }));
	let depth = 0;
	for (let current = wire.cause; current !== undefined; current = current.cause) depth++;
	assert.equal(depth, FORK_ERROR_MAX_CAUSE_DEPTH);
	const numeric = serializeForkError(
		new ForkCopyFailedError(
			{ runId, forkRunId, phase: "sessions" },
			{ cause: Object.assign(new Error("x"), { code: 5 }) },
		),
	);
	assert.deepEqual(numeric.cause, { name: "Error", message: "x" });
	const opaque = serializeForkError(
		new ForkCopyFailedError({ runId, forkRunId, phase: "sessions" }, { cause: "text" as never as Error }),
	);
	assert.equal("cause" in opaque, false);
});

test("a nested fork cause survives the round trip as its own class within the depth bound (#4321)", () => {
	const inner = new ForkEntryNotFoundError({ sessionId: "s", entryId: "e" });
	const outer = new ForkDefinitionMismatchError(
		{ runId, workflow: "w", reason: "definition-unavailable" },
		{ cause: inner },
	);
	const wire = serializeForkError(outer);
	assert.equal(wire.cause?.name, "ForkEntryNotFoundError");
	assert.equal(wire.cause?.code, "entry-not-found");
	assert.equal(wire.cause?.message, inner.message);
	const rehydrated = rehydrateForkError(JSON.parse(JSON.stringify(outer)) as SerializedForkError);
	assert.ok(rehydrated instanceof ForkDefinitionMismatchError);
	assert.ok(rehydrated.cause instanceof ForkEntryNotFoundError);
	let deep: Error = inner;
	for (let index = 0; index < FORK_ERROR_MAX_CAUSE_DEPTH + 2; index++)
		deep = new ForkDefinitionMismatchError(
			{ runId, workflow: "w", reason: "definition-unavailable" },
			{ cause: deep },
		);
	let causes = 0;
	for (let current = serializeForkError(deep as ForkError).cause; current !== undefined; current = current.fork?.cause)
		causes++;
	assert.equal(causes, FORK_ERROR_MAX_CAUSE_DEPTH);
});

test("cleanup failures are attached in order without replacing the primary error (#4321)", () => {
	const first = new Error("close failed");
	const second = new Error("release failed");
	const third = new Error("delete failed");
	const error = new ForkTargetNotFoundError({ runId, fromStage: "x", validStagePaths: [] });
	const attached = (): Error | undefined => error.cleanupCause;
	assert.equal(attached(), undefined);
	assert.equal(Object.hasOwn(error, "cleanupCause"), false);
	assert.equal(error.withCleanupCause(first), error);
	assert.equal(attached(), first, "one failure is attached as itself");
	error.withCleanupCause(second);
	const two = attached();
	assert.ok(two instanceof AggregateError);
	assert.deepEqual([two.errors, two.message], [[first, second], "2 fork cleanup steps failed"]);
	error.withCleanupCause(third);
	const three = attached();
	assert.ok(three instanceof AggregateError);
	assert.deepEqual([three.errors, three.message], [[first, second, third], "3 fork cleanup steps failed"]);
	assert.equal(error.code, "target-not-found");
	assert.equal("cause" in error, false);
	const other = new ForkTargetNotFoundError({ runId, fromStage: "y", validStagePaths: [] }).withCleanupCause(third);
	assert.equal(other.cleanupCause, third, "each error keeps its own cleanup failures");
});

test("cleanup failures cross the wire with the error, as an AggregateError when there are several (#4321)", () => {
	const closed = new ForkCleanupError(
		{ runId, step: "close-destination-sessions", forkRunId },
		{ cause: Object.assign(new Error("EBUSY"), { code: "EBUSY" }) },
	);
	const released = new ForkClaimReleaseError({ runId, claimExpiresInMs: 120_000 }, { cause: new Error("lease lost") });
	const single = new ForkCopyFailedError({ runId, forkRunId, phase: "journal" }, { cause: new Error("disk full") });
	single.withCleanupCause(closed);
	const singleWire = JSON.parse(JSON.stringify(single)) as SerializedForkError;
	assert.equal(singleWire.cleanupCause?.fork?.name, "ForkCleanupError");
	const singleBack = rehydrateForkError(singleWire);
	assert.ok(singleBack instanceof ForkCopyFailedError);
	assert.ok(singleBack.cleanupCause instanceof ForkCleanupError);
	assert.ok(isForkCleanupError(singleBack.cleanupCause));
	assert.deepEqual(singleBack.cleanupCause.fields, closed.fields);
	assert.equal((singleBack.cleanupCause.cause as Error & { code?: string }).code, "EBUSY");
	assert.deepEqual(serializeForkError(singleBack), singleWire);
	const several = new ForkCopyFailedError({ runId, forkRunId, phase: "journal" }, { cause: new Error("disk full") });
	several.withCleanupCause(closed).withCleanupCause(released);
	const wire = JSON.parse(JSON.stringify(several)) as SerializedForkError;
	assert.deepEqual(
		[
			wire.cleanupCause?.name,
			wire.cleanupCause?.message,
			wire.cleanupCause?.errors?.map((error) => error.fork?.code),
		],
		["AggregateError", "2 fork cleanup steps failed", ["cleanup-failed", "claim-release-failed"]],
	);
	const back = rehydrateForkError(wire);
	assert.ok(back instanceof ForkCopyFailedError);
	assert.equal((back.cause as Error).message, "disk full");
	assert.ok(back.cleanupCause instanceof AggregateError);
	const [backClosed, backReleased] = back.cleanupCause.errors as Error[];
	assert.ok(backClosed instanceof ForkCleanupError);
	assert.deepEqual(backClosed.fields, closed.fields);
	assert.ok(backReleased instanceof ForkClaimReleaseError);
	assert.deepEqual(backReleased.fields, released.fields);
	assert.equal(back.cleanupCause.message, "2 fork cleanup steps failed");
	assert.deepEqual(serializeForkError(back), wire);
	assert.equal("cleanupCause" in serializeForkError(new ForkJournalUnsupportedError()), false);
	const clean = rehydrateForkError(serializeForkError(new ForkJournalUnsupportedError()));
	assert.equal(
		Object.hasOwn(clean, "cleanupCause"),
		false,
		"an error without cleanup failures comes back without one",
	);
	const explained = rehydrateForkError(
		serializeForkError(
			new ForkCopyFailedError(
				{ runId, forkRunId, phase: "sessions" },
				{ cause: new AggregateError([new Error("kept")], "grouped", { cause: new Error("why") }) },
			),
		),
	);
	assert.ok(explained.cause instanceof AggregateError);
	assert.deepEqual(
		[explained.cause.message, (explained.cause.errors[0] as Error).message, (explained.cause.cause as Error).message],
		["grouped", "kept", "why"],
	);
	const opaque = new AggregateError(["not an error", new Error("kept")], "mixed");
	const mixed = serializeForkError(
		new ForkCopyFailedError({ runId, forkRunId, phase: "sessions" }, { cause: opaque }),
	);
	assert.deepEqual(mixed.cause, {
		name: "AggregateError",
		message: "mixed",
		errors: [{ name: "Error", message: "kept" }],
	});
	const empty = serializeForkError(
		new ForkCopyFailedError({ runId, forkRunId, phase: "sessions" }, { cause: new AggregateError([], "none") }),
	);
	assert.deepEqual(empty.cause, { name: "AggregateError", message: "none" });
	let deep: Error = new Error("deepest");
	for (let index = 0; index < FORK_ERROR_MAX_CAUSE_DEPTH; index++) deep = new AggregateError([deep], `level ${index}`);
	const bounded = serializeForkError(
		new ForkCopyFailedError({ runId, forkRunId, phase: "sessions" }, { cause: deep }),
	);
	let levels = 0;
	for (let current = bounded.cause; current !== undefined; current = current.errors?.[0]) levels++;
	assert.equal(levels, FORK_ERROR_MAX_CAUSE_DEPTH, "nested aggregates stay within the depth bound");
});

test("the SDK surface exports every fork error class and guard (#4321)", () => {
	for (const name of [
		"ForkError",
		"ForkTargetNotFoundError",
		"ForkDefinitionMismatchError",
		"ForkSourceBusyError",
		"ForkEntryNotFoundError",
		"ForkSessionNotFoundError",
		"ForkConfigError",
		"ForkSourceNotFoundError",
		"ForkJournalUnsupportedError",
		"ForkJournalUnavailableError",
		"ForkCopyFailedError",
		"ForkClaimReleaseError",
		"ForkSessionUnavailableError",
		"ForkCleanupError",
		"ForkSourceOwnershipError",
		"ForkSessionClaimError",
		"ForkPoolSessionsUnavailableError",
		"isForkError",
		"isForkTargetNotFoundError",
		"isForkDefinitionMismatchError",
		"isForkSourceBusyError",
		"isForkEntryNotFoundError",
		"isForkSessionNotFoundError",
		"isForkConfigError",
		"isForkSourceNotFoundError",
		"isForkJournalUnsupportedError",
		"isForkJournalUnavailableError",
		"isForkCopyFailedError",
		"isForkClaimReleaseError",
		"isForkSessionUnavailableError",
		"isForkCleanupError",
		"isForkSourceOwnershipError",
		"isForkSessionClaimError",
		"isForkPoolSessionsUnavailableError",
		"isRetryableForkError",
		"findForkError",
		"serializeForkError",
		"rehydrateForkError",
		"forkRun",
		"listForkPoints",
	])
		assert.equal(typeof (sdk as Record<string, unknown>)[name], "function", name);
});
