import assert from "node:assert/strict";
import type { AssistantMessage, ToolResultMessage, Usage } from "@bastani/pi-ai/compat";
import { describe, test } from "vitest";
import { estimateCompactionCacheMiss } from "../src/core/cache-stats.ts";
import {
	announcedResultOutcome,
	BACKGROUND_COMPACTION_RESULT_TYPE,
	BACKGROUND_COMPACTION_RETRY_BASE_MS,
	BACKGROUND_COMPACTION_RETRY_MAX_MS,
	type BackgroundCompactionResultRecord,
	backgroundCompactionDiscardReason,
	backgroundCompactionRetryDelayMs,
	backgroundCompactionThresholdTokens,
	coveredThroughIndex,
	DEFAULT_BACKGROUND_COMPACTION_THRESHOLD_PERCENT,
	findBackgroundCompactionSafePoint,
	IDLE_BACKGROUND_COMPACTION_STATE,
	isBackgroundCompactionResultRecord,
	rehydrateBackgroundCompactionState,
	resolveBackgroundCompactionEnabled,
	resolveBackgroundCompactionThresholdPercent,
	selectReadyBackgroundCompaction,
	serializeBackgroundCompactionState,
	shouldStartBackgroundCompaction,
} from "../src/core/compaction/background-compaction.ts";
import {
	BackgroundCompactionCommitError,
	BackgroundCompactionConfigError,
	type BackgroundCompactionConfigReason,
	BackgroundCompactionDiscardedError,
	type BackgroundCompactionDiscardReason,
	BackgroundCompactionError,
	BackgroundCompactionNotCompactableError,
	BackgroundCompactionPersistError,
	BackgroundCompactionPlanningError,
	isBackgroundCompactionCommitError,
	isBackgroundCompactionConfigError,
	isBackgroundCompactionDiscardedError,
	isBackgroundCompactionError,
	isBackgroundCompactionNotCompactableError,
	isBackgroundCompactionPersistError,
	isBackgroundCompactionPlanningError,
	isRetryableBackgroundCompactionError,
	MAX_BACKGROUND_COMPACTION_CAUSE_DEPTH,
	rehydrateBackgroundCompactionError,
	type SerializedBackgroundCompactionError,
	serializeBackgroundCompactionError,
} from "../src/core/compaction/background-compaction-errors.ts";
import { prepareCompactionBoundary } from "../src/core/compaction/compaction-boundary.ts";
import { VERBATIM_COMPACTION_PROMPT_VERSION } from "../src/core/compaction/compaction-types.ts";
import { type SessionEntry, SessionEntryError, SessionManager } from "../src/core/session-manager.ts";
import { buildContextEntries, buildSessionProjection } from "../src/core/session-manager-history.ts";
import { validateSessionEntryStructure } from "../src/core/storage/session/entry-structure.ts";
import { SessionFormatVersionError } from "../src/core/storage/session/errors.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function usage(partial: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: ZERO_COST,
		...partial,
	};
}

let sequence = 0;
function base(id?: string) {
	sequence += 1;
	return { id: id ?? `e${sequence}`, parentId: null, timestamp: new Date(1_000_000 + sequence).toISOString() };
}

function user(id?: string): SessionEntry {
	return { type: "message", ...base(id), message: { role: "user", content: "hi", timestamp: sequence } };
}

function assistant(id: string, calls: string[] = [], messageUsage: Usage = usage()): SessionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "ok" },
			...calls.map((call) => ({ type: "toolCall" as const, id: call, name: "echo", arguments: {} })),
		],
		api: "anthropic-messages",
		provider: "faux",
		model: "faux-1",
		usage: messageUsage,
		stopReason: calls.length > 0 ? "toolUse" : "stop",
		timestamp: sequence,
	};
	return { type: "message", ...base(id), message };
}

function toolResult(id: string, call: string): SessionEntry {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call,
		toolName: "echo",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: sequence,
	};
	return { type: "message", ...base(id), message };
}

function label(id: string, targetId: string): SessionEntry {
	return { type: "label", ...base(id), targetId, label: "mark" };
}

function custom(id: string): SessionEntry {
	return { type: "custom", ...base(id), customType: "other", data: {} };
}

function record(upToEntryId: string, overrides: Partial<BackgroundCompactionResultRecord> = {}) {
	return {
		version: 1 as const,
		upToEntryId,
		startedAt: "2026-11-05T00:00:00.000Z",
		completedAt: "2026-11-05T00:00:01.000Z",
		summary: "[User]: kept",
		firstKeptEntryId: null,
		tokensBefore: 900,
		details: {
			strategy: "verbatim-lines" as const,
			promptVersion: VERBATIM_COMPACTION_PROMPT_VERSION,
			parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "q" },
			stats: {
				linesBefore: 40,
				linesDeleted: 20,
				linesKept: 20,
				rangeCount: 1,
				tokensBefore: 900,
				tokensAfter: 400,
				percentReduction: 55.6,
			},
			rung: "planned" as const,
		},
		fromExtension: false,
		...overrides,
	};
}

function result(id: string, data: object): SessionEntry {
	return { type: "custom", ...base(id), customType: BACKGROUND_COMPACTION_RESULT_TYPE, data };
}

function boundary(id: string, coveredThroughEntryId?: string): SessionEntry {
	return {
		type: "compaction",
		...base(id),
		summary: "[User]: compacted",
		firstKeptEntryId: null,
		tokensBefore: 900,
		...(coveredThroughEntryId === undefined ? {} : { coveredThroughEntryId }),
		details: record("x").details,
	};
}

function contextEdit(id: string, targetId: string): SessionEntry {
	return { type: "context_edit", ...base(id), targetId, replacement: null };
}

