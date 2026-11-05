import assert from "node:assert/strict";
import type { DetachedToolResult } from "@bastani/atomic";
import { StorageWriteLockTimeoutError, StorageWriterQueueUnusableError } from "@bastani/atomic/storage";
import { afterEach, describe, test, vi } from "vitest";
import { ExtensionStartupError } from "../../packages/coding-agent/src/core/extension-startup-failure.js";
import {
	DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS,
	MAX_RELEASE_WHEN_WAITING_AFTER_MS,
	parseReleaseWhenWaiting,
	recordStageWaitToolResults,
	resolveStageReleasePolicy,
	STAGE_WAIT_RETRY_BASE_DELAY_MS,
	STAGE_WAIT_RETRY_BUDGET_MS,
	stageReopenFailureCause,
	stageWaitRetryDelayMs,
	stageWaitToolResults,
	validateStepsReleaseWhenWaiting,
} from "../../packages/workflows/src/shared/stage-wait.js";
import {
	isStageWaitConfigError,
	StageRehydrationError,
	type StageWaitConfigError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { TOOL_PAYLOAD_VALUE_LIMIT } from "../../packages/workflows/src/shared/tool-payload-bounds.js";

function configFailure(run: () => unknown): StageWaitConfigError {
	try {
		run();
	} catch (error) {
		assert.ok(isStageWaitConfigError(error), `expected a StageWaitConfigError, got ${String(error)}`);
		return error;
	}
	assert.fail("expected the value to be refused");
}

describe("releaseWhenWaiting, validated where it enters the SDK (#4309)", () => {
	test("false keeps a stage resident, true and the unset value say nothing more, and an object sets its threshold (#4309)", () => {
		assert.equal(parseReleaseWhenWaiting(undefined), undefined);
		assert.equal(parseReleaseWhenWaiting(false), null);
		assert.deepEqual(parseReleaseWhenWaiting(true), { afterMs: DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS });
		assert.deepEqual(parseReleaseWhenWaiting({ afterMs: 0 }), { afterMs: 0 });
		assert.deepEqual(parseReleaseWhenWaiting({ afterMs: 1_500 }), { afterMs: 1_500 });
		assert.deepEqual(parseReleaseWhenWaiting({ afterMs: MAX_RELEASE_WHEN_WAITING_AFTER_MS }), {
			afterMs: MAX_RELEASE_WHEN_WAITING_AFTER_MS,
		});
	});

	test("a threshold outside 0 to the timer maximum, or not a finite number, is refused with the field and the value it was given (#4309)", () => {
		const refused: readonly [unknown, string][] = [
			[{ afterMs: -1 }, "-1"],
			[{ afterMs: MAX_RELEASE_WHEN_WAITING_AFTER_MS + 1 }, String(MAX_RELEASE_WHEN_WAITING_AFTER_MS + 1)],
			[{ afterMs: Number.NaN }, "NaN"],
			[{ afterMs: Number.POSITIVE_INFINITY }, "Infinity"],
			[{ afterMs: "500" }, '"500"'],
			[{ afterMs: null }, "null"],
			[{}, "undefined"],
		];
		for (const [value, shown] of refused) {
			const failure = configFailure(() => parseReleaseWhenWaiting(value as never, "review"));
			assert.deepEqual(failure.fields, {
				source: "sdk",
				field: "releaseWhenWaiting.afterMs",
				value: shown,
				stageName: "review",
			});
		}
	});

	test("a value that is neither a boolean nor an object is refused as the whole setting, shown the way it was given (#4309)", () => {
		const refused: readonly [unknown, string][] = [
			["soon", '"soon"'],
			[5, "5"],
			[null, "null"],
		];
		for (const [value, shown] of refused) {
			const failure = configFailure(() => parseReleaseWhenWaiting(value as never));
			assert.deepEqual(failure.fields, { source: "sdk", field: "releaseWhenWaiting", value: shown });
			assert.equal(Object.hasOwn(failure.fields, "stageName"), false);
		}
	});

	test("every step of a chain or parallel call is checked with its own value, else the call's, and the call's own value too (#4309)", () => {
		validateStepsReleaseWhenWaiting(
			[{ name: "a" }, { name: "b", releaseWhenWaiting: { afterMs: 10 } }, { name: "c", releaseWhenWaiting: false }],
			true,
		);
		// A step's own value is the one checked, so a bad shared value hides behind a good one only for that step.
		validateStepsReleaseWhenWaiting([{ name: "a", releaseWhenWaiting: true }], undefined);

		const ownInvalid = configFailure(() =>
			validateStepsReleaseWhenWaiting([{ name: "a" }, { name: "b", releaseWhenWaiting: { afterMs: -5 } }], true),
		);
		assert.equal(ownInvalid.fields.stageName, "b");

		const inheritedInvalid = configFailure(() => validateStepsReleaseWhenWaiting([{ name: "a" }], { afterMs: -1 }));
		assert.equal(inheritedInvalid.fields.stageName, "a");

		const sharedInvalid = configFailure(() =>
			validateStepsReleaseWhenWaiting([{ name: "a", releaseWhenWaiting: true }], { afterMs: -1 }),
		);
		assert.equal(Object.hasOwn(sharedInvalid.fields, "stageName"), false);
	});

	test("a stage's own setting wins over the run's, false keeps it resident, and with neither it releases after the default (#4309)", () => {
		const runPolicy = { afterMs: 5 };
		assert.deepEqual(resolveStageReleasePolicy(undefined, undefined, "s"), {
			afterMs: DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS,
		});
		assert.deepEqual(resolveStageReleasePolicy(undefined, runPolicy, "s"), runPolicy);
		assert.equal(resolveStageReleasePolicy(undefined, null, "s"), undefined);
		assert.equal(resolveStageReleasePolicy(false, runPolicy, "s"), undefined);
		assert.deepEqual(resolveStageReleasePolicy({ afterMs: 7 }, runPolicy, "s"), { afterMs: 7 });
		assert.deepEqual(resolveStageReleasePolicy({ afterMs: 7 }, null, "s"), { afterMs: 7 });
		assert.deepEqual(resolveStageReleasePolicy(true, runPolicy, "s"), {
			afterMs: DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS,
		});
		assert.equal(
			configFailure(() => resolveStageReleasePolicy({ afterMs: -1 }, runPolicy, "s")).fields.stageName,
			"s",
		);
	});
});

describe("the wait between attempts to reopen a session or write a record (#4309)", () => {
	afterEach(() => vi.restoreAllMocks());

	test("each wait is four times the one before, centred on the base delay, varying by a fifth either way (#4309)", () => {
		const random = vi.spyOn(Math, "random");
		random.mockReturnValue(0.5);
		assert.deepEqual([1, 2, 3].map(stageWaitRetryDelayMs), [500, 2_000, 8_000]);
		random.mockReturnValue(0);
		assert.deepEqual([1, 2, 3].map(stageWaitRetryDelayMs), [400, 1_600, 6_400]);
		random.mockReturnValue(1);
		assert.deepEqual([1, 2, 3].map(stageWaitRetryDelayMs), [600, 2_400, 9_600]);
		random.mockReturnValue(0.25);
		assert.equal(stageWaitRetryDelayMs(1), 450);
		// Rounded, not cut: 500 x 0.8492 = 424.6.
		random.mockReturnValue(0.123);
		assert.equal(stageWaitRetryDelayMs(1), 425);
		assert.equal(STAGE_WAIT_RETRY_BASE_DELAY_MS, 500);
	});

	test("the backoff budget is the longest the waits between the attempts can add up to (#4309)", () => {
		// Two waits between three attempts, each at its longest: 500 x 1.2 and 2000 x 1.2.
		assert.equal(Math.round(STAGE_WAIT_RETRY_BUDGET_MS), 3_000);
		vi.spyOn(Math, "random").mockReturnValue(1);
		assert.ok(stageWaitRetryDelayMs(1) + stageWaitRetryDelayMs(2) <= STAGE_WAIT_RETRY_BUDGET_MS + 1);
	});
});

class Named extends Error {
	constructor(
		override readonly name: string,
		message = name,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

/** `depth` levels of wrappers around `inner`, outermost first. */
function nested(inner: Error, depth: number): Error {
	let error = inner;
	for (let level = 0; level < depth; level++) error = new Error(`wrapper ${level}`, { cause: error });
	return error;
}

describe("why a released stage's session failed to reopen (#4309)", () => {
	test("a failure that is nothing the store or the network did is `other` (#4309)", () => {
		assert.equal(stageReopenFailureCause(new Error("no provider can serve this model")), "other");
		assert.equal(stageReopenFailureCause("a string"), "other");
		assert.equal(stageReopenFailureCause(undefined), "other");
		assert.equal(stageReopenFailureCause(null), "other");
		assert.equal(stageReopenFailureCause({ name: 5, code: 5 }), "other");
		assert.equal(stageReopenFailureCause(Object.assign(new Error("x"), { code: "ENOENT" })), "other");
		assert.equal(stageReopenFailureCause(Object.assign(new Error("x"), { code: 104 })), "other");
		assert.equal(stageReopenFailureCause(new Named("StorageUnavailable")), "other");
	});

	test("a session the store does not hold is `session-not-found` at any depth of the chain, and wins over a transient cause above it (#4309)", () => {
		assert.equal(stageReopenFailureCause(new Named("SessionNotFoundError")), "session-not-found");
		assert.equal(stageReopenFailureCause(nested(new Named("SessionNotFoundError"), 3)), "session-not-found");
		const transientAbove = Object.assign(new Error("unreachable", { cause: new Named("SessionNotFoundError") }), {
			code: "ECONNRESET",
		});
		assert.equal(stageReopenFailureCause(transientAbove), "session-not-found");
	});

	test("a store that is unreachable, or an outcome it cannot tell, is transient, found by name wherever it sits in the chain (#4309)", () => {
		assert.equal(stageReopenFailureCause(new Named("StorageUnavailableError")), "transient");
		assert.equal(stageReopenFailureCause(new Named("StorageOutcomeUnknownError")), "transient");
		assert.equal(stageReopenFailureCause(nested(new Named("StorageUnavailableError"), 4)), "transient");
		assert.equal(stageReopenFailureCause({ name: "StorageUnavailableError" }), "transient");
	});

	test("each network error code under the failure is transient, and a code that is not one is not (#4309)", () => {
		for (const code of ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EAI_AGAIN"])
			assert.equal(
				stageReopenFailureCause(new Error("store", { cause: Object.assign(new Error("net"), { code }) })),
				"transient",
				code,
			);
		assert.equal(
			stageReopenFailureCause(new Error("store", { cause: Object.assign(new Error("net"), { code: "EACCES" }) })),
			"other",
		);
	});

	test("a failure that says it is retryable, or an extension startup that failed on timing, is transient (#4309)", () => {
		assert.equal(stageReopenFailureCause(new StageRehydrationError({ runId: "run", stageId: "stage" })), "transient");
		assert.equal(
			stageReopenFailureCause(
				new ExtensionStartupError([
					{ extensionPath: "/ext", event: "session_start", message: "connect ECONNREFUSED" },
				]),
			),
			"transient",
		);
		assert.equal(
			stageReopenFailureCause(
				new ExtensionStartupError([{ extensionPath: "/ext", event: "session_start", message: "bad manifest" }]),
			),
			"other",
		);
	});

	test("a store's write-lock timeout is transient, wrapped or copied from another process; an unusable writers' queue is not (#4309)", () => {
		const descriptor = { adapter: "sqlite", location: "/shared/sessions.db" };
		const lockTimeout = new StorageWriteLockTimeoutError(descriptor, {
			timeoutMs: 5_000,
			elapsedMs: 5_000,
			phase: "queued",
		});
		assert.equal(stageReopenFailureCause(lockTimeout), "transient");
		assert.equal(stageReopenFailureCause(nested(lockTimeout, 3)), "transient");
		const copy = { name: "StorageWriteLockTimeoutError", code: "write-lock-timeout", retryable: true };
		assert.equal(stageReopenFailureCause(copy), "transient");
		assert.equal(stageReopenFailureCause({ ...copy, retryable: false }), "other");
		assert.equal(
			stageReopenFailureCause(
				new StorageWriterQueueUnusableError(descriptor, Object.assign(new Error("denied"), { code: "EACCES" })),
			),
			"other",
		);
	});

	test("only the first eight levels of the chain are read (#4309)", () => {
		// Seven wrappers put the cause at the eighth level, the last one read; eight put it at the ninth.
		assert.equal(stageReopenFailureCause(nested(new Named("SessionNotFoundError"), 7)), "session-not-found");
		assert.equal(stageReopenFailureCause(nested(new Named("SessionNotFoundError"), 8)), "other");
		assert.equal(stageReopenFailureCause(nested(new Named("StorageUnavailableError"), 7)), "transient");
		assert.equal(stageReopenFailureCause(nested(new Named("StorageUnavailableError"), 8)), "other");
		// A chain that ends in something that is not an object stops there.
		assert.equal(stageReopenFailureCause(new Error("a", { cause: "text" })), "other");
	});
});

function detached(overrides: Partial<DetachedToolResult["result"]> = {}, isError = false): DetachedToolResult {
	return {
		toolCallId: "call-1",
		toolName: "wait_for_ci",
		isError,
		result: { content: [{ type: "text", text: "ci passed" }], details: undefined, ...overrides },
	};
}

describe("the results a waiting stage was woken with, as it records them (#4309)", () => {
	test("a result keeps its identity, error flag and the parts the model reads, and drops absent optional fields (#4309)", () => {
		const [recorded] = recordStageWaitToolResults([detached({}, true)]);
		assert.deepEqual(recorded, {
			toolCallId: "call-1",
			toolName: "wait_for_ci",
			isError: true,
			content: [{ type: "text", text: "ci passed" }],
		});
		assert.equal(Object.hasOwn(recorded!, "details"), false);
		assert.equal(Object.hasOwn(recorded!, "structuredContent"), false);
		assert.deepEqual(recordStageWaitToolResults([]), []);
	});

	test("text keeps its signature when it has one, and images keep their data and type (#4309)", () => {
		const [recorded] = recordStageWaitToolResults([
			detached({
				content: [
					{ type: "text", text: "signed", textSignature: "sig-1" },
					{ type: "text", text: "plain" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
			}),
		]);
		assert.deepEqual(recorded?.content, [
			{ type: "text", text: "signed", textSignature: "sig-1" },
			{ type: "text", text: "plain" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		]);
		assert.equal(Object.hasOwn(recorded!.content[1]!, "textSignature"), false);
	});

	test("a result with no content records none, and details and structured content are kept when small and bounded when large (#4309)", () => {
		const [empty] = recordStageWaitToolResults([detached({ content: undefined as never })]);
		assert.deepEqual(empty?.content, []);

		const [small] = recordStageWaitToolResults([
			detached({ details: { passed: 12 }, structuredContent: { verdict: "ok" } }),
		]);
		assert.deepEqual(small?.details, { passed: 12 });
		assert.deepEqual(small?.structuredContent, { verdict: "ok" });

		const huge = "x".repeat(TOOL_PAYLOAD_VALUE_LIMIT * 4);
		const [large] = recordStageWaitToolResults([detached({ details: huge, structuredContent: { log: huge } })]);
		assert.equal(typeof large?.details, "string");
		assert.ok(String(large?.details).length < huge.length);
		assert.ok(JSON.stringify(large?.structuredContent).length < huge.length);
	});

	test("recorded results come back as the results a reopened session takes, in order, sharing no part objects with the record (#4309)", () => {
		const records = recordStageWaitToolResults([
			detached({ details: { passed: 12 }, structuredContent: { verdict: "ok" } }, true),
			{ ...detached(), toolCallId: "call-2" },
		]);
		const results = stageWaitToolResults(records);
		assert.deepEqual(
			results.map((result) => [result.toolCallId, result.toolName, result.isError]),
			[
				["call-1", "wait_for_ci", true],
				["call-2", "wait_for_ci", false],
			],
		);
		assert.deepEqual(results[0]?.result, {
			content: [{ type: "text", text: "ci passed" }],
			details: { passed: 12 },
			structuredContent: { verdict: "ok" },
		});
		assert.equal(Object.hasOwn(results[1]!.result, "structuredContent"), false);
		assert.equal(results[1]?.result.details, undefined);
		assert.notEqual(results[0]?.result.content[0], records[0]?.content[0]);
	});
});
