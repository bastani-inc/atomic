import { describe } from "vitest";
import * as sdk from "../../packages/workflows/src/sdk-surface.js";
import { rehydrateError } from "../../packages/workflows/src/shared/error-codec.js";
import {
	deserializeRunEvictionError,
	findRunEvictionError,
	isRunEvictedError,
	isRunEvictionConfigError,
	isRunEvictionError,
	isRunReplayError,
	RunEvictedError,
	RunEvictionConfigError,
	RunEvictionError,
	RunReplayError,
	type SerializedRunEvictionError,
} from "../../packages/workflows/src/shared/run-eviction-errors.js";
import { typedFailureDetail } from "../../packages/workflows/src/shared/typed-failure-detail.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { assert, test } from "./executor-shared.js";

useTemporaryAgentDir();

const RUN = "run-errors";

function crossProcess<T extends { toJSON(): SerializedRunEvictionError }>(error: T): SerializedRunEvictionError {
	return JSON.parse(JSON.stringify(error.toJSON())) as SerializedRunEvictionError;
}

describe("the RunEvictionError family (#4373)", () => {
	test("each class has its own name, code and hint, is not retryable, and keeps only the fields it was given (#4373)", () => {
		const config = new RunEvictionConfigError({
			source: "sdk",
			field: "evictWhenWaiting",
			value: "1",
			reason: "value",
		});
		const replay = new RunReplayError({ runId: RUN, replayKeys: ["stage:a:1"], toolCallIds: ["call-a"] });
		const evicted = new RunEvictedError({ runId: RUN });
		assert.deepEqual(
			[config, replay, evicted].map((error) => [error.name, error.code, error.retryable]),
			[
				["RunEvictionConfigError", "invalid-evict-when-waiting", false],
				["RunReplayError", "replay-diverged", false],
				["RunEvictedError", "run-evicted", false],
			],
		);
		for (const error of [config, replay, evicted]) {
			assert.ok(error instanceof RunEvictionError);
			assert.ok(error instanceof Error);
			assert.ok(error.message.endsWith(error.hint), error.message);
			assert.ok(error.message.includes(`(${error.code}). `), error.message);
		}
		assert.deepEqual(replay.fields, { runId: RUN, replayKeys: ["stage:a:1"], toolCallIds: ["call-a"] });
		assert.equal(
			replay.message.split(" (replay-diverged)")[0],
			`Cannot rebuild run ${RUN}: the replayed workflow body never waited again on the detached calls of stage:a:1`,
		);
		assert.equal(
			new RunReplayError({ runId: RUN, replayKeys: [], toolCallIds: [] }).message.split(" (replay-diverged)")[0],
			`Cannot rebuild run ${RUN}: the replayed workflow body never waited again on the detached calls of its waiting stages`,
		);
		assert.equal(
			evicted.message.split(" (run-evicted)")[0],
			`run ${RUN} was evicted from memory while its stages waited; this execution of its workflow body is over`,
		);
		assert.ok(replay.hint.includes("ctx.tool"));
		assert.ok(evicted.hint.includes("rebuilt run carries on"));
	});

	test("a config refusal names what was refused for each reason (#4373)", () => {
		const backend = new RunEvictionConfigError({
			source: "sdk",
			field: "evictWhenWaiting",
			value: "true",
			reason: "backend",
		});
		const continuation = new RunEvictionConfigError({
			source: "sdk",
			field: "evictWhenWaiting",
			value: "true",
			reason: "continuation",
			runId: RUN,
		});
		assert.equal(
			backend.message.split(" (invalid")[0],
			"Cannot evict the run while it waits: its durable backend is not a run journal",
		);
		assert.ok(backend.hint.startsWith("Run the workflow on a run journal"));
		assert.equal(
			continuation.message.split(" (invalid")[0],
			`Cannot evict run ${RUN} while it waits: it continues another run`,
		);
		const base = new RunEvictionError("invalid-evict-when-waiting", { field: "evictWhenWaiting", value: "x" });
		assert.equal(base.message.split(" (invalid")[0], "Invalid evictWhenWaiting: x");
		assert.ok(base.hint.startsWith("Set evictWhenWaiting to true, false, or { afterMs }"));
		assert.equal(
			new RunEvictionError("invalid-evict-when-waiting", { reason: "value" }).message.split(" (invalid")[0],
			"Invalid evictWhenWaiting: undefined",
		);
		assert.equal(new RunEvictionError("run-evicted", {}, { retryable: true }).retryable, true);
	});

	test("every class crosses a process boundary as itself, with its fields and its cause chain (#4373)", () => {
		const cause = Object.assign(new Error("journal unreachable", { cause: new Error("socket closed") }), {
			code: "ECONNRESET",
		});
		const originals: RunEvictionError[] = [
			new RunEvictionConfigError({ source: "sdk", field: "evictWhenWaiting", value: "1", reason: "value" }),
			new RunReplayError({ runId: RUN, replayKeys: ["stage:a:1"], toolCallIds: ["call-a"] }),
			new RunEvictedError({ runId: RUN }),
			new RunEvictionError("run-evicted", { runId: RUN }, { cause }),
		];
		const guards = [isRunEvictionConfigError, isRunReplayError, isRunEvictedError, isRunEvictionError];
		for (const [index, original] of originals.entries()) {
			const serialized = crossProcess(original);
			const rebuilt = deserializeRunEvictionError(serialized);
			assert.equal(rebuilt.constructor, original.constructor);
			assert.equal(rebuilt.name, original.name);
			assert.equal(rebuilt.code, original.code);
			assert.equal(rebuilt.message, original.message);
			assert.equal(rebuilt.hint, original.hint);
			assert.deepEqual(rebuilt.fields, original.fields);
			assert.ok(guards[index]!(rebuilt));
			assert.ok(guards[index]!(serialized), "the guard matches the plain serialized copy");
			assert.ok(isRunEvictionError(serialized));
		}
		const withCause = deserializeRunEvictionError(crossProcess(originals[3]!));
		const rebuiltCause = withCause.cause as Error & { code?: string; cause?: Error };
		assert.equal(rebuiltCause.message, "journal unreachable");
		assert.equal(rebuiltCause.code, "ECONNRESET");
		assert.equal(rebuiltCause.cause?.message, "socket closed");
		assert.equal(crossProcess(new RunEvictedError({ runId: RUN })).cause, undefined);
	});

	test("an unknown name rebuilds as the family base with its name, code, message and retryability kept (#4373)", () => {
		const rebuilt = deserializeRunEvictionError({
			name: "RunEvictionFutureError",
			code: "replay-diverged",
			message: "from a newer process",
			hint: "upgrade",
			retryable: true,
			fields: { runId: RUN },
			cause: { name: "Error", message: "inner" },
		});
		assert.equal(rebuilt.constructor, RunEvictionError);
		assert.equal(rebuilt.name, "RunEvictionFutureError");
		assert.equal(rebuilt.code, "replay-diverged");
		assert.equal(rebuilt.message, "from a newer process");
		assert.equal(rebuilt.retryable, true);
		assert.equal((rebuilt.cause as Error).message, "inner");
		assert.ok(isRunEvictionError(rebuilt));
	});

	test("guards check the class's own name and codes, and find walks at most eight causes (#4373)", () => {
		const shape = (name: string, code: string) => ({ name, code });
		assert.ok(isRunReplayError(shape("RunReplayError", "replay-diverged")));
		assert.equal(isRunReplayError(shape("RunReplayError", "run-evicted")), false);
		assert.equal(isRunReplayError(shape("RunEvictedError", "replay-diverged")), false);
		assert.equal(isRunEvictedError(shape("RunEvictedError", "replay-diverged")), false);
		assert.equal(isRunEvictionConfigError(shape("RunEvictionConfigError", "run-evicted")), false);
		assert.ok(isRunEvictionError(shape("RunEvictionError", "run-evicted")));
		assert.equal(isRunEvictionError(shape("StageWaitError", "run-evicted")), false);
		assert.equal(isRunEvictionError(shape("RunEvictionError", "stage-busy")), false);
		assert.equal(isRunEvictionError({ name: "RunEvictionError", code: 7 }), false);
		assert.equal(isRunEvictionError({ code: "run-evicted" }), false);
		assert.equal(isRunEvictionError(null), false);
		assert.equal(isRunEvictionError("RunEvictionError"), false);

		const typed = new RunEvictedError({ runId: RUN });
		let wrapped: unknown = typed;
		for (let depth = 0; depth < 7; depth++) wrapped = new Error(`wrap ${depth}`, { cause: wrapped });
		assert.equal(findRunEvictionError(wrapped), typed);
		assert.equal(findRunEvictionError(new Error("deeper", { cause: wrapped })), undefined);
		assert.equal(findRunEvictionError(new Error("plain")), undefined);
	});

	test("a run that failed on a family error carries it as its failure detail, rebuilt on the other side (#4373)", () => {
		const failure = new Error("run failed", {
			cause: new RunReplayError({ runId: RUN, replayKeys: ["stage:a:1"], toolCallIds: ["call-a"] }),
		});
		const detail = typedFailureDetail(failure);
		assert.equal(detail?.family, "run-eviction");
		const rebuilt = rehydrateError(JSON.parse(JSON.stringify(detail)));
		assert.ok(rebuilt instanceof RunReplayError);
		assert.equal(rebuilt.code, "replay-diverged");
		assert.deepEqual(rebuilt.fields, { runId: RUN, replayKeys: ["stage:a:1"], toolCallIds: ["call-a"] });
	});

	test("a divergence names its stages, or the waiting stages when none is named (#4373)", () => {
		assert.equal(
			new RunEvictionError("replay-diverged", { runId: RUN }).message.split(" (replay-diverged)")[0],
			`Cannot rebuild run ${RUN}: the replayed workflow body never waited again on the detached calls of its waiting stages`,
		);
		assert.equal(
			new RunEvictionError("replay-diverged", { replayKeys: ["stage:a:1", "stage:b:1"] }).message.split(
				" (replay-diverged)",
			)[0],
			"Cannot rebuild the run: the replayed workflow body never waited again on the detached calls of stage:a:1, stage:b:1",
		);
	});

	test("a serialized cause keeps names, messages and string codes, stops at eight levels, and names a thrown non-error (#4373)", () => {
		let cause: unknown = Object.assign(new Error("level 10"), { code: "code-10" });
		cause = Object.assign(new Error("level 9", { cause }), { code: "code-9" });
		for (let level = 8; level >= 1; level--)
			cause = Object.assign(new Error(`level ${level}`, { cause }), { code: `code-${level}` });
		const serialized = new RunEvictedError({ runId: RUN }, { cause }).toJSON();
		const levels: { name: string; message: string; code?: string }[] = [];
		for (let current = serialized.cause; current !== undefined; current = current.cause)
			levels.push({
				name: current.name,
				message: current.message,
				...(current.code === undefined ? {} : { code: current.code }),
			});
		assert.equal(levels.length, 9);
		assert.deepEqual(levels[0], { name: "Error", message: "level 1", code: "code-1" });
		assert.deepEqual(levels[7], { name: "Error", message: "level 8", code: "code-8" });
		assert.deepEqual(
			levels[8],
			{ name: "Error", message: "level 9" },
			"the ninth level is named only, with no cause",
		);
		assert.deepEqual(new RunEvictedError({ runId: RUN }, { cause: "plain text" }).toJSON().cause, {
			name: "Error",
			message: "plain text",
		});
		const typed = Object.assign(new TypeError("typed"), { code: 7 });
		assert.deepEqual(new RunEvictedError({ runId: RUN }, { cause: typed }).toJSON().cause, {
			name: "TypeError",
			message: "typed",
		});
	});

	test("a rebuilt cause has a code only when one crossed (#4373)", () => {
		const rebuilt = deserializeRunEvictionError({
			...new RunReplayError({ runId: RUN, replayKeys: [], toolCallIds: [] }).toJSON(),
			cause: { name: "RangeError", message: "outer", cause: { name: "Error", message: "inner", code: "EIO" } },
		});
		assert.ok(rebuilt instanceof RunReplayError);
		const outer = rebuilt.cause as Error & { code?: string; cause?: Error & { code?: string } };
		assert.equal(outer.name, "RangeError");
		assert.equal("code" in outer, false);
		assert.equal(outer.cause?.code, "EIO");
	});

	test("a rebuilt error keeps the message it crossed with, even when this side would word it otherwise (#4373)", () => {
		for (const original of [
			new RunEvictionConfigError({ source: "sdk", field: "evictWhenWaiting", value: "1", reason: "value" }),
			new RunReplayError({ runId: RUN, replayKeys: [], toolCallIds: [] }),
			new RunEvictedError({ runId: RUN }),
		]) {
			const rebuilt = deserializeRunEvictionError({ ...original.toJSON(), message: "worded by a newer process" });
			assert.equal(rebuilt.message, "worded by a newer process");
			assert.equal(rebuilt.constructor, original.constructor);
		}
	});

	test("guards refuse values that are not errors of the family (#4373)", () => {
		assert.equal(isRunEvictionError(undefined), false);
		assert.equal(isRunEvictionError(42), false);
		assert.equal(isRunEvictionError({ name: 7, code: "run-evicted" }), false);
		assert.equal(isRunEvictedError({ name: "RunEvictedError", code: 7 }), false);
		assert.equal(isRunEvictedError({ name: "RunEvictedError" }), false);
		assert.equal(isRunEvictedError("RunEvictedError"), false);
		assert.equal(findRunEvictionError(new Error("outer", { cause: "a string cause" })), undefined);
		assert.equal(findRunEvictionError(new Error("outer", { cause: 0 })), undefined);
		assert.equal(findRunEvictionError(null), undefined);
		assert.equal(findRunEvictionError(new Error("outer", { cause: null })), undefined);
	});

	test("the family, its guards and the eviction default are exported from the SDK (#4373)", () => {
		assert.equal(sdk.RunEvictionError, RunEvictionError);
		assert.equal(sdk.RunEvictionConfigError, RunEvictionConfigError);
		assert.equal(sdk.RunReplayError, RunReplayError);
		assert.equal(sdk.RunEvictedError, RunEvictedError);
		assert.equal(sdk.isRunEvictionError, isRunEvictionError);
		assert.equal(sdk.isRunEvictionConfigError, isRunEvictionConfigError);
		assert.equal(sdk.isRunReplayError, isRunReplayError);
		assert.equal(sdk.isRunEvictedError, isRunEvictedError);
		assert.equal(sdk.findRunEvictionError, findRunEvictionError);
		assert.equal(sdk.deserializeRunEvictionError, deserializeRunEvictionError);
		assert.equal(sdk.DEFAULT_EVICT_WHEN_WAITING_AFTER_MS, 60_000);
	});
});