describe("background compaction safe point (#4330)", () => {
	test("covers the whole branch when no tool call is pending", () => {
		const branch = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];
		assert.equal(findBackgroundCompactionSafePoint(branch), 3);
	});

	test("excludes a trailing assistant whose tool call has no result", () => {
		const branch = [user("u1"), assistant("a1"), user("u2"), assistant("a2", ["c1"])];
		assert.equal(findBackgroundCompactionSafePoint(branch), 2);
	});

	test("keeps a fully answered tool batch in the prefix", () => {
		const branch = [user("u1"), assistant("a1", ["c1", "c2"]), toolResult("r1", "c1"), toolResult("r2", "c2")];
		assert.equal(findBackgroundCompactionSafePoint(branch), 3);
	});

	test("cuts a parallel batch with a missing result before its assistant", () => {
		const branch = [user("u1"), assistant("a1", ["c1", "c2"]), toolResult("r1", "c1")];
		assert.equal(findBackgroundCompactionSafePoint(branch), 0);
	});

	test("cuts before the earliest unanswered call in the trailing run", () => {
		const branch = [
			user("u1"),
			assistant("a1", ["c1"]),
			assistant("a2", ["c2"]),
			toolResult("r2", "c2"),
			assistant("a3", ["c3"]),
		];
		assert.equal(findBackgroundCompactionSafePoint(branch), 0);
	});

	test("ignores non-context entries inside the run and stops at a plain message", () => {
		const branch = [
			user("u1"),
			assistant("a1", ["c1"]),
			user("u2"),
			assistant("a2", ["c2"]),
			custom("k1"),
			toolResult("r2", "c2"),
			assistant("a3", ["c3"]),
			custom("k2"),
		];
		assert.equal(findBackgroundCompactionSafePoint(branch), 5);
	});

	test("walks past every entry that contributes no model message", () => {
		const passive: SessionEntry[] = [
			{ type: "custom", ...base(), customType: "x", data: {} },
			{ type: "label", ...base(), targetId: "u1", label: "l" },
			{ type: "model_change", ...base(), provider: "faux", modelId: "m" },
			{ type: "thinking_level_change", ...base(), thinkingLevel: "high" },
			{ type: "usage", ...base(), kind: "k", provider: "faux", model: "m", usage: usage() },
			{ type: "session_info", ...base(), name: "n" },
			{ type: "session_summary", ...base(), summary: "s", summarizedThroughId: "u1" },
			{ type: "context_edit", ...base(), targetId: "u1", replacement: null },
		];
		for (const entry of passive) {
			const branch = [user("u1"), assistant("a1", ["c1"]), entry, assistant("a2", ["c2"]), toolResult("r2", "c2")];
			assert.equal(findBackgroundCompactionSafePoint(branch), 0, `${entry.type} does not end the trailing run`);
		}
		const ending: SessionEntry[] = [
			user("stop"),
			assistant("plain"),
			boundary("stop-boundary"),
			{ type: "custom_message", ...base(), customType: "x", content: "c", display: true },
		];
		for (const entry of ending) {
			const branch = [user("u1"), assistant("a1", ["c1"]), entry, assistant("a2", ["c2"]), toolResult("r2", "c2")];
			assert.equal(findBackgroundCompactionSafePoint(branch), 4, `${entry.type} ends the trailing run`);
		}
	});

	test("a result recorded before its own prefix entry is off-branch", () => {
		const branch = [user("u1"), result("r1", record("a1")), assistant("a1")];
		assert.equal(backgroundCompactionDiscardReason(branch, 1), "off-branch");
	});

	test("never ends on a label, which a branched copy drops", () => {
		const branch = [user("u1"), assistant("a1"), label("l1", "u1"), assistant("a2", ["c1"])];
		assert.equal(findBackgroundCompactionSafePoint(branch), 1);
	});

	test("returns -1 when nothing before the pending call is safe", () => {
		assert.equal(findBackgroundCompactionSafePoint([assistant("a1", ["c1"])]), -1);
		assert.equal(findBackgroundCompactionSafePoint([]), -1);
	});
});

describe("background compaction positions (#4330)", () => {
	test("a foreground boundary covers every entry before it", () => {
		const branch = [user("u1"), assistant("a1"), boundary("b1"), user("u2")];
		assert.equal(coveredThroughIndex(branch), 1);
	});

	test("a background boundary covers through its recorded entry", () => {
		const branch = [user("u1"), assistant("a1"), user("u2"), boundary("b1", "a1"), user("u3")];
		assert.equal(coveredThroughIndex(branch), 1);
	});

	test("a covered entry that is not before the boundary falls back to the boundary", () => {
		const branch = [user("u1"), boundary("b1", "zz"), user("u2")];
		assert.equal(coveredThroughIndex(branch), 0);
	});

	test("without a boundary nothing is covered", () => {
		assert.equal(coveredThroughIndex([user("u1")]), -1);
	});

	test("the latest stored result that fits wins over an older one", () => {
		const branch = [
			user("u1"),
			assistant("a1"),
			result("older", record("u1")),
			user("u2"),
			assistant("a2"),
			result("newer", record("u2")),
		];
		assert.equal(selectReadyBackgroundCompaction(branch)?.entry.id, "newer");
	});

	test("two overlapping compactions resolve to the newer one whatever order they finished in (#4330)", () => {
		const branch = [
			user("u1"),
			assistant("a1"),
			user("u2"),
			assistant("a2"),
			result("finished-first", record("u2")),
			result("finished-last", record("a1")),
		];
		const ready = selectReadyBackgroundCompaction(branch);
		assert.equal(ready?.entry.id, "finished-first");
		assert.equal(ready?.upToIndex, 2);
	});

	test("ties on position go to the later record", () => {
		const branch = [user("u1"), result("r1", record("u1")), result("r2", record("u1"))];
		assert.equal(selectReadyBackgroundCompaction(branch)?.entry.id, "r2");
	});

	test("a result covered by a newer boundary is superseded and never selected again", () => {
		const branch = [user("u1"), assistant("a1"), result("r1", record("u1")), boundary("b1", "u1"), user("u2")];
		assert.equal(selectReadyBackgroundCompaction(branch), undefined);
		assert.equal(backgroundCompactionDiscardReason(branch, 2), "superseded");
		const outcome = announcedResultOutcome(branch, "r1");
		assert.equal(outcome.kind, "discarded");
		assert.ok(outcome.kind === "discarded" && outcome.error instanceof BackgroundCompactionDiscardedError);
		assert.equal(outcome.error.reason, "superseded");
		assert.equal(outcome.error.upToEntryId, "u1");
	});

	test("a foreground boundary after the result supersedes it", () => {
		const branch = [user("u1"), result("r1", record("u1")), user("u2"), boundary("b1")];
		assert.equal(backgroundCompactionDiscardReason(branch, 1), "superseded");
	});

	test("a context edit after the result position into its prefix makes it stale", () => {
		const branch = [user("u1"), assistant("a1"), result("r1", record("a1")), contextEdit("x1", "u1")];
		assert.equal(backgroundCompactionDiscardReason(branch, 2), "context-edited");
		assert.equal(selectReadyBackgroundCompaction(branch), undefined);
	});

	test("a context edit of the replayed tail keeps the result", () => {
		const branch = [user("u1"), assistant("a1"), result("r1", record("u1")), contextEdit("x1", "a1")];
		assert.equal(backgroundCompactionDiscardReason(branch, 2), undefined);
	});

	test("a context edit inside the frozen prefix was already planned over", () => {
		const branch = [user("u1"), contextEdit("x1", "u1"), assistant("a1"), result("r1", record("a1"))];
		assert.equal(backgroundCompactionDiscardReason(branch, 3), undefined);
	});

	test("a fork taken before the result never sees it (#4330)", () => {
		const branch = [user("u1"), assistant("a1"), user("u2")];
		assert.equal(selectReadyBackgroundCompaction(branch), undefined);
	});

	test("a result whose prefix is not on the branch is off-branch", () => {
		const branch = [user("u1"), result("r1", record("elsewhere"))];
		assert.equal(backgroundCompactionDiscardReason(branch, 1), "off-branch");
		const kept = [user("u1"), assistant("a1"), result("r2", record("u1", { firstKeptEntryId: "a1" }))];
		assert.equal(backgroundCompactionDiscardReason(kept, 2), "off-branch");
		const keptMissing = [user("u1"), result("r3", record("u1", { firstKeptEntryId: "gone" }))];
		assert.equal(backgroundCompactionDiscardReason(keptMissing, 1), "off-branch");
		const keptInPrefix = [user("u1"), assistant("a1"), result("r4", record("a1", { firstKeptEntryId: "u1" }))];
		assert.equal(backgroundCompactionDiscardReason(keptInPrefix, 2), undefined);
	});

	test("a malformed stored record is discarded", () => {
		const branch = [user("u1"), result("r1", { version: 2 })];
		assert.equal(backgroundCompactionDiscardReason(branch, 1), "malformed");
		assert.equal(backgroundCompactionDiscardReason(branch, 0), "malformed");
		assert.equal(selectReadyBackgroundCompaction(branch), undefined);
		const malformed = announcedResultOutcome(branch, "r1");
		assert.equal(malformed.kind === "discarded" && malformed.error.upToEntryId, "r1");
	});

	test("an announced result is committable on its branch and not discarded when another branch is current", () => {
		const branch = [user("u1"), assistant("a1"), result("r1", record("a1")), user("u2")];
		assert.deepEqual(announcedResultOutcome(branch, "r1"), { kind: "committable" });
		assert.deepEqual(announcedResultOutcome(branch, "missing"), { kind: "not-on-branch" });
	});

	test("validates every stored field at the storage boundary", () => {
		const valid = record("u1");
		assert.equal(isBackgroundCompactionResultRecord(valid), true);
		assert.equal(isBackgroundCompactionResultRecord({ ...valid, usage: usage() }), true);
		assert.equal(isBackgroundCompactionResultRecord({ ...valid, firstKeptEntryId: "e" }), true);
		for (const broken of [
			null,
			[],
			"x",
			{ ...valid, version: 2 },
			{ ...valid, upToEntryId: 1 },
			{ ...valid, startedAt: 1 },
			{ ...valid, completedAt: undefined },
			{ ...valid, summary: 3 },
			{ ...valid, summary: "   " },
			{ ...valid, firstKeptEntryId: 7 },
			{ ...valid, tokensBefore: "9" },
			{ ...valid, tokensBefore: Number.NaN },
			{ ...valid, fromExtension: "no" },
			{ ...valid, usage: "u" },
			{ ...valid, details: null },
			{ ...valid, details: { ...valid.details, strategy: "legacy" } },
			{ ...valid, details: { ...valid.details, stats: null } },
			{ ...valid, details: { ...valid.details, parameters: [] } },
			{ ...valid, details: { ...valid.details, rung: 1 } },
		]) {
			assert.equal(isBackgroundCompactionResultRecord(broken), false, JSON.stringify(broken));
		}
	});
});

