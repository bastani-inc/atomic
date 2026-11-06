import assert from "node:assert/strict";
import { SHARED_STORAGE_JOIN_HINT } from "@bastani/atomic/storage";
import { describe, test } from "vitest";
import type { ReleaseWhenWaiting } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import {
	DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS,
	MAX_RELEASE_WHEN_WAITING_AFTER_MS,
	parseReleaseWhenWaiting,
	resolveStageReleasePolicy,
} from "../../packages/workflows/src/shared/stage-wait.js";
import {
	deserializeStageWaitError,
	findStageWaitError,
	isStageRehydrationError,
	isStageReleaseError,
	isStageWaitConfigError,
	isStageWaitError,
	isStageWaitRecordError,
	isStageWakeError,
	type SerializedErrorCause,
	StageRehydrationError,
	StageReleaseError,
	StageWaitConfigError,
	StageWaitError,
	StageWaitRecordError,
	StageWakeError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import {
	isRetryableWorkflowError,
	WorkflowInfrastructureError,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";

/** The depth the family bounds cause chains and cause walks at; part of the documented contract. */
const CAUSE_DEPTH = 8;

/**
 * `levels` errors of `kind`, the outermost named `level <levels - 1>` and the innermost `level 0`, each the cause of the
 * one above it; `bottom` is the cause of the innermost.
 */
function causeChain(levels: number, bottom?: unknown, kind: ErrorConstructor = Error): Error {
	let chain: Error = new kind("level 0", bottom === undefined ? undefined : { cause: bottom });
	for (let level = 1; level < levels; level++) chain = new kind(`level ${level}`, { cause: chain });
	return chain;
}

function serializedDepth(cause: SerializedErrorCause | undefined): number {
	let depth = 0;
	for (let current = cause; current !== undefined; current = current.cause) depth += 1;
	return depth;
}

function structuralCopy(name: string, code: string): { name: string; code: string } {
	return { name, code };
}

describe("StageWaitError family: classes (#4309)", () => {
	test("every class has an explicit name, its code, a hint, an explicit retryable flag and its fields", () => {
		const base = new StageWaitError("session-unavailable", { runId: "run-1" });
		const config = new StageWaitConfigError({ source: "sdk", field: "releaseWhenWaiting", value: "1" });
		const busy = new StageReleaseError("stage-busy", { stageName: "implement" });
		const reopen = new StageReleaseError("not-reopenable", { stageName: "implement" });
		const rehydration = new StageRehydrationError({ stageName: "implement" });
		const missing = new StageRehydrationError({ runId: "run-1", sessionIds: ["s-1"] }, { code: "session-not-found" });
		const unsaved = new StageRehydrationError(
			{ runId: "run-1", sessionId: "s-1", toolCallIds: ["c1"], phase: "resume-turn" },
			{ code: "results-not-saved" },
		);
		const wake = new StageWakeError({ runId: "run-1", stageId: "stage-1", kind: "compaction-ready" });
		const all = [base, config, busy, reopen, rehydration, missing, unsaved, wake];

		assert.deepEqual(
			all.map((error) => [error.name, error.code, error.retryable]),
			[
				["StageWaitError", "session-unavailable", false],
				["StageWaitConfigError", "invalid-release-when-waiting", false],
				["StageReleaseError", "stage-busy", false],
				["StageReleaseError", "not-reopenable", false],
				["StageRehydrationError", "session-unavailable", true],
				["StageRehydrationError", "session-not-found", false],
				["StageRehydrationError", "results-not-saved", false],
				["StageWakeError", "unknown-wake-kind", false],
			],
		);
		for (const error of all) {
			assert.ok(error instanceof Error && error instanceof StageWaitError);
			assert.equal(typeof error.hint, "string");
			assert.ok(error.hint.length > 0);
			assert.ok(error.message.endsWith(error.hint), "the message carries the hint");
		}
		assert.ok(missing instanceof StageRehydrationError && wake instanceof StageWakeError);
		assert.deepEqual(base.fields, { runId: "run-1" });
		assert.equal(new StageWaitError("stage-busy", {}, { retryable: true }).retryable, true);
		assert.equal(new StageWaitError("stage-busy", {}, { retryable: false }).retryable, false);
		assert.equal(new StageWaitError("stage-busy", {}).retryable, false);
	});

	test("a wrapped failure is the cause of the error and is kept", () => {
		const cause = new Error("store closed");
		const error = new StageRehydrationError({ stageName: "implement" }, { cause });
		assert.equal(error.cause, cause);
		assert.equal(new StageWaitError("stage-busy", {}, { cause }).cause, cause);
	});

	test("each code renders what failed, the subject and the remedy once (the message is a UX contract)", () => {
		assert.equal(
			new StageWaitConfigError({
				source: "sdk",
				field: "releaseWhenWaiting.afterMs",
				value: "-5",
				stageName: "implement",
			}).message,
			'Invalid releaseWhenWaiting.afterMs for stage "implement": -5 (invalid-release-when-waiting). Set releaseWhenWaiting to true, false, or { afterMs } with a number of milliseconds from 0 to 2147483647 (MAX_RELEASE_WHEN_WAITING_AFTER_MS, about 24.8 days); use false to keep the stage resident.',
		);
		assert.equal(
			new StageReleaseError("stage-busy", { stageName: "implement" }).message,
			'Cannot release stage "implement" while its prompt is running (stage-busy). Wait for the stage\'s prompt to finish before releasing it.',
		);
		assert.equal(
			new StageReleaseError("not-reopenable", { stageName: "implement" }).message,
			'Cannot release stage "implement": its session cannot be reopened from a store (not-reopenable). Give the stage a persistent session store (the default store, sessionDir, or a caller-owned sessionStore) so it can be reopened.',
		);
		assert.equal(
			new StageRehydrationError({ stageName: "implement", sessionId: "session-1" }).message,
			'Cannot rehydrate stage "implement": session session-1 could not be reopened (session-unavailable). Check that the stage\'s session store is reachable, then resume the workflow.',
		);
		assert.equal(
			new StageRehydrationError(
				{ runId: "run-1", sessionIds: ["s-1", "s-2"], storage: "ATOMIC_SESSIONS_STORAGE" },
				{ code: "session-not-found" },
			).message,
			'Cannot rehydrate the waiting stages of run run-1: sessions s-1, s-2 are not in the session store (session-not-found). Resume the run with the session storage it was started with (ATOMIC_SESSIONS_STORAGE) selected through --storage, ATOMIC_SESSIONS_STORAGE or ATOMIC_STORAGE, the sessions.storage setting, or the SDK sessionStore option. Run "atomic storage status" to see which session storage this process selects. If this machine uses local-only storage and is not joined to shared storage, join it with `atomic team join <url> --token-file <path>`; joining keeps sessions in a local store, so also select the session storage that holds the waiting stage\'s session.',
		);
		assert.equal(
			new StageRehydrationError(
				{
					runId: "run-1",
					stageName: "implement",
					sessionId: "s-1",
					toolCallIds: ["c1", "c2"],
					phase: "resume-turn",
				},
				{ code: "results-not-saved" },
			).message,
			'Cannot rehydrate stage "implement": session s-1 returned from its detached turn without saving the results of c1, c2 (results-not-saved). Resume the run with /workflow resume run-1: the stage continues its turn from the results it recorded with its wait, which stay recorded until a turn that uses them is saved.',
		);
		assert.equal(
			new StageWakeError({ runId: "run-1", stageId: "stage-7", kind: "compaction-ready" }).message,
			'Cannot deliver a "compaction-ready" wake to stage "stage-7" of run run-1: no module registered that kind (unknown-wake-kind). Register the kind with registerStageWakeKind in the process that runs the stage before delivering messages of it.',
		);
	});

	test("a message names the stage by name, else by id, else as unknown", () => {
		assert.match(
			new StageReleaseError("stage-busy", { stageName: "by-name", stageId: "by-id" }).message,
			/^Cannot release stage "by-name" while/,
		);
		assert.match(
			new StageReleaseError("stage-busy", { stageId: "by-id" }).message,
			/^Cannot release stage "by-id" while/,
		);
		assert.match(new StageReleaseError("stage-busy", {}).message, /^Cannot release stage "unknown" while/);
		assert.match(
			new StageReleaseError("not-reopenable", {}).message,
			/^Cannot release stage "unknown": its session cannot/,
		);
	});

	test("a rehydration message names the session, or says it is unknown", () => {
		assert.match(
			new StageRehydrationError({ stageId: "stage-1" }).message,
			/^Cannot rehydrate stage "stage-1": session unknown could not be reopened/,
		);
		assert.match(
			new StageRehydrationError({ stageName: "implement", sessionId: "s-9" }).message,
			/^Cannot rehydrate stage "implement": session s-9 could not be reopened/,
		);
	});

	test("a config error names the run when no stage is given, and the field it rejected", () => {
		const run = new StageWaitConfigError({ source: "sdk", field: "releaseWhenWaiting", value: '"soon"' });
		assert.match(run.message, /^Invalid releaseWhenWaiting for the run: "soon" \(invalid-release-when-waiting\)\./);
		const stage = new StageWaitConfigError({
			source: "sdk",
			field: "releaseWhenWaiting",
			value: "7",
			stageName: "review",
		});
		assert.match(stage.message, /^Invalid releaseWhenWaiting for stage "review": 7 \(/);
		// A base error of this code, built without a field, still names the option.
		assert.match(
			new StageWaitError("invalid-release-when-waiting", { value: "9" }).message,
			/^Invalid releaseWhenWaiting for the run: 9 \(/,
		);
		assert.match(
			new StageWaitError("invalid-release-when-waiting", { stageId: "stage-4", value: "9" }).message,
			/^Invalid releaseWhenWaiting for the run: 9 \(/,
			"a stage id alone does not name the stage: only a stage name does",
		);
	});
});

describe("StageWaitError family: serialization (#4309)", () => {
	test("toJSON carries name, code, message, hint, retryable and fields, and no cause key without a cause", () => {
		const error = new StageReleaseError("stage-busy", { stageName: "implement", sessionId: "s-1" });
		const wire = error.toJSON();
		assert.deepEqual(wire, {
			name: "StageReleaseError",
			code: "stage-busy",
			message: error.message,
			hint: error.hint,
			retryable: false,
			fields: { stageName: "implement", sessionId: "s-1" },
		});
		assert.equal("cause" in wire, false);
	});

	test("a cause is described by name, message and code, without a code key when it has none", () => {
		const withCode = Object.assign(new Error("store closed"), { code: "StoreClosed" });
		const withoutCode = new TypeError("bad value");
		const nonStringCode = Object.assign(new Error("odd"), { code: 12 });

		const coded = new StageRehydrationError({}, { cause: withCode }).toJSON();
		assert.deepEqual(coded.cause, { name: "Error", message: "store closed", code: "StoreClosed" });
		const plain = new StageRehydrationError({}, { cause: withoutCode }).toJSON();
		assert.deepEqual(plain.cause, { name: "TypeError", message: "bad value" });
		assert.equal("code" in (plain.cause ?? {}), false);
		const odd = new StageRehydrationError({}, { cause: nonStringCode }).toJSON();
		assert.deepEqual(odd.cause, { name: "Error", message: "odd" });
	});

	test("a cause that is not an Error is described by its text", () => {
		assert.deepEqual(new StageWaitError("stage-busy", {}, { cause: "just text" }).toJSON().cause, {
			name: "Error",
			message: "just text",
		});
		assert.deepEqual(new StageWaitError("stage-busy", {}, { cause: { reason: 1 } }).toJSON().cause, {
			name: "Error",
			message: "[object Object]",
		});
		assert.deepEqual(new StageWaitError("stage-busy", {}, { cause: 42 }).toJSON().cause, {
			name: "Error",
			message: "42",
		});
	});

	test("a cause chain keeps each level's own cause and stops after the bounded depth", () => {
		const three = causeChain(3);
		const wire = new StageRehydrationError({}, { cause: three }).toJSON();
		assert.deepEqual(wire.cause, {
			name: "Error",
			message: "level 2",
			cause: { name: "Error", message: "level 1", cause: { name: "Error", message: "level 0" } },
		});
		assert.equal(serializedDepth(wire.cause), 3);

		const levels = CAUSE_DEPTH + 4;
		const long = new StageRehydrationError({}, { cause: causeChain(levels, undefined, RangeError) }).toJSON();
		// The first CAUSE_DEPTH causes are described in full; the next one ends the chain, described by its message alone.
		assert.equal(serializedDepth(long.cause), CAUSE_DEPTH + 1);
		let node = long.cause;
		for (let depth = 0; depth < CAUSE_DEPTH; depth++) {
			assert.equal(node?.name, "RangeError", `depth ${depth}`);
			node = node?.cause;
		}
		assert.deepEqual(node, { name: "Error", message: `level ${levels - 1 - CAUSE_DEPTH}` });
	});

	test("a non-Error cause at the end of a chain is described by its text", () => {
		const chain = new Error("outer", { cause: new Error("middle", { cause: "bottom text" }) });
		const wire = new StageRehydrationError({}, { cause: chain }).toJSON();
		assert.deepEqual(wire.cause, {
			name: "Error",
			message: "outer",
			cause: { name: "Error", message: "middle", cause: { name: "Error", message: "bottom text" } },
		});
	});

	test("every class survives a round trip as its own class with its fields, retryable flag and message", () => {
		const originals: StageWaitError[] = [
			new StageWaitConfigError({ source: "sdk", field: "releaseWhenWaiting", value: "1", stageName: "implement" }),
			new StageReleaseError("stage-busy", { stageName: "implement", sessionId: "s-1" }),
			new StageReleaseError("not-reopenable", { stageName: "implement" }),
			new StageRehydrationError({ stageName: "implement", sessionId: "s-1" }, { cause: new Error("down") }),
			new StageRehydrationError(
				{ runId: "run-1", sessionIds: ["s-1", "s-2"], storage: "SQLite ~/.atomic/workflows/journal.sqlite" },
				{ code: "session-not-found" },
			),
			new StageRehydrationError(
				{ runId: "run-1", stageName: "implement", sessionId: "s-1", toolCallIds: ["c1"], phase: "resume-turn" },
				{ code: "results-not-saved" },
			),
			new StageWakeError({ runId: "run-1", stageId: "stage-1", kind: "compaction-ready" }),
			new StageWaitError("session-unavailable", { runId: "run-1" }, { retryable: true }),
		];
		for (const original of originals) {
			const back = deserializeStageWaitError(JSON.parse(JSON.stringify(original)));
			assert.equal(back.constructor, original.constructor, original.name);
			assert.equal(back.name, original.name);
			assert.equal(back.code, original.code);
			assert.equal(back.retryable, original.retryable);
			assert.equal(back.hint, original.hint);
			assert.equal(back.message, original.message);
			assert.deepEqual(back.fields, original.fields);
		}
	});

	test("a rehydrated cause chain keeps every level's name, message, code and cause", () => {
		const bottom = Object.assign(new RangeError("disk full"), { code: "ENOSPC" });
		const original = new StageRehydrationError(
			{ stageName: "implement" },
			{ cause: new Error("store closed", { cause: bottom }) },
		);
		const back = deserializeStageWaitError(JSON.parse(JSON.stringify(original)));
		const middle = back.cause as Error & { code?: string };
		assert.equal(middle.message, "store closed");
		assert.equal("code" in middle, false, "a cause without a code gets no code");
		const leaf = middle.cause as Error & { code?: string };
		assert.equal(leaf.name, "RangeError");
		assert.equal(leaf.message, "disk full");
		assert.equal(leaf.code, "ENOSPC");
		assert.equal(leaf.cause, undefined);
		assert.ok(middle instanceof Error && leaf instanceof Error);
	});

	test("an unknown error name rehydrates as the family base with its name, code, flag, cause and message kept", () => {
		const original = new StageRehydrationError({ stageName: "implement" }, { cause: new Error("down") });
		const future = deserializeStageWaitError({ ...original.toJSON(), name: "FutureStageWaitError" });
		assert.equal(future.constructor, StageWaitError);
		assert.equal(future.name, "FutureStageWaitError");
		assert.equal(future.code, "session-unavailable");
		assert.equal(future.retryable, true);
		assert.equal((future.cause as Error).message, "down");
		assert.equal(future.message, original.message);

		const notRetryable = deserializeStageWaitError({
			...new StageReleaseError("stage-busy", { stageName: "implement" }).toJSON(),
			name: "FutureReleaseError",
		});
		assert.equal(notRetryable.retryable, false);
		assert.equal(notRetryable.cause, undefined);
	});

	test("the serialized message wins over the one a newer or older version would build", () => {
		const original = new StageReleaseError("stage-busy", { stageName: "implement" });
		for (const name of ["StageReleaseError", "SomeFutureError"]) {
			const back = deserializeStageWaitError({
				...original.toJSON(),
				name,
				message: "wording from another version",
			});
			assert.equal(back.message, "wording from another version", name);
			assert.equal(back.code, "stage-busy");
		}
		const same = deserializeStageWaitError(original.toJSON());
		assert.equal(same.message, original.message);
	});
});

describe("StageWaitError family: guards (#4309)", () => {
	const copies = {
		base: structuralCopy("StageWaitError", "session-unavailable"),
		config: structuralCopy("StageWaitConfigError", "invalid-release-when-waiting"),
		release: structuralCopy("StageReleaseError", "stage-busy"),
		rehydration: structuralCopy("StageRehydrationError", "session-not-found"),
		wake: structuralCopy("StageWakeError", "unknown-wake-kind"),
	};

	test("every guard accepts instances and structural copies of exactly its own classes", () => {
		const subjects: [string, object, object][] = [
			["base", new StageWaitError("stage-busy", {}), copies.base],
			[
				"config",
				new StageWaitConfigError({ source: "sdk", field: "releaseWhenWaiting", value: "1" }),
				copies.config,
			],
			["release", new StageReleaseError("not-reopenable", {}), copies.release],
			["rehydration", new StageRehydrationError({}), copies.rehydration],
			["wake", new StageWakeError({ runId: "r", stageId: "s", kind: "k" }), copies.wake],
		];
		const accepted: [string, (error: object) => boolean, readonly string[]][] = [
			["isStageWaitError", isStageWaitError, ["base", "config", "release", "rehydration", "wake"]],
			["isStageWaitConfigError", isStageWaitConfigError, ["config"]],
			["isStageReleaseError", isStageReleaseError, ["release"]],
			["isStageRehydrationError", isStageRehydrationError, ["rehydration"]],
			["isStageWakeError", isStageWakeError, ["wake"]],
		];
		for (const [guardName, guard, kinds] of accepted) {
			for (const [kind, instance, copy] of subjects) {
				assert.equal(guard(instance), kinds.includes(kind), `${guardName} on an instance of ${kind}`);
				assert.equal(guard(copy), kinds.includes(kind), `${guardName} on a structural copy of ${kind}`);
			}
		}
	});

	test("a structural copy needs a known name and a known code", () => {
		assert.equal(isStageWaitError(structuralCopy("StageReleaseError", "not-a-code")), false);
		assert.equal(isStageWaitError(structuralCopy("OtherError", "stage-busy")), false);
		assert.equal(isStageWaitError({ code: "stage-busy" }), false);
		assert.equal(isStageWaitError({ name: "StageReleaseError" }), false);
		assert.equal(isStageWaitError({ name: "StageReleaseError", code: 4 }), false);
		assert.equal(isStageWaitConfigError(structuralCopy("StageWaitConfigError", "stage-busy")), true);
		assert.equal(isStageWaitConfigError(structuralCopy("StageWaitConfigError", "nope")), false);
		assert.equal(isStageWaitConfigError(copies.release), false);
		assert.equal(isStageReleaseError(copies.config), false);
		assert.equal(isStageRehydrationError(copies.release), false);
		assert.equal(isStageRehydrationError(structuralCopy("StageRehydrationError", "nope")), false);
		assert.equal(isStageWakeError(structuralCopy("StageWakeError", "nope")), false);
		assert.equal(isStageWakeError(copies.rehydration), false);
	});

	test("values that are not objects are never errors of the family", () => {
		for (const value of [null, undefined, "StageReleaseError", 7, true, Symbol("x")]) {
			assert.equal(isStageWaitError(value), false);
			assert.equal(isStageWaitConfigError(value), false);
			assert.equal(isStageReleaseError(value), false);
			assert.equal(isStageRehydrationError(value), false);
			assert.equal(isStageWakeError(value), false);
		}
	});

	test("findStageWaitError returns the first family error of a cause chain", () => {
		const target = new StageRehydrationError({ stageName: "implement" });
		assert.equal(findStageWaitError(target), target);
		assert.equal(findStageWaitError(new Error("outer", { cause: target })), target);
		const copy = structuralCopy("StageReleaseError", "stage-busy");
		assert.equal(findStageWaitError(new Error("outer", { cause: new Error("middle", { cause: copy }) })), copy);
		const nearer = new StageReleaseError("stage-busy", {});
		assert.equal(findStageWaitError(new Error("outer", { cause: nearer })), nearer);
	});

	test("findStageWaitError looks at most CAUSE_DEPTH levels down, the error itself being the first", () => {
		const target = new StageRehydrationError({});
		const atLastLevel = causeChain(CAUSE_DEPTH - 1, target);
		const pastLastLevel = causeChain(CAUSE_DEPTH, target);
		assert.equal(findStageWaitError(atLastLevel), target);
		assert.equal(findStageWaitError(pastLastLevel), undefined);
	});

	test("findStageWaitError ends at a chain's natural end, whatever its last cause is", () => {
		assert.equal(findStageWaitError(new Error("plain")), undefined);
		assert.equal(findStageWaitError(new Error("outer", { cause: new Error("inner") })), undefined);
		assert.equal(findStageWaitError(new Error("outer", { cause: "text" })), undefined);
		assert.equal(findStageWaitError(new Error("outer", { cause: null })), undefined);
		assert.equal(findStageWaitError(new Error("outer", { cause: 5 })), undefined);
		assert.equal(findStageWaitError(null), undefined);
		assert.equal(findStageWaitError(undefined), undefined);
		assert.equal(findStageWaitError("StageReleaseError"), undefined);
	});
});

describe("releaseWhenWaiting validation (#4309)", () => {
	function refusal(value: ReleaseWhenWaiting | undefined, stageName?: string): StageWaitConfigError {
		try {
			parseReleaseWhenWaiting(value, stageName);
		} catch (error) {
			assert.ok(error instanceof StageWaitConfigError, "a refused value throws a StageWaitConfigError");
			return error;
		}
		assert.fail(`${String(value)} was accepted`);
	}

	test("the default threshold is 60 seconds", () => {
		assert.equal(DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS, 60_000);
	});

	test("unset is unset, false opts out, true takes the default threshold and an object brings its own", () => {
		assert.equal(parseReleaseWhenWaiting(undefined), undefined);
		assert.equal(parseReleaseWhenWaiting(false), null);
		assert.deepEqual(parseReleaseWhenWaiting(true), { afterMs: DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS });
		assert.deepEqual(parseReleaseWhenWaiting({ afterMs: 0 }), { afterMs: 0 });
		assert.deepEqual(parseReleaseWhenWaiting({ afterMs: 2_500 }), { afterMs: 2_500 });
		assert.deepEqual(parseReleaseWhenWaiting({ afterMs: 0.5 }), { afterMs: 0.5 });
	});

	test("a value that is not a boolean or an object is refused, naming the option and the value", () => {
		const text = refusal("soon" as never);
		assert.deepEqual(text.fields, { source: "sdk", field: "releaseWhenWaiting", value: '"soon"' });
		assert.equal(text.code, "invalid-release-when-waiting");
		assert.deepEqual(refusal(60 as never).fields, { source: "sdk", field: "releaseWhenWaiting", value: "60" });
		assert.deepEqual(refusal(null as never).fields, { source: "sdk", field: "releaseWhenWaiting", value: "null" });
		assert.deepEqual(refusal(Symbol("later") as never).fields, {
			source: "sdk",
			field: "releaseWhenWaiting",
			value: "Symbol(later)",
		});
	});

	test("an afterMs that is not a finite number of at least 0 is refused with its value as text", () => {
		const cases: [unknown, string][] = [
			[-1, "-1"],
			[Number.NaN, "NaN"],
			[Number.POSITIVE_INFINITY, "Infinity"],
			[Number.NEGATIVE_INFINITY, "-Infinity"],
			["10", '"10"'],
			[undefined, "undefined"],
			[null, "null"],
			[true, "true"],
		];
		for (const [afterMs, rendered] of cases) {
			const error = refusal({ afterMs } as never);
			assert.deepEqual(
				error.fields,
				{ source: "sdk", field: "releaseWhenWaiting.afterMs", value: rendered },
				String(afterMs),
			);
		}
		assert.deepEqual(refusal({} as never).fields.value, "undefined");
	});

	test("a refusal names the stage when one is given, and only then", () => {
		assert.deepEqual(refusal({ afterMs: -2 }, "implement").fields, {
			source: "sdk",
			field: "releaseWhenWaiting.afterMs",
			value: "-2",
			stageName: "implement",
		});
		assert.deepEqual(refusal("soon" as never, "review").fields, {
			source: "sdk",
			field: "releaseWhenWaiting",
			value: '"soon"',
			stageName: "review",
		});
		assert.equal("stageName" in refusal({ afterMs: -2 }).fields, false);
	});

	test("a stage's own setting wins over the run's, and with neither stages take the default threshold", () => {
		const run = { afterMs: 5 };
		assert.deepEqual(resolveStageReleasePolicy(undefined, undefined, "s"), {
			afterMs: DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS,
		});
		assert.deepEqual(resolveStageReleasePolicy(undefined, run, "s"), { afterMs: 5 });
		assert.deepEqual(resolveStageReleasePolicy({ afterMs: 7 }, run, "s"), { afterMs: 7 });
		assert.deepEqual(resolveStageReleasePolicy({ afterMs: 0 }, run, "s"), { afterMs: 0 });
		assert.deepEqual(resolveStageReleasePolicy(true, run, "s"), { afterMs: DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS });
		assert.deepEqual(resolveStageReleasePolicy(true, null, "s"), { afterMs: DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS });
		assert.equal(resolveStageReleasePolicy(false, run, "s"), undefined);
		assert.equal(resolveStageReleasePolicy(undefined, null, "s"), undefined);
		assert.deepEqual(resolveStageReleasePolicy({ afterMs: 3 }, null, "s"), { afterMs: 3 });
	});

	test("a stage's invalid setting is refused with the stage's name", () => {
		assert.throws(
			() => resolveStageReleasePolicy({ afterMs: -1 }, { afterMs: 5 }, "implement"),
			(error: Error) => {
				assert.ok(error instanceof StageWaitConfigError);
				assert.equal(error.fields.stageName, "implement");
				return true;
			},
		);
	});

	test("afterMs is accepted up to the longest delay a timer honours and refused one millisecond above it", () => {
		assert.equal(MAX_RELEASE_WHEN_WAITING_AFTER_MS, 2_147_483_647);
		assert.deepEqual(parseReleaseWhenWaiting({ afterMs: 2_147_483_647 }), { afterMs: 2_147_483_647 });
		assert.deepEqual(resolveStageReleasePolicy({ afterMs: 2_147_483_647 }, undefined, "s"), {
			afterMs: 2_147_483_647,
		});

		const above = refusal({ afterMs: 2_147_483_648 }, "implement");
		assert.equal(above.code, "invalid-release-when-waiting");
		assert.deepEqual(above.fields, {
			source: "sdk",
			field: "releaseWhenWaiting.afterMs",
			value: "2147483648",
			stageName: "implement",
		});
		assert.deepEqual(refusal({ afterMs: Number.MAX_SAFE_INTEGER }).fields.value, "9007199254740991");
	});
});

describe("session-not-found rehydration errors (#4309)", () => {
	test("a missing session is not retryable and lists every missing session with the run's storage", () => {
		const error = new StageRehydrationError(
			{ runId: "run-1", sessionIds: ["s-1", "s-2"], storage: "sessions.storage" },
			{ code: "session-not-found" },
		);
		assert.ok(isStageRehydrationError(error));
		assert.equal(error.code, "session-not-found");
		assert.equal(error.retryable, false);
		assert.deepEqual(error.fields, { runId: "run-1", sessionIds: ["s-1", "s-2"], storage: "sessions.storage" });
		assert.match(error.hint, /\(sessions\.storage\)/);
		assert.match(error.hint, /atomic storage status/);
		assert.ok(error.hint.includes(`\`${SHARED_STORAGE_JOIN_HINT}\``), error.hint);
		assert.match(error.hint, /local-only storage and is not joined to shared storage/);
		assert.match(error.hint, /also select the session storage that holds the waiting stage's session/);
		// The default code is still the retryable store failure.
		assert.equal(new StageRehydrationError({}).code, "session-unavailable");
		assert.equal(new StageRehydrationError({}, { code: "session-unavailable" }).retryable, true);
	});

	test("a missing session names one stage when given one, and the hint stands without a storage name", () => {
		const one = new StageRehydrationError(
			{ stageName: "implement", sessionId: "s-9" },
			{ code: "session-not-found" },
		);
		assert.match(one.message, /^Cannot rehydrate stage "implement": session s-9 is not in the session store \(/);
		assert.match(one.hint, /^Resume the run with the session storage it was started with selected through /);
		const unnamed = new StageRehydrationError({ runId: "run-2" }, { code: "session-not-found" });
		assert.match(
			unnamed.message,
			/^Cannot rehydrate the waiting stages of run run-2: its sessions are not in the session store \(/,
		);
	});

	test("a missing-session error crosses a process boundary as itself, with its code, flag and fields", () => {
		const original = new StageRehydrationError(
			{ runId: "run-1", stageId: "stage-1", sessionIds: ["s-1"], storage: "ATOMIC_STORAGE" },
			{ code: "session-not-found", cause: new Error("not found") },
		);
		const wire = JSON.parse(JSON.stringify(new Error("child failed", { cause: original }).cause));
		const back = deserializeStageWaitError(wire);

		assert.ok(back instanceof StageRehydrationError);
		assert.equal(back.code, "session-not-found");
		assert.equal(back.retryable, false);
		assert.deepEqual(back.fields, original.fields);
		assert.equal(back.hint, original.hint);
		assert.equal((back.cause as Error).message, "not found");
		assert.equal(findStageWaitError(new Error("parent failed", { cause: back })), back);
	});
});

describe("StageWakeError (#4309)", () => {
	test("an unknown wake kind error carries the run, the stage and the kind, and is not retryable", () => {
		const error = new StageWakeError({ runId: "run-1", stageId: "stage-1", kind: "compaction-ready" });
		assert.ok(isStageWakeError(error) && isStageWaitError(error));
		assert.equal(error.name, "StageWakeError");
		assert.equal(error.code, "unknown-wake-kind");
		assert.equal(error.retryable, false);
		assert.deepEqual(error.fields, { runId: "run-1", stageId: "stage-1", kind: "compaction-ready" });
		assert.match(error.hint, /registerStageWakeKind/);
	});

	test("an unknown wake kind error crosses a process boundary as itself", () => {
		const original = new StageWakeError({ runId: "run-1", stageId: "stage-1", kind: "compaction-ready" });
		const back = deserializeStageWaitError(JSON.parse(JSON.stringify(original)));

		assert.ok(back instanceof StageWakeError);
		assert.ok(isStageWakeError(back));
		assert.equal(back.code, "unknown-wake-kind");
		assert.deepEqual(back.fields, original.fields);
		assert.equal(back.message, original.message);
	});
});

describe("errors of a stage that ran out of attempts (#4309)", () => {
	test("a reopening that ran out of attempts says how many, and a wait record that could not be written says which (#4309)", () => {
		const reopening = new StageRehydrationError({
			stageName: "implement",
			sessionId: "session-1",
			phase: "reopen",
			attempts: 3,
			elapsedMs: 2_600,
			timeoutMs: 3_000,
		});
		const record = new StageWaitRecordError(
			{ stageName: "implement", phase: "wait-results", attempts: 3, elapsedMs: 2_400, timeoutMs: 3_000 },
			{ cause: new Error("journal unreachable") },
		);

		assert.equal(
			reopening.message,
			'Cannot rehydrate stage "implement": session session-1 could not be reopened after 3 attempts (session-unavailable). Check that the stage\'s session store is reachable, then resume the workflow.',
		);
		assert.ok(isStageWaitRecordError(record) && isStageWaitError(record));
		assert.equal(record.name, "StageWaitRecordError");
		assert.equal(record.code, "wait-record-unavailable");
		assert.equal(record.retryable, false);
		assert.equal(
			record.message,
			'Cannot durably record the results stage "implement" was woken with after 3 attempts (wait-record-unavailable). The stage carries on. Until its next record is written, a resume after a restart starts the stage from its previous record, which may run a finished tool call again; check that the run\'s journal storage is reachable.',
		);
		const back = deserializeStageWaitError(JSON.parse(JSON.stringify(record)));
		assert.ok(back instanceof StageWaitRecordError);
		assert.deepEqual(back.fields, record.fields);
		assert.equal((back.cause as Error).message, "journal unreachable");
	});
});

describe("isRetryableWorkflowError and stage waits (#4309)", () => {
	test("a store failure while rehydrating is retryable, directly, wrapped, rehydrated or copied structurally", () => {
		const unavailable = new StageRehydrationError({ stageName: "implement" }, { cause: new Error("store down") });
		assert.equal(isRetryableWorkflowError(unavailable), true);
		assert.equal(isRetryableWorkflowError(new Error("stage failed", { cause: unavailable })), true);
		assert.equal(isRetryableWorkflowError(deserializeStageWaitError(JSON.parse(JSON.stringify(unavailable)))), true);
		assert.equal(
			isRetryableWorkflowError({
				message: "from a worker",
				cause: { name: "StageRehydrationError", code: "session-unavailable", retryable: true },
			}),
			true,
		);
		assert.equal(isRetryableWorkflowError(new StageWaitError("stage-busy", {}, { retryable: true })), true);
	});

	test("stage-wait failures that a retry cannot fix are not retryable", () => {
		const notRetryable: StageWaitError[] = [
			new StageRehydrationError({ sessionIds: ["s-1"] }, { code: "session-not-found" }),
			new StageWakeError({ runId: "run-1", stageId: "stage-1", kind: "x" }),
			new StageReleaseError("stage-busy", {}),
			new StageWaitConfigError({ source: "sdk", field: "releaseWhenWaiting", value: "1" }),
		];
		for (const error of notRetryable) {
			assert.equal(isRetryableWorkflowError(error), false, error.code);
			assert.equal(isRetryableWorkflowError(new Error("wrapped", { cause: error })), false, error.code);
		}
		// A structural copy must say it is retryable; the code alone does not make it so.
		assert.equal(isRetryableWorkflowError({ name: "StageRehydrationError", code: "session-unavailable" }), false);
	});

	test("the cause walk stops after the bounded depth, the error itself being the first level", () => {
		const retryable = new StageRehydrationError({});
		assert.equal(isRetryableWorkflowError(causeChain(CAUSE_DEPTH - 1, retryable)), true);
		assert.equal(isRetryableWorkflowError(causeChain(CAUSE_DEPTH, retryable)), false);
		const infrastructure = new WorkflowInfrastructureError("worker_lost");
		assert.equal(isRetryableWorkflowError(causeChain(CAUSE_DEPTH - 1, infrastructure)), true);
	});
});
