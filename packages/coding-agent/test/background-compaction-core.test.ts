import assert from "node:assert/strict";
import type { AssistantMessage, ToolResultMessage, Usage } from "@bastani/pi-ai/compat";
import { describe, test } from "vitest";
import { estimateCompactionCacheMiss } from "../src/core/cache-stats.ts";
import {
	BACKGROUND_COMPACTION_RESULT_TYPE,
	BACKGROUND_COMPACTION_RETRY_BASE_MS,
	BACKGROUND_COMPACTION_RETRY_MAX_MS,
	type BackgroundCompactionResultRecord,
	backgroundCompactionDiscardReason,
	backgroundCompactionRetryDelayMs,
	backgroundCompactionThresholdTokens,
	coveredThroughIndex,
	DEFAULT_BACKGROUND_COMPACTION_THRESHOLD_PERCENT,
	discardedBackgroundCompaction,
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
	BackgroundCompactionConfigError,
	BackgroundCompactionDiscardedError,
	BackgroundCompactionError,
	BackgroundCompactionNotCompactableError,
	BackgroundCompactionPersistError,
	BackgroundCompactionPlanningError,
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
		const discarded = discardedBackgroundCompaction(branch, "r1");
		assert.ok(discarded instanceof BackgroundCompactionDiscardedError);
		assert.equal(discarded.reason, "superseded");
		assert.equal(discarded.upToEntryId, "u1");
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
		assert.equal(discardedBackgroundCompaction(branch, "r1")?.upToEntryId, "r1");
		assert.equal(discardedBackgroundCompaction(branch, "missing"), undefined);
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
				"not-a-number",
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
					cacheWrite: 0,
					cost: { input: 0.003, output: 0, cacheRead: 0.0027, cacheWrite: 0, total: 0.0057 },
				}),
			),
		];
		const miss = estimateCompactionCacheMiss(branch, 4_000, models);
		assert.equal(miss?.expectedMissedTokens, 4_000);
		assert.ok(Math.abs((miss?.expectedMissedCost ?? 0) - 4_000 * (0.003 / 1_000 - 0.0027 / 9_000)) < 1e-12);
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