describe("background compaction scheduling (#4330)", () => {
	test("the soft threshold defaults to 75% and compares strictly", () => {
		assert.equal(DEFAULT_BACKGROUND_COMPACTION_THRESHOLD_PERCENT, 75);
		assert.equal(backgroundCompactionThresholdTokens(1_000, 75), 750);
		assert.equal(shouldStartBackgroundCompaction(750, 1_000, 75), false);
		assert.equal(shouldStartBackgroundCompaction(751, 1_000, 75), true);
		assert.equal(shouldStartBackgroundCompaction(501, 1_000, 50), true);
		assert.equal(shouldStartBackgroundCompaction(5_000, 0, 75), false);
	});

	test("retries back off exponentially up to a cap", () => {
		assert.equal(backgroundCompactionRetryDelayMs(0), 0);
		assert.equal(backgroundCompactionRetryDelayMs(1), BACKGROUND_COMPACTION_RETRY_BASE_MS);
		assert.equal(backgroundCompactionRetryDelayMs(2), 2 * BACKGROUND_COMPACTION_RETRY_BASE_MS);
		assert.equal(backgroundCompactionRetryDelayMs(3), 4 * BACKGROUND_COMPACTION_RETRY_BASE_MS);
		assert.equal(backgroundCompactionRetryDelayMs(30), BACKGROUND_COMPACTION_RETRY_MAX_MS);
	});

	test("settings resolve to their defaults and reject invalid values with typed config errors", () => {
		assert.equal(resolveBackgroundCompactionEnabled(undefined, "settings"), true);
		assert.equal(resolveBackgroundCompactionEnabled(false, "settings"), false);
		assert.equal(resolveBackgroundCompactionThresholdPercent(undefined, "settings"), 75);
		assert.equal(resolveBackgroundCompactionThresholdPercent(60, "sdk"), 60);
		assert.equal(resolveBackgroundCompactionThresholdPercent(99.5, "sdk"), 99.5);
		assert.equal(resolveBackgroundCompactionThresholdPercent(0.5, "sdk"), 0.5);
		assert.equal(resolveBackgroundCompactionEnabled(true, "sdk"), true);
		const cases: Array<[() => unknown, string, string, string]> = [
			[
				() => resolveBackgroundCompactionEnabled("yes", "settings"),
				"settings",
				"compaction.background",
				"not-a-boolean",
			],
			[
				() => resolveBackgroundCompactionThresholdPercent("75", "settings"),
				"settings",
				"compaction.backgroundThresholdPercent",
				"not-a-number",
			],
			[
				() => resolveBackgroundCompactionThresholdPercent(Number.POSITIVE_INFINITY, "sdk"),
				"sdk",
				"compaction.backgroundThresholdPercent",
				"out-of-range",
			],
			[
				() => resolveBackgroundCompactionThresholdPercent(Number.NaN, "sdk"),
				"sdk",
				"compaction.backgroundThresholdPercent",
				"not-a-number",
			],
			[
				() => resolveBackgroundCompactionThresholdPercent(-5, "settings"),
				"settings",
				"compaction.backgroundThresholdPercent",
				"out-of-range",
			],
			[
				() => resolveBackgroundCompactionThresholdPercent(0, "sdk"),
				"sdk",
				"compaction.backgroundThresholdPercent",
				"out-of-range",
			],
			[
				() => resolveBackgroundCompactionThresholdPercent(100, "sdk"),
				"sdk",
				"compaction.backgroundThresholdPercent",
				"out-of-range",
			],
		];
		for (const [run, source, field, reason] of cases) {
			assert.throws(run, (error: unknown) => {
				assert.ok(error instanceof BackgroundCompactionConfigError);
				assert.equal(error.code, "invalid-setting");
				assert.equal(error.retryable, false);
				assert.equal(error.phase, "config");
				assert.equal(error.source, source);
				assert.equal(error.field, field);
				assert.equal(error.reason, reason);
				assert.ok(error.hint.includes(field));
				return true;
			});
		}
	});

	test("state serializes for RPC and workflow status and rehydrates its typed error", () => {
		assert.deepEqual(serializeBackgroundCompactionState(IDLE_BACKGROUND_COMPACTION_STATE), { state: "idle" });
		const failed = {
			state: "failed" as const,
			upToEntryId: "u1",
			startedAt: "2026-11-05T00:00:00.000Z",
			error: new BackgroundCompactionPlanningError({ upToEntryId: "u1", attempt: 2 }, { cause: new Error("boom") }),
		};
		const serialized = serializeBackgroundCompactionState(failed);
		const wire = JSON.parse(JSON.stringify(serialized));
		assert.deepEqual(wire, serialized);
		const back = rehydrateBackgroundCompactionState(wire);
		assert.equal(back.state, "failed");
		assert.equal(back.upToEntryId, "u1");
		assert.equal(back.startedAt, failed.startedAt);
		assert.ok(back.error instanceof BackgroundCompactionPlanningError);
		assert.equal(back.error.attempt, 2);
		assert.deepEqual(rehydrateBackgroundCompactionState({ state: "running", upToEntryId: "u9" }), {
			state: "running",
			upToEntryId: "u9",
		});
	});
});

describe("BackgroundCompactionError (#4330)", () => {
	test("each class has a stable name, code, retryability and fields", () => {
		const planning = new BackgroundCompactionPlanningError({ upToEntryId: "u1", attempt: 3 });
		assert.equal(planning.name, "BackgroundCompactionPlanningError");
		assert.equal(planning.code, "planner-failed");
		assert.equal(planning.retryable, true);
		assert.equal(planning.phase, "plan");
		assert.deepEqual(planning.fields(), { upToEntryId: "u1", attempt: 3 });

		const notCompactable = new BackgroundCompactionNotCompactableError({ upToEntryId: "u2" });
		assert.equal(notCompactable.name, "BackgroundCompactionNotCompactableError");
		assert.equal(notCompactable.code, "not-compactable");
		assert.equal(notCompactable.retryable, false);
		assert.deepEqual(notCompactable.fields(), { upToEntryId: "u2" });

		const persist = new BackgroundCompactionPersistError({ upToEntryId: "u3" });
		assert.equal(persist.name, "BackgroundCompactionPersistError");
		assert.equal(persist.code, "result-persist-failed");
		assert.equal(persist.retryable, true);
		assert.equal(persist.phase, "persist");

		const commit = new BackgroundCompactionCommitError({ upToEntryId: "u5", resultEntryId: "r5", attempt: 2 });
		assert.equal(commit.name, "BackgroundCompactionCommitError");
		assert.equal(commit.code, "commit-failed");
		assert.equal(commit.retryable, true);
		assert.equal(commit.phase, "commit");
		assert.equal(commit.resultEntryId, "r5");
		assert.equal(commit.attempt, 2);
		assert.deepEqual(commit.fields(), { upToEntryId: "u5", resultEntryId: "r5", attempt: 2 });

		const discarded = new BackgroundCompactionDiscardedError({ upToEntryId: "u4", reason: "context-edited" });
		assert.equal(discarded.name, "BackgroundCompactionDiscardedError");
		assert.equal(discarded.code, "result-discarded");
		assert.equal(discarded.retryable, false);
		assert.equal(discarded.phase, "commit");
		assert.deepEqual(discarded.fields(), { upToEntryId: "u4", reason: "context-edited" });

		const config = new BackgroundCompactionConfigError({
			source: "sdk",
			field: "compaction.background",
			reason: "not-a-boolean",
		});
		assert.equal(config.name, "BackgroundCompactionConfigError");
		assert.equal(config.upToEntryId, undefined);
		assert.deepEqual(config.fields(), { source: "sdk", field: "compaction.background", reason: "not-a-boolean" });

		for (const error of [planning, notCompactable, persist, discarded, config]) {
			assert.ok(error instanceof BackgroundCompactionError);
			assert.ok(isBackgroundCompactionError(error));
		}
	});

	test("renders what failed, the code, and what to do next", () => {
		const error = new BackgroundCompactionPlanningError({ upToEntryId: "u1", attempt: 1 });
		assert.equal(
			error.message,
			"Background compaction failed: planning the prefix through entry u1 (attempt 1) (planner-failed). History is unchanged; Atomic retries with backoff at a later turn boundary. Check the compaction model and its credentials",
		);
	});

	test("renders each class once as a UX contract", () => {
		assert.equal(
			new BackgroundCompactionNotCompactableError({ upToEntryId: "u2" }).message,
			"Background compaction failed: the prefix through entry u2 has too few compactable lines (not-compactable). History is unchanged; Atomic tries again after more turns, and overflow still compacts in the foreground",
		);
		assert.equal(
			new BackgroundCompactionPersistError({ upToEntryId: "u3" }).message,
			"Background compaction failed: saving the result for entry u3 (result-persist-failed). History is unchanged; Atomic retries with backoff. Check that session storage is writable",
		);
		assert.equal(
			new BackgroundCompactionCommitError({ upToEntryId: "u5", resultEntryId: "r5", attempt: 1 }).message,
			"Background compaction failed: applying the result for entry u5 (attempt 1) (commit-failed). History is unchanged; the turn continues and Atomic retries applying the saved result with backoff at a later turn boundary. Check that session storage is writable",
		);
		assert.equal(
			new BackgroundCompactionDiscardedError({ upToEntryId: "u4", reason: "superseded" }).message,
			"Background compaction failed: the result for entry u4 is covered by a newer compaction (result-discarded). History is unchanged; a later turn compacts the current branch again when it still needs it",
		);
		assert.equal(
			new BackgroundCompactionConfigError({
				source: "settings",
				field: "compaction.backgroundThresholdPercent",
				reason: "out-of-range",
			}).message,
			"Background compaction failed: compaction.backgroundThresholdPercent from settings is not above 0 and below 100 (invalid-setting). Set compaction.backgroundThresholdPercent to a percentage above 0 and below 100, for example 75",
		);
	});

	test("each discard and config reason explains itself", () => {
		const discard: Array<[BackgroundCompactionDiscardReason, string]> = [
			["superseded", "covered by a newer compaction"],
			["off-branch", "no longer on the current branch"],
			["context-edited", "out of date after a context edit inside its prefix"],
			["malformed", "not a valid background compaction record"],
		];
		for (const [reason, phrase] of discard) {
			const error = new BackgroundCompactionDiscardedError({ upToEntryId: "u", reason });
			assert.ok(error.message.includes(`is ${phrase} (result-discarded)`), reason);
		}
		const config: Array<[BackgroundCompactionConfigReason, string, string]> = [
			["not-a-boolean", "is not true or false", "Set f to true or false"],
			["not-a-number", "is not a finite number", "Set f to a percentage of the context window, for example 75"],
			[
				"out-of-range",
				"is not above 0 and below 100",
				"Set f to a percentage above 0 and below 100, for example 75",
			],
		];
		for (const [reason, subject, hint] of config) {
			const error = new BackgroundCompactionConfigError({ source: "sdk", field: "f", reason });
			assert.ok(error.message.includes(`f from sdk ${subject} (invalid-setting)`), reason);
			assert.equal(error.hint, hint);
		}
		assert.equal(
			new BackgroundCompactionPlanningError({ upToEntryId: "u", attempt: 1 }).hint,
			"History is unchanged; Atomic retries with backoff at a later turn boundary. Check the compaction model and its credentials",
		);
	});

	test("guards match by class and structurally across realms", () => {
		const structural = {
			name: "BackgroundCompactionPersistError",
			code: "result-persist-failed",
			retryable: true,
		};
		assert.equal(isBackgroundCompactionPersistError(structural), true);
		assert.equal(isBackgroundCompactionError(structural), true);
		assert.equal(isBackgroundCompactionPlanningError(structural), false);
		assert.equal(isBackgroundCompactionError({ name: "Other", code: "result-persist-failed" }), false);
		assert.equal(isBackgroundCompactionError({ name: "BackgroundCompactionPersistError", code: "nope" }), false);
		assert.equal(isBackgroundCompactionError({ name: 3, code: "planner-failed" }), false);
		assert.equal(isBackgroundCompactionError(null), false);
		assert.equal(isBackgroundCompactionError("BackgroundCompactionError"), false);
		assert.equal(
			isBackgroundCompactionNotCompactableError(new BackgroundCompactionNotCompactableError({ upToEntryId: "u" })),
			true,
		);
		assert.equal(
			isBackgroundCompactionDiscardedError(
				new BackgroundCompactionDiscardedError({ upToEntryId: "u", reason: "malformed" }),
			),
			true,
		);
		assert.equal(
			isBackgroundCompactionConfigError({ name: "BackgroundCompactionConfigError", code: "invalid-setting" }),
			true,
		);
		assert.equal(
			isBackgroundCompactionPlanningError(new BackgroundCompactionPlanningError({ upToEntryId: "u", attempt: 1 })),
			true,
		);
	});

	test("retryability is found anywhere in a bounded cause chain", () => {
		const retryable = new BackgroundCompactionPersistError({ upToEntryId: "u" });
		assert.equal(isRetryableBackgroundCompactionError(retryable), true);
		assert.equal(isRetryableBackgroundCompactionError(new Error("wrapper", { cause: retryable })), true);
		assert.equal(
			isRetryableBackgroundCompactionError(new BackgroundCompactionNotCompactableError({ upToEntryId: "u" })),
			false,
		);
		assert.equal(isRetryableBackgroundCompactionError(new Error("plain")), false);
		assert.equal(isRetryableBackgroundCompactionError(undefined), false);
		let deep: Error = retryable;
		for (let depth = 0; depth < MAX_BACKGROUND_COMPACTION_CAUSE_DEPTH; depth++)
			deep = new Error("w", { cause: deep });
		assert.equal(isRetryableBackgroundCompactionError(deep), false);
	});

	test("round-trips every class through JSON with its cause chain", () => {
		const errors = [
			new BackgroundCompactionPlanningError(
				{ upToEntryId: "u1", attempt: 4 },
				{ cause: new RangeError("planner", { cause: "raw" }) },
			),
			new BackgroundCompactionNotCompactableError({ upToEntryId: "u2" }),
			new BackgroundCompactionPersistError(
				{ upToEntryId: "u3" },
				{ cause: new BackgroundCompactionNotCompactableError({ upToEntryId: "inner" }) },
			),
			new BackgroundCompactionDiscardedError({ upToEntryId: "u4", reason: "off-branch", phase: "persist" }),
			new BackgroundCompactionConfigError({ source: "settings", field: "f", reason: "out-of-range" }),
			new BackgroundCompactionCommitError(
				{ upToEntryId: "u5", resultEntryId: "r5", attempt: 3 },
				{ cause: new Error("disk full") },
			),
		];
		for (const error of errors) {
			const wire = JSON.parse(JSON.stringify(serializeBackgroundCompactionError(error)));
			const back = rehydrateBackgroundCompactionError(wire);
			assert.equal(back.constructor, error.constructor);
			assert.equal(back.name, error.name);
			assert.equal(back.code, error.code);
			assert.equal(back.message, error.message);
			assert.equal(back.hint, error.hint);
			assert.equal(back.phase, error.phase);
			assert.equal(back.retryable, error.retryable);
			assert.deepEqual(back.fields(), error.fields());
		}
		const planning = rehydrateBackgroundCompactionError(
			JSON.parse(JSON.stringify(serializeBackgroundCompactionError(errors[0]))),
		);
		assert.ok(planning.cause instanceof Error);
		assert.equal(planning.cause.name, "RangeError");
		assert.equal(planning.cause.message, "planner");
		assert.equal((planning.cause.cause as Error).message, "raw");
		const persist = rehydrateBackgroundCompactionError(
			JSON.parse(JSON.stringify(serializeBackgroundCompactionError(errors[2]))),
		);
		assert.ok(persist.cause instanceof BackgroundCompactionNotCompactableError);
		const commit = rehydrateBackgroundCompactionError(
			JSON.parse(JSON.stringify(serializeBackgroundCompactionError(errors[5]))),
		);
		assert.ok(commit instanceof BackgroundCompactionCommitError);
		assert.equal((commit.cause as Error).message, "disk full");
	});

	test("an unknown or mismatched envelope rehydrates into the family base with name and code intact", () => {
		const unknown: SerializedBackgroundCompactionError = {
			name: "BackgroundCompactionFutureError",
			code: "planner-failed",
			message: "future failure",
			hint: "do the future thing",
			retryable: true,
			phase: "plan",
			fields: { upToEntryId: "u7", extra: 1 },
		};
		const back = rehydrateBackgroundCompactionError(unknown);
		assert.ok(back instanceof BackgroundCompactionError);
		assert.equal(back.name, "BackgroundCompactionFutureError");
		assert.equal(back.code, "planner-failed");
		assert.equal(back.message, "future failure");
		assert.equal(back.hint, "do the future thing");
		assert.equal(back.upToEntryId, "u7");
		assert.deepEqual(back.fields(), { upToEntryId: "u7", extra: 1 });
		assert.equal(isRetryableBackgroundCompactionError(back), true);

		for (const mismatched of [
			{ ...unknown, name: "BackgroundCompactionPlanningError", fields: { upToEntryId: "u" } },
			{ ...unknown, name: "BackgroundCompactionNotCompactableError", fields: {} },
			{ ...unknown, name: "BackgroundCompactionPersistError", fields: {} },
			{ ...unknown, name: "BackgroundCompactionDiscardedError", fields: { upToEntryId: "u", reason: "bogus" } },
			{
				...unknown,
				name: "BackgroundCompactionConfigError",
				fields: { source: "cli", field: "f", reason: "out-of-range" },
			},
		]) {
			const fallback = rehydrateBackgroundCompactionError(mismatched);
			assert.equal(fallback.constructor.name, "RehydratedBackgroundCompactionError");
			assert.equal(fallback.name, mismatched.name);
		}
	});

	test("bounds a serialized cause chain", () => {
		let deep: Error = new Error("root");
		for (let depth = 0; depth < 20; depth++) deep = new Error(`level ${depth}`, { cause: deep });
		const serialized = serializeBackgroundCompactionError(
			new BackgroundCompactionPlanningError({ upToEntryId: "u", attempt: 1 }, { cause: deep }),
		);
		let causes = 0;
		let cause = serialized.cause;
		while (cause) {
			causes += 1;
			cause = cause.cause;
		}
		assert.equal(causes, MAX_BACKGROUND_COMPACTION_CAUSE_DEPTH - 1);
	});
});

describe("background compaction cache miss (#4330)", () => {
	const models = {
		getModel: () => ({ cost: { cacheRead: 0.3, input: 3 } }),
	};

	test("reports the cached prompt the commit re-bills at the uncached rate", () => {
		const branch = [
			user("u1"),
			assistant(
				"a1",
				[],
				usage({
					input: 1_000,
					cacheRead: 9_000,
					cacheWrite: 500,
					cost: { input: 0.003, output: 0, cacheRead: 0.0027, cacheWrite: 0.0045, total: 0.0102 },
				}),
			),
			custom("after"),
			user("u2"),
		];
		const miss = estimateCompactionCacheMiss(branch, 4_000, models);
		assert.equal(miss?.expectedMissedTokens, 4_000);
		const paidRate = (0.003 + 0.0045) / 1_500;
		const readRate = 0.0027 / 9_000;
		assert.ok(Math.abs((miss?.expectedMissedCost ?? 0) - 4_000 * (paidRate - readRate)) < 1e-12);
	});

	test("prices from the model when the last request read nothing from the cache or there is no request", () => {
		const writeOnly = [
			assistant(
				"a1",
				[],
				usage({ input: 100, cacheWrite: 900, cost: { ...ZERO_COST, input: 0.0003, cacheWrite: 0.00225 } }),
			),
		];
		const miss = estimateCompactionCacheMiss(writeOnly, 400, models);
		assert.equal(miss?.expectedMissedTokens, 400);
		assert.ok(Math.abs((miss?.expectedMissedCost ?? 0) - 400 * (0.00255 / 1_000 - 0.3 / 1_000_000)) < 1e-12);
		const warmed: SessionEntry[] = [
			user("u1"),
			{
				type: "usage",
				...base("w1"),
				kind: "cache_warm",
				provider: "faux",
				model: "faux-1",
				usage: usage({ cacheRead: 800 }),
			},
		];
		const fromWarm = estimateCompactionCacheMiss(warmed, 300, models);
		assert.equal(fromWarm?.expectedMissedTokens, 300);
		assert.ok(Math.abs((fromWarm?.expectedMissedCost ?? 0) - 300 * (3 / 1_000_000 - 0.3 / 1_000_000)) < 1e-12);
		const unknownModel = estimateCompactionCacheMiss(warmed, 300, { getModel: () => undefined });
		assert.equal(unknownModel?.expectedMissedCost, 0);
	});

	test("caps the miss at the previously cached prompt and prices from the model without paid tokens", () => {
		const branch = [user("u1"), assistant("a1", [], usage({ cacheRead: 2_000, cost: ZERO_COST }))];
		const miss = estimateCompactionCacheMiss(branch, 5_000, models);
		assert.equal(miss?.expectedMissedTokens, 2_000);
		assert.ok(Math.abs((miss?.expectedMissedCost ?? 0) - 2_000 * (3 / 1_000_000 - 0)) < 1e-12);
	});

	test("reports nothing when the last request was not cached or the prompt is empty", () => {
		assert.equal(
			estimateCompactionCacheMiss([user("u1"), assistant("a1", [], usage({ input: 5_000 }))], 100, models),
			undefined,
		);
		assert.equal(estimateCompactionCacheMiss([user("u1")], 100, models), undefined);
		assert.equal(
			estimateCompactionCacheMiss([user("u1"), assistant("a1", [], usage({ cacheRead: 10 }))], 0, models),
			undefined,
		);
	});
});

describe("background compaction boundary storage (#4330)", () => {
	const details = record("x").details;

	test("appendCompaction records coveredThroughEntryId and rejects an unknown entry", async () => {
		const manager = SessionManager.inMemory(process.cwd());
		const first = await manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
		await manager.appendMessage({ role: "user", content: "two", timestamp: 2 });
		const id = await manager.appendCompaction("[User]: one", null, 10, details, undefined, first);
		const entry = manager.getEntry(id);
		assert.equal(entry?.type === "compaction" && entry.coveredThroughEntryId, first);
		const foreground = await manager.appendCompaction("[User]: two", null, 10, details);
		const plain = manager.getEntry(foreground);
		assert.ok(plain?.type === "compaction");
		assert.equal("coveredThroughEntryId" in plain, false, "a foreground boundary has no covered field");
		await assert.rejects(
			manager.appendCompaction("[User]: three", null, 10, details, undefined, "missing"),
			(error: unknown) =>
				error instanceof SessionEntryError && error.reason === "missing" && error.entryId === "missing",
		);
	});

	test("a stored boundary with a non-string coveredThroughEntryId is rejected as a format error", () => {
		const valid = boundary("b1", "u1");
		assert.doesNotThrow(() => validateSessionEntryStructure([valid, boundary("b2")], "session"));
		assert.throws(
			() => validateSessionEntryStructure([{ ...valid, coveredThroughEntryId: 7 } as never], "session"),
			SessionFormatVersionError,
		);
	});

	test("the projection serializes only the covered tail and replays the rest structurally", () => {
		const entries: SessionEntry[] = [];
		const add = (entry: SessionEntry) => {
			entries.push({ ...entry, parentId: entries.at(-1)?.id ?? null } as SessionEntry);
		};
		add(user("p1"));
		add(assistant("p2"));
		add(user("p3"));
		add(assistant("p4"));
		add({ ...boundary("old"), firstKeptEntryId: "p3" });
		add(user("r1"));
		add(assistant("r2"));
		add({ ...boundary("new", "p4"), firstKeptEntryId: "p3", summary: "[User]: summary" });
		add(user("after"));
		const projection = buildSessionProjection(entries);
		assert.deepEqual(
			projection.entries.map((item) => [item.sourceEntry.id, item.messages.length]),
			[
				["new", 1],
				["p3", 0],
				["p4", 0],
				["old", 0],
				["r1", 1],
				["r2", 1],
				["after", 1],
			],
		);
		const boundaryText = JSON.stringify(projection.messages[0]);
		assert.ok(boundaryText.includes("[User]: summary"));
		assert.ok(!boundaryText.includes("r1"), "replayed entries are not serialized into the boundary");
		assert.deepEqual(
			buildContextEntries(entries).map((entry) => entry.id),
			["new", "p3", "p4", "old", "r1", "r2", "after"],
		);

		const dropped = entries.map((entry) => (entry.id === "new" ? { ...entry, firstKeptEntryId: null } : entry));
		assert.deepEqual(
			buildContextEntries(dropped).map((entry) => entry.id),
			["new", "old", "r1", "r2", "after"],
			"without a kept tail the replay still starts after the covered entry",
		);
		const unknownCovered = entries.map((entry) =>
			entry.id === "new" ? { ...entry, firstKeptEntryId: null, coveredThroughEntryId: "gone" } : entry,
		);
		assert.deepEqual(
			buildContextEntries(unknownCovered).map((entry) => entry.id),
			["new", "after"],
			"an unknown covered entry falls back to covering everything before the boundary",
		);
	});

	test("the next compaction region starts after a background boundary's covered entry", () => {
		const entries: SessionEntry[] = [];
		const add = (entry: SessionEntry) => {
			entries.push({ ...entry, parentId: entries.at(-1)?.id ?? null } as SessionEntry);
		};
		const longUser = (id: string) =>
			({
				type: "message",
				...base(id),
				message: {
					role: "user",
					content: Array.from({ length: 24 }, (_, line) => `${id} line ${line}`).join("\n"),
					timestamp: sequence,
				},
			}) as SessionEntry;
		add(longUser("q1"));
		add(assistant("q2"));
		add(longUser("r1"));
		add({ ...boundary("bg", "q2"), firstKeptEntryId: null });
		add(longUser("q3"));
		add(assistant("q4"));
		add(longUser("q5"));
		add(assistant("q6"));
		const preparation = prepareCompactionBoundary(entries, {
			enabled: true,
			reserveTokens: 100,
			compression_ratio: 0.5,
			preserve_recent: 2,
		});
		assert.ok(preparation);
		assert.deepEqual(preparation.regionEntryIds, ["r1", "q3", "q4"], "replayed entries stay compactable");
	});
});

describe("background compaction boundary positions (#4330)", () => {
	const settings = { enabled: true, reserveTokens: 100, compression_ratio: 0.5, preserve_recent: 2 };
	const longUser = (id: string) =>
		({
			type: "message",
			...base(id),
			message: {
				role: "user",
				content: Array.from({ length: 24 }, (_, line) => `${id} line ${line}`).join("\n"),
				timestamp: sequence,
			},
		}) as SessionEntry;
	const chain = (...items: SessionEntry[]): SessionEntry[] =>
		items.map((entry, index) => ({ ...entry, parentId: index === 0 ? null : items[index - 1].id }) as SessionEntry);
	const regionOf = (entries: SessionEntry[]) => prepareCompactionBoundary(entries, settings)?.regionEntryIds;
	const previous = (firstKeptEntryId: string | null, coveredThroughEntryId?: string) => ({
		...boundary("b", coveredThroughEntryId),
		firstKeptEntryId,
	});

	test("the next region starts at the previous kept tail, after its covered entry, or after the boundary", () => {
		assert.deepEqual(
			regionOf(
				chain(longUser("k1"), assistant("k2"), previous("k1"), longUser("k3"), assistant("k4"), longUser("k5")),
			),
			["k1", "k2", "k3"],
			"a kept tail that starts at the first entry",
		);
		assert.deepEqual(
			regionOf(
				chain(
					longUser("c1"),
					longUser("c2"),
					previous(null, "c1"),
					longUser("c3"),
					assistant("c4"),
					longUser("c5"),
				),
			),
			["c2", "c3"],
			"a covered entry at the first position",
		);
		assert.deepEqual(
			regionOf(
				chain(longUser("f1"), longUser("f2"), previous(null), longUser("f3"), assistant("f4"), longUser("f5")),
			),
			["f3"],
			"a foreground boundary covers everything before it",
		);
		assert.deepEqual(
			regionOf(
				chain(
					longUser("a1"),
					longUser("a2"),
					previous(null, "a4"),
					longUser("a3"),
					assistant("a4"),
					longUser("a5"),
				),
			),
			["a3"],
			"a covered entry after the boundary is ignored",
		);
	});

	test("the projection keeps a tail from the first entry and ignores covered entries it cannot use", () => {
		const projected = (entries: SessionEntry[]) =>
			buildSessionProjection(entries).entries.map((item) => [item.sourceEntry.id, item.messages.length]);
		const ids = (entries: SessionEntry[]) => buildContextEntries(entries).map((entry) => entry.id);

		const keptFromFirst = chain(user("p1"), user("p2"), previous("p1", "p2"), user("after"));
		assert.deepEqual(projected(keptFromFirst), [
			["b", 1],
			["p1", 0],
			["p2", 0],
			["after", 1],
		]);
		assert.deepEqual(ids(keptFromFirst), ["b", "p1", "p2", "after"]);

		const coveredFirst = chain(user("p1"), user("p2"), previous(null, "p1"), user("after"));
		assert.deepEqual(ids(coveredFirst), ["b", "p2", "after"]);

		const unknownCovered = chain(user("p1"), user("p2"), previous("p1", "gone"), user("after"));
		assert.deepEqual(projected(unknownCovered), [
			["b", 1],
			["p1", 0],
			["p2", 0],
			["after", 1],
		]);

		const selfCovered = chain(user("p1"), user("p2"), previous("p1", "b"), user("after"));
		const boundaryText = (entries: SessionEntry[]) =>
			JSON.stringify((buildSessionProjection(entries).messages[0] as { content: unknown }).content);
		assert.deepEqual(projected(selfCovered), projected(unknownCovered));
		assert.equal(
			boundaryText(selfCovered),
			boundaryText(unknownCovered),
			"a boundary that names itself covers everything before it",
		);

		const coveredAfter = chain(user("p1"), user("p2"), previous(null, "after"), user("after"));
		assert.deepEqual(ids(coveredAfter), ["b", "after"]);
		assert.deepEqual(projected(coveredAfter), [
			["b", 1],
			["after", 1],
		]);
		const keptWithCoveredAfter = chain(user("p1"), user("p2"), previous("p1", "after"), user("after"));
		assert.deepEqual(projected(keptWithCoveredAfter), projected(unknownCovered), "the entry after it still replays");
	});
});

describe("background compaction edge positions (#4330)", () => {
	test("a prefix of only labels is not safe to freeze", () => {
		assert.equal(findBackgroundCompactionSafePoint([label("l1", "x"), assistant("a1", ["c1"])]), -1);
	});

	test("only verbatim compaction entries are boundaries", () => {
		const legacy: SessionEntry = { ...boundary("legacy"), details: { strategy: "summary-v1" } } as SessionEntry;
		const customMessage: SessionEntry = {
			type: "custom_message",
			...base("cm"),
			customType: "x",
			content: "c",
			display: true,
			details: { strategy: "verbatim-lines" },
		};
		assert.equal(coveredThroughIndex([user("u1"), legacy, user("u2")]), -1);
		assert.equal(coveredThroughIndex([user("u1"), customMessage, user("u2")]), -1);
		assert.equal(coveredThroughIndex([user("u1"), { ...boundary("nd"), details: undefined } as SessionEntry]), -1);
	});

	test("a covered entry at or after its boundary covers only what precedes the boundary", () => {
		assert.equal(coveredThroughIndex([user("u1"), boundary("self", "self"), user("u2")]), 0);
		assert.equal(coveredThroughIndex([user("u1"), boundary("ahead", "later"), user("later")]), 0);
	});

	test("of two results for the same position, the later one wins", () => {
		const branch = [
			user("u1"),
			assistant("a1"),
			result("older", record("a1", { summary: "[User]: older" })),
			result("newer", record("a1", { summary: "[User]: newer" })),
		];
		assert.equal(selectReadyBackgroundCompaction(branch)?.entry.id, "newer");
	});

	test("ignores custom entries of other types even with a valid record", () => {
		const other: SessionEntry = { type: "custom", ...base("other"), customType: "someone-else", data: record("u1") };
		assert.equal(selectReadyBackgroundCompaction([user("u1"), other]), undefined);
	});

	test("a kept tail that starts at the frozen entry itself is valid", () => {
		const branch = [user("u1"), result("r1", record("u1", { firstKeptEntryId: "u1" }))];
		assert.equal(backgroundCompactionDiscardReason(branch, 1), undefined);
	});

	test("an edit of the frozen entry itself, or of the replayed tail, is judged by position", () => {
		const edited = [user("u1"), assistant("a1"), result("r1", record("a1")), contextEdit("x1", "a1")];
		assert.equal(backgroundCompactionDiscardReason(edited, 2), "context-edited");
		const labelled = [user("u1"), assistant("a1"), result("r1", record("a1")), label("l1", "u1")];
		assert.equal(backgroundCompactionDiscardReason(labelled, 2), undefined, "a label is not a context edit");
		const missingTarget = [user("u1"), result("r1", record("u1")), contextEdit("x1", "gone")];
		assert.equal(backgroundCompactionDiscardReason(missingTarget, 1), undefined);
	});

	test("a result that names itself as its prefix end is not on the branch before it", () => {
		assert.equal(backgroundCompactionDiscardReason([user("u1"), result("self", record("self"))], 1), "off-branch");
	});

	test("an index outside the branch is malformed", () => {
		assert.equal(backgroundCompactionDiscardReason([user("u1")], 5), "malformed");
	});

	test("idle and failed states serialize without absent fields", () => {
		assert.deepStrictEqual(rehydrateBackgroundCompactionState({ state: "idle" }), { state: "idle" });
		const config = new BackgroundCompactionConfigError({ source: "settings", field: "f", reason: "not-a-number" });
		const serialized = serializeBackgroundCompactionState({ state: "failed", error: config });
		assert.deepStrictEqual(Object.keys(serialized), ["state", "error"]);
		const back = rehydrateBackgroundCompactionState(serialized);
		assert.deepStrictEqual(Object.keys(back), ["state", "error"]);
		assert.ok(back.error instanceof BackgroundCompactionConfigError);
		assert.deepStrictEqual(
			serializeBackgroundCompactionState({ state: "running", upToEntryId: "u", startedAt: "t" }),
			{ state: "running", upToEntryId: "u", startedAt: "t" },
		);
	});
});

describe("BackgroundCompactionError guards and envelopes (#4330)", () => {
	const errorInstances = () => ({
		BackgroundCompactionPlanningError: new BackgroundCompactionPlanningError({ upToEntryId: "u", attempt: 1 }),
		BackgroundCompactionNotCompactableError: new BackgroundCompactionNotCompactableError({ upToEntryId: "u" }),
		BackgroundCompactionPersistError: new BackgroundCompactionPersistError({ upToEntryId: "u" }),
		BackgroundCompactionCommitError: new BackgroundCompactionCommitError({
			upToEntryId: "u",
			resultEntryId: "r",
			attempt: 1,
		}),
		BackgroundCompactionDiscardedError: new BackgroundCompactionDiscardedError({
			upToEntryId: "u",
			reason: "malformed",
		}),
		BackgroundCompactionConfigError: new BackgroundCompactionConfigError({
			source: "sdk",
			field: "f",
			reason: "out-of-range",
		}),
	});

	const guards = {
		BackgroundCompactionPlanningError: isBackgroundCompactionPlanningError,
		BackgroundCompactionNotCompactableError: isBackgroundCompactionNotCompactableError,
		BackgroundCompactionPersistError: isBackgroundCompactionPersistError,
		BackgroundCompactionCommitError: isBackgroundCompactionCommitError,
		BackgroundCompactionDiscardedError: isBackgroundCompactionDiscardedError,
		BackgroundCompactionConfigError: isBackgroundCompactionConfigError,
	};

	test("each guard accepts its own class, here and structurally, and nothing else", () => {
		for (const [guardName, guard] of Object.entries(guards)) {
			for (const [name, instance] of Object.entries(errorInstances())) {
				const structural = { name, code: instance.code };
				assert.equal(guard(instance), guardName === name, `${guardName}(${name})`);
				assert.equal(guard(structural), guardName === name, `${guardName}(structural ${name})`);
			}
			assert.equal(guard({ name: guardName, code: "unknown-code" }), false);
			assert.equal(guard(null), false);
		}
		for (const instance of Object.values(errorInstances())) assert.equal(isBackgroundCompactionError(instance), true);
	});

	test("each class keeps its phase through serialization", () => {
		assert.equal(errorInstances().BackgroundCompactionNotCompactableError.phase, "plan");
		assert.equal(errorInstances().BackgroundCompactionPlanningError.phase, "plan");
		assert.equal(errorInstances().BackgroundCompactionCommitError.phase, "commit");
		const persistPhase = new BackgroundCompactionDiscardedError({
			upToEntryId: "u",
			reason: "off-branch",
			phase: "persist",
		});
		const back = rehydrateBackgroundCompactionError(serializeBackgroundCompactionError(persistPhase));
		assert.equal(back.phase, "persist");
		const commitPhase = rehydrateBackgroundCompactionError(
			serializeBackgroundCompactionError(errorInstances().BackgroundCompactionDiscardedError),
		);
		assert.equal(commitPhase.phase, "commit");
	});

	test("an envelope missing any field its class needs rehydrates into the family base", () => {
		const envelope = (
			name: string,
			fields: Record<string, string | number>,
		): SerializedBackgroundCompactionError => ({
			name,
			code: "planner-failed",
			message: "m",
			hint: "h",
			retryable: false,
			phase: "plan",
			fields,
		});
		for (const mismatched of [
			envelope("BackgroundCompactionPlanningError", { attempt: 1 }),
			envelope("BackgroundCompactionPlanningError", { upToEntryId: 5, attempt: 1 }),
			envelope("BackgroundCompactionPlanningError", { upToEntryId: "u", attempt: "1" }),
			envelope("BackgroundCompactionNotCompactableError", {}),
			envelope("BackgroundCompactionPersistError", {}),
			envelope("BackgroundCompactionCommitError", { resultEntryId: "r", attempt: 1 }),
			envelope("BackgroundCompactionCommitError", { upToEntryId: "u", attempt: 1 }),
			envelope("BackgroundCompactionCommitError", { upToEntryId: "u", resultEntryId: "r" }),
			envelope("BackgroundCompactionDiscardedError", { reason: "superseded" }),
			envelope("BackgroundCompactionDiscardedError", { upToEntryId: "u" }),
			envelope("BackgroundCompactionConfigError", { source: "sdk", reason: "out-of-range" }),
			envelope("BackgroundCompactionConfigError", { field: "f", reason: "out-of-range" }),
			envelope("BackgroundCompactionConfigError", { source: "sdk", field: "f" }),
		]) {
			const back = rehydrateBackgroundCompactionError(mismatched);
			assert.equal(back.constructor.name, "RehydratedBackgroundCompactionError", JSON.stringify(mismatched.fields));
			assert.equal(back.name, mismatched.name);
		}
	});

	test("an envelope keeps only the causes that exist", () => {
		const causeless = serializeBackgroundCompactionError(errorInstances().BackgroundCompactionPersistError);
		assert.equal("cause" in causeless, false);
		assert.equal("cause" in rehydrateBackgroundCompactionError(causeless), false);
		const chained = serializeBackgroundCompactionError(
			new BackgroundCompactionPersistError(
				{ upToEntryId: "u" },
				{ cause: new Error("outer", { cause: new Error("inner") }) },
			),
		);
		const outer = chained.cause;
		assert.ok(outer && !("code" in outer));
		assert.equal(outer.message, "outer");
		assert.equal(outer.cause?.message, "inner");
		assert.equal("cause" in (outer.cause ?? {}), false);
		const rehydrated = rehydrateBackgroundCompactionError(chained);
		assert.equal((rehydrated.cause as Error).message, "outer");
		assert.equal(((rehydrated.cause as Error).cause as Error).message, "inner");
		assert.equal("cause" in ((rehydrated.cause as Error).cause as Error), false);
	});

	test("a structural cause from another realm serializes without class fields", () => {
		const foreign = {
			name: "BackgroundCompactionPersistError",
			code: "result-persist-failed",
			message: "x",
			hint: "h",
		};
		const serialized = serializeBackgroundCompactionError(
			new BackgroundCompactionPlanningError({ upToEntryId: "u", attempt: 1 }, { cause: foreign }),
		);
		assert.deepEqual((serialized.cause as SerializedBackgroundCompactionError).fields, {});
		const primitive = serializeBackgroundCompactionError(
			new BackgroundCompactionPlanningError({ upToEntryId: "u", attempt: 1 }, { cause: "text cause" }),
		);
		assert.deepEqual(primitive.cause, { name: "string", message: "text cause" });
	});

	test("retryability stops at a non-error in the chain", () => {
		assert.equal(
			isRetryableBackgroundCompactionError({ cause: new BackgroundCompactionPersistError({ upToEntryId: "u" }) }),
			false,
		);
		assert.equal(isRetryableBackgroundCompactionError("text"), false);
		assert.equal(isRetryableBackgroundCompactionError(null), false);
	});
});
