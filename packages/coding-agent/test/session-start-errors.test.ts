import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	findSessionStartError,
	isRetryableSessionStartError,
	isSessionStartConfigError,
	isSessionStartError,
	isSessionStartTimeoutError,
	MAX_SESSION_START_TIMEOUT_MS,
	parseSessionStartTimeoutMs,
	rehydrateSessionStartError,
	type SerializedSessionStartError,
	SessionStartConfigError,
	SessionStartError,
	type SessionStartTimeoutDetails,
	SessionStartTimeoutError,
	serializeSessionStartError,
} from "../src/index.js";

const SETUP_TIMEOUT: SessionStartTimeoutDetails = {
	subject: "subagent worker_1 (id run-1:0)",
	phase: "setup",
	step: "creating-session",
	timeoutMs: 300_000,
	elapsedMs: 300_012,
	stepElapsedMs: 290_400,
	steps: [
		{ step: "opening-session", elapsedMs: 4_100 },
		{ step: "loading-resources", elapsedMs: 5_512 },
		{ step: "creating-session", elapsedMs: 290_400 },
	],
	eventLoop: { turns: 1_190, meanTurnMs: 252, maxTurnMs: 260 },
};

function timeout(overrides: Partial<SessionStartTimeoutDetails> = {}): SessionStartTimeoutError {
	return new SessionStartTimeoutError({ ...SETUP_TIMEOUT, ...overrides });
}

function roundTrip(error: SessionStartError): SessionStartError {
	return rehydrateSessionStartError(JSON.parse(JSON.stringify(serializeSessionStartError(error))));
}

describe("SessionStartTimeoutError (#4319)", () => {
	test("carries its code, phase, step, budget and timings, and is retryable", () => {
		const error = timeout();
		assert.ok(error instanceof SessionStartError);
		assert.ok(error instanceof Error);
		assert.equal(error.name, "SessionStartTimeoutError");
		assert.equal(error.code, "session-start-timeout");
		assert.equal(error.retryable, true);
		assert.equal(error.phase, "setup");
		assert.equal(error.step, "creating-session");
		assert.equal(error.subject, SETUP_TIMEOUT.subject);
		assert.equal(error.timeoutMs, 300_000);
		assert.equal(error.elapsedMs, 300_012);
		assert.equal(error.stepElapsedMs, 290_400);
		assert.deepEqual(error.steps, SETUP_TIMEOUT.steps);
		assert.deepEqual(error.eventLoop, SETUP_TIMEOUT.eventLoop);
		assert.deepEqual(error.fields, {
			...SETUP_TIMEOUT,
			steps: SETUP_TIMEOUT.steps.map((timing) => ({ ...timing })),
			eventLoop: { ...SETUP_TIMEOUT.eventLoop },
		});
		assert.equal(typeof error.hint, "string");
		assert.ok(error.message.endsWith(error.hint!));
		assert.ok(isSessionStartError(error));
		assert.ok(isSessionStartTimeoutError(error));
		assert.equal(isSessionStartConfigError(error), false);
		assert.equal(isRetryableSessionStartError(error), true);
	});

	test("carries no cause unless it was given one", () => {
		assert.equal(Object.hasOwn(timeout(), "cause"), false);
		const cause = new Error("journal busy");
		assert.equal(new SessionStartTimeoutError(SETUP_TIMEOUT, { cause }).cause, cause);
	});

	test("keeps copies of the timings it was given", () => {
		const steps = [{ step: "opening-session" as const, elapsedMs: 1 }];
		const eventLoop = { turns: 1, meanTurnMs: 2, maxTurnMs: 3 };
		const error = timeout({ steps, eventLoop });
		steps[0]!.elapsedMs = 99;
		eventLoop.turns = 99;
		assert.deepEqual(error.steps, [{ step: "opening-session", elapsedMs: 1 }]);
		assert.deepEqual(error.eventLoop, { turns: 1, meanTurnMs: 2, maxTurnMs: 3 });
		assert.deepEqual(error.fields.steps, [{ step: "opening-session", elapsedMs: 1 }]);
		assert.deepEqual(error.fields.eventLoop, { turns: 1, meanTurnMs: 2, maxTurnMs: 3 });
	});

	test("renders what blocked the start and what to do next (UX contract)", () => {
		assert.equal(
			timeout().message,
			"Session start timed out: subagent worker_1 (id run-1:0) did not start within 5 min, still creating its agent session (session-start-timeout, phase setup). Its session was still being set up: check its session store and extension startup, or raise sessionStartTimeoutMs, then retry.",
		);
	});

	test("names each phase and step in its message and hint", () => {
		const cases = [
			[
				"admission",
				"awaiting-admission",
				"waiting for a resource-admission permit",
				"resource admission granted no",
			],
			["dispatch", "dispatching-task", "dispatching its task", "was not dispatched in time"],
			["event-loop", "loading-resources", "loading its resources", "event loop turned only 12 times, about 251 ms"],
			["setup", "opening-session", "opening its session", "still being set up"],
		] as const;
		for (const [phase, step, stepText, hintText] of cases) {
			const error = timeout({ phase, step, eventLoop: { turns: 12, meanTurnMs: 250.6, maxTurnMs: 270 } });
			assert.ok(error.message.includes(`still ${stepText} (session-start-timeout, phase ${phase}).`), error.message);
			assert.ok(error.hint?.includes(hintText), error.hint);
		}
	});

	test("states its budget in minutes, seconds or milliseconds", () => {
		assert.ok(timeout({ timeoutMs: 120_000 }).message.includes("within 2 min,"));
		assert.ok(timeout({ timeoutMs: 10_000 }).message.includes("within 10s,"));
		assert.ok(timeout({ timeoutMs: 1_499 }).message.includes("within 1s,"));
		assert.ok(timeout({ timeoutMs: 1_000 }).message.includes("within 1s,"));
		assert.ok(timeout({ timeoutMs: 999 }).message.includes("within 999 ms,"));
	});

	test("survives a process boundary as the same class with its fields (round trip)", () => {
		const original = new SessionStartTimeoutError(SETUP_TIMEOUT, { cause: new Error("journal busy") });
		const rehydrated = roundTrip(original);
		assert.ok(rehydrated instanceof SessionStartTimeoutError);
		assert.ok(isSessionStartTimeoutError(rehydrated));
		assert.equal(rehydrated.message, original.message);
		assert.equal(rehydrated.hint, original.hint);
		assert.equal(rehydrated.phase, "setup");
		assert.equal(rehydrated.step, "creating-session");
		assert.equal(rehydrated.elapsedMs, 300_012);
		assert.deepEqual(rehydrated.steps, SETUP_TIMEOUT.steps);
		assert.deepEqual(rehydrated.eventLoop, SETUP_TIMEOUT.eventLoop);
		assert.ok(rehydrated.cause instanceof Error);
		assert.equal(rehydrated.cause.message, "journal busy");
		assert.equal(rehydrated.cause.name, "Error");
	});

	test("serializes as name, code, message, hint, retryable and JSON-safe fields", () => {
		const serialized = serializeSessionStartError(timeout());
		assert.deepEqual(Object.keys(serialized).sort(), ["code", "fields", "hint", "message", "name", "retryable"]);
		assert.equal(serialized.name, "SessionStartTimeoutError");
		assert.equal(serialized.code, "session-start-timeout");
		assert.equal(serialized.retryable, true);
		assert.deepEqual(JSON.parse(JSON.stringify(serialized.fields)), serialized.fields);
	});
});

describe("SessionStartConfigError (#4319)", () => {
	test("names the source, field, reason and value, and is not retryable", () => {
		const error = new SessionStartConfigError("settings", "sessionStartTimeoutMs", "not-a-positive-integer", '"5m"');
		assert.ok(error instanceof SessionStartError);
		assert.equal(error.name, "SessionStartConfigError");
		assert.equal(error.code, "invalid-session-start-timeout");
		assert.equal(error.retryable, false);
		assert.equal(error.source, "settings");
		assert.equal(error.field, "sessionStartTimeoutMs");
		assert.equal(error.reason, "not-a-positive-integer");
		assert.equal(error.value, '"5m"');
		assert.deepEqual(error.fields, {
			source: "settings",
			field: "sessionStartTimeoutMs",
			reason: "not-a-positive-integer",
			value: '"5m"',
		});
		assert.ok(isSessionStartError(error));
		assert.ok(isSessionStartConfigError(error));
		assert.equal(isSessionStartTimeoutError(error), false);
		assert.equal(isRetryableSessionStartError(error), false);
	});

	test("renders the setting to fix and an example value (UX contract)", () => {
		const error = new SessionStartConfigError("sdk", "sessionStartTimeoutMs", "exceeds-maximum", "3000000000");
		assert.equal(
			error.message,
			"Invalid session start configuration: sessionStartTimeoutMs from sdk is 3000000000 (invalid-session-start-timeout, exceeds-maximum). Set sessionStartTimeoutMs to a whole number of milliseconds from 1 to 2147483647, such as 300000 for 5 minutes.",
		);
		assert.equal(
			error.hint,
			"Set sessionStartTimeoutMs to a whole number of milliseconds from 1 to 2147483647, such as 300000 for 5 minutes.",
		);
	});

	test("survives a process boundary as the same class with its fields (round trip)", () => {
		const original = new SessionStartConfigError("env", "SESSION_START", "not-a-positive-integer", "-1");
		const rehydrated = roundTrip(original);
		assert.ok(rehydrated instanceof SessionStartConfigError);
		assert.ok(isSessionStartConfigError(rehydrated));
		assert.equal(rehydrated.message, original.message);
		assert.equal(rehydrated.source, "env");
		assert.equal(rehydrated.field, "SESSION_START");
		assert.equal(rehydrated.reason, "not-a-positive-integer");
		assert.equal(rehydrated.value, "-1");
	});
});

describe("SessionStartError (#4319)", () => {
	test("is the family base: not retryable, no hint and no fields unless given", () => {
		const error = new SessionStartError("session-start-timeout", "plain");
		assert.ok(error instanceof Error);
		assert.equal(error.name, "SessionStartError");
		assert.equal(error.code, "session-start-timeout");
		assert.equal(error.message, "plain");
		assert.equal(error.retryable, false);
		assert.equal(error.hint, undefined);
		assert.deepEqual(error.fields, {});
		assert.equal(Object.hasOwn(error, "cause"), false);
		assert.ok(isSessionStartError(error));
		assert.equal(isRetryableSessionStartError(error), false);
	});

	test("keeps the name, hint, fields, retryability and cause it is given", () => {
		const cause = new Error("root");
		const error = new SessionStartError("session-start-quota", "quota", {
			name: "SessionStartQuotaError",
			hint: "wait",
			retryable: true,
			fields: { quota: 3 },
			cause,
		});
		assert.equal(error.name, "SessionStartQuotaError");
		assert.equal(error.hint, "wait");
		assert.equal(error.retryable, true);
		assert.deepEqual(error.fields, { quota: 3 });
		assert.equal(error.cause, cause);
		assert.ok(isSessionStartError(error), "an instance is one whatever its name");
		assert.equal(isRetryableSessionStartError(error), true);
	});
});

describe("parseSessionStartTimeoutMs (#4319)", () => {
	test("leaves an unset budget unset and returns a valid one", () => {
		assert.equal(parseSessionStartTimeoutMs(undefined, "settings", "sessionStartTimeoutMs"), undefined);
		assert.equal(parseSessionStartTimeoutMs(1, "settings", "sessionStartTimeoutMs"), 1);
		assert.equal(parseSessionStartTimeoutMs(300_000, "sdk", "sessionStartTimeoutMs"), 300_000);
		assert.equal(
			parseSessionStartTimeoutMs(MAX_SESSION_START_TIMEOUT_MS, "sdk", "sessionStartTimeoutMs"),
			MAX_SESSION_START_TIMEOUT_MS,
		);
	});

	test("rejects anything but a positive whole number of milliseconds, naming its source and field", () => {
		const invalid: readonly [unknown, string][] = [
			[0, "0"],
			[-5, "-5"],
			[1.5, "1.5"],
			[Number.NaN, "null"],
			[Number.POSITIVE_INFINITY, "null"],
			["300000", '"300000"'],
			[null, "null"],
			[true, "true"],
			[{ minutes: 5 }, '{"minutes":5}'],
			[Symbol.for("budget"), "Symbol(budget)"],
		];
		for (const [value, rendered] of invalid) {
			assert.throws(
				() => parseSessionStartTimeoutMs(value, "settings", "sessionStartTimeoutMs"),
				(error: unknown) => {
					assert.ok(isSessionStartConfigError(error), String(error));
					assert.equal(error.source, "settings");
					assert.equal(error.field, "sessionStartTimeoutMs");
					assert.equal(error.reason, "not-a-positive-integer");
					assert.equal(error.value, rendered);
					return true;
				},
			);
		}
	});

	test("rejects a budget a timer cannot hold", () => {
		assert.throws(
			() => parseSessionStartTimeoutMs(MAX_SESSION_START_TIMEOUT_MS + 1, "sdk", "sessionStartTimeoutMs"),
			(error: unknown) => isSessionStartConfigError(error) && error.reason === "exceeds-maximum",
		);
	});

	test("shortens a long rejected value to 64 characters", () => {
		const long = "x".repeat(200);
		assert.throws(
			() => parseSessionStartTimeoutMs(long, "settings", "sessionStartTimeoutMs"),
			(error: unknown) =>
				isSessionStartConfigError(error) && error.value.length === 64 && error.value === `"${"x".repeat(62)}…`,
		);
		const exact = "y".repeat(62);
		assert.throws(
			() => parseSessionStartTimeoutMs(exact, "settings", "sessionStartTimeoutMs"),
			(error: unknown) => isSessionStartConfigError(error) && error.value === JSON.stringify(exact),
		);
	});
});

describe("session start error guards and chains (#4319)", () => {
	test("recognise an error from another realm or process by name and code, not by message", () => {
		const foreign = { ...serializeSessionStartError(timeout()), ...SETUP_TIMEOUT };
		assert.ok(isSessionStartError(foreign));
		assert.ok(isSessionStartTimeoutError(foreign));
		assert.ok(!isSessionStartConfigError(foreign));
		const foreignConfig = {
			name: "SessionStartConfigError",
			code: "invalid-session-start-timeout",
			message: "m",
			field: "sessionStartTimeoutMs",
		};
		assert.ok(isSessionStartConfigError(foreignConfig));
		assert.ok(!isSessionStartTimeoutError(foreignConfig));
		assert.ok(isSessionStartError({ name: "SessionStartError", code: "session-start-timeout", message: "m" }));
	});

	test("reject look-alikes", () => {
		const lookAlikes: unknown[] = [
			undefined,
			null,
			"SessionStartTimeoutError",
			new Error("Session start timed out"),
			{ name: "SessionStartTimeoutError", code: "other", message: "m", phase: "setup" },
			{ name: "OtherError", code: "session-start-timeout", message: "m", phase: "setup" },
			{ name: "SessionStartTimeoutError", code: "session-start-timeout", phase: "setup" },
			{ name: 1, code: "session-start-timeout", message: "m" },
			{ name: "SessionStartError", code: 1, message: "m" },
		];
		for (const value of lookAlikes) assert.equal(isSessionStartError(value), false, JSON.stringify(value));
		const noPhase = { name: "SessionStartTimeoutError", code: "session-start-timeout", message: "m" };
		assert.equal(isSessionStartTimeoutError(noPhase), false);
		assert.equal(isSessionStartTimeoutError({ ...noPhase, phase: "later" }), false);
		assert.equal(isSessionStartTimeoutError({ ...noPhase, phase: 3 }), false);
		assert.equal(isSessionStartTimeoutError({ ...noPhase, name: "SessionStartError", phase: "setup" }), false);
		assert.equal(
			isSessionStartTimeoutError({ ...noPhase, code: "invalid-session-start-timeout", phase: "setup" }),
			false,
		);
		for (const phase of ["admission", "setup", "dispatch", "event-loop"])
			assert.equal(isSessionStartTimeoutError({ ...noPhase, phase }), true, phase);
		const config = { name: "SessionStartConfigError", code: "invalid-session-start-timeout", message: "m" };
		assert.equal(isSessionStartConfigError(config), false);
		assert.equal(isSessionStartConfigError({ ...config, field: 1 }), false);
		assert.equal(isSessionStartConfigError({ ...config, code: "session-start-timeout", field: "f" }), false);
		assert.equal(isSessionStartConfigError({ ...config, name: "SessionStartError", field: "f" }), false);
	});

	test("find a session start error up to eight causes deep, and no deeper", () => {
		const wrap = (cause: object, depth: number): object => {
			let current = cause;
			for (let level = 0; level < depth; level++) current = new Error(`wrapper ${level}`, { cause: current });
			return current;
		};
		const error = timeout();
		assert.equal(findSessionStartError(error), error);
		assert.equal(findSessionStartError(wrap(error, 7)), error);
		assert.equal(isRetryableSessionStartError(wrap(error, 7)), true);
		assert.equal(findSessionStartError(wrap(error, 8)), undefined);
		assert.equal(isRetryableSessionStartError(wrap(error, 8)), false);
		assert.equal(findSessionStartError(new Error("plain")), undefined);
		assert.equal(findSessionStartError(undefined), undefined);
		assert.equal(findSessionStartError("text"), undefined);
		const config = new SessionStartConfigError("sdk", "sessionStartTimeoutMs", "exceeds-maximum", "1e12");
		assert.equal(findSessionStartError(wrap(config, 2)), config);
		assert.equal(isRetryableSessionStartError(wrap(config, 2)), false);
	});
});

describe("rehydrateSessionStartError (#4319)", () => {
	test("keeps an unknown name and code on the family base", () => {
		const serialized: SerializedSessionStartError = {
			name: "SessionStartQuotaError",
			code: "session-start-quota",
			message: "quota",
			hint: "wait",
			retryable: true,
			fields: { quota: 3 },
		};
		const rehydrated = rehydrateSessionStartError(serialized);
		assert.ok(rehydrated instanceof SessionStartError);
		assert.ok(!(rehydrated instanceof SessionStartTimeoutError));
		assert.equal(rehydrated.name, "SessionStartQuotaError");
		assert.equal(rehydrated.code, "session-start-quota");
		assert.equal(rehydrated.message, "quota");
		assert.equal(rehydrated.hint, "wait");
		assert.equal(rehydrated.retryable, true);
		assert.deepEqual(rehydrated.fields, { quota: 3 });
		assert.deepEqual(serializeSessionStartError(rehydrated), serialized);
	});

	test("falls back to the family base when a known name's fields no longer fit", () => {
		const valid = serializeSessionStartError(timeout());
		const broken: Record<string, object | string | number> = {
			subject: { ...valid.fields, subject: 1 },
			phase: { ...valid.fields, phase: "later" },
			step: { ...valid.fields, step: "elsewhere" },
			timeoutMs: { ...valid.fields, timeoutMs: "5" },
			steps: { ...valid.fields, steps: "none" },
			stepEntry: { ...valid.fields, steps: [1] },
			stepName: { ...valid.fields, steps: [{ step: "elsewhere", elapsedMs: 1 }] },
			stepElapsed: { ...valid.fields, steps: [{ step: "opening-session" }] },
			stepArray: { ...valid.fields, steps: [[]] },
			eventLoop: { ...valid.fields, eventLoop: null },
			eventLoopArray: { ...valid.fields, eventLoop: [] },
			eventLoopTurns: { ...valid.fields, eventLoop: { meanTurnMs: 1, maxTurnMs: 1 } },
			eventLoopMean: { ...valid.fields, eventLoop: { turns: 1, maxTurnMs: 1 } },
			eventLoopMax: { ...valid.fields, eventLoop: { turns: 1, meanTurnMs: 1 } },
			eventLoopText: { ...valid.fields, eventLoop: "busy" },
			elapsedMs: { ...valid.fields, elapsedMs: null },
			stepElapsedMs: { ...valid.fields, stepElapsedMs: "1" },
			stepNull: { ...valid.fields, steps: [null] },
		};
		for (const [label, fields] of Object.entries(broken)) {
			const rehydrated = rehydrateSessionStartError({
				...valid,
				fields: fields as SerializedSessionStartError["fields"],
			});
			assert.ok(!(rehydrated instanceof SessionStartTimeoutError), label);
			assert.equal(rehydrated.name, "SessionStartTimeoutError", label);
			assert.equal(rehydrated.code, "session-start-timeout", label);
			assert.equal(rehydrated.message, valid.message, label);
		}
		const config = serializeSessionStartError(
			new SessionStartConfigError("cli", "--start-timeout", "not-a-positive-integer", "0"),
		);
		for (const fields of [
			{ ...config.fields, source: "file" },
			{ ...config.fields, field: 2 },
			{ ...config.fields, reason: "too-small" },
			{ ...config.fields, value: 0 },
		]) {
			const rehydrated = rehydrateSessionStartError({ ...config, fields });
			assert.ok(!(rehydrated instanceof SessionStartConfigError));
			assert.equal(rehydrated.name, "SessionStartConfigError");
		}
		const mismatched = rehydrateSessionStartError({ ...config, code: "session-start-timeout" });
		assert.ok(!(mismatched instanceof SessionStartConfigError));
		const misnamed = rehydrateSessionStartError({ ...valid, code: "invalid-session-start-timeout" });
		assert.ok(!(misnamed instanceof SessionStartTimeoutError));
	});

	test("rehydrates a chain of causes, session start errors as their class, bounded at eight levels", () => {
		const inner = new SessionStartConfigError("sdk", "sessionStartTimeoutMs", "exceeds-maximum", "1e12");
		const middle = Object.assign(new Error("store failed", { cause: inner }), { name: "StorageError", code: "busy" });
		const outer = new SessionStartTimeoutError(SETUP_TIMEOUT, { cause: middle });
		const rehydrated = roundTrip(outer);
		const cause = rehydrated.cause as Error & { code?: string };
		assert.equal(cause.name, "StorageError");
		assert.equal(cause.code, "busy");
		assert.equal(cause.message, "store failed");
		assert.ok(cause.cause instanceof SessionStartConfigError);
		assert.equal(cause.cause.reason, "exceeds-maximum");

		const wrappedConfig = new SessionStartConfigError("sdk", "f", "exceeds-maximum", "1");
		const viaConfigCause = roundTrip(
			new SessionStartTimeoutError(SETUP_TIMEOUT, {
				cause: Object.assign(new SessionStartError("session-start-timeout", "base", { hint: "h" }), {
					cause: wrappedConfig,
				}),
			}),
		);
		assert.ok(viaConfigCause.cause instanceof SessionStartError);
		assert.equal((viaConfigCause.cause as SessionStartError).hint, "h");
		assert.ok((viaConfigCause.cause as SessionStartError).cause instanceof SessionStartConfigError);

		let deep: Error = new Error("root");
		for (let level = 0; level < 12; level++) deep = new Error(`level ${level}`, { cause: deep });
		let depth = 0;
		for (
			let current: unknown = roundTrip(new SessionStartTimeoutError(SETUP_TIMEOUT, { cause: deep })).cause;
			current instanceof Error;
			current = current.cause
		)
			depth++;
		assert.equal(depth, 8);

		const textCause = roundTrip(new SessionStartTimeoutError(SETUP_TIMEOUT, { cause: "lost" }));
		assert.equal((textCause.cause as Error).message, "lost");
		const objectCause = roundTrip(new SessionStartTimeoutError(SETUP_TIMEOUT, { cause: { reason: 1 } }));
		assert.equal((objectCause.cause as Error).message, '{"reason":1}');
		const configWithCause = roundTrip(
			Object.assign(new SessionStartConfigError("sdk", "f", "exceeds-maximum", "1"), { cause: new Error("why") }),
		);
		assert.ok(configWithCause instanceof SessionStartConfigError);
		assert.equal((configWithCause.cause as Error).message, "why");
	});
});

describe("serializeSessionStartError (#4319)", () => {
	test("writes only the keys an error and each of its causes has", () => {
		const leaf = Object.assign(new Error("disk"), { name: "IoError", code: "EIO" });
		const plain = new Error("store failed", { cause: leaf });
		const family = new SessionStartError("session-start-quota", "quota", {
			name: "SessionStartQuotaError",
			cause: plain,
		});
		const error = new SessionStartTimeoutError(SETUP_TIMEOUT, { cause: family });
		const { fields: _fields, ...serialized } = serializeSessionStartError(error);
		assert.deepEqual(serialized, {
			name: "SessionStartTimeoutError",
			code: "session-start-timeout",
			message: error.message,
			hint: error.hint,
			retryable: true,
			cause: {
				name: "SessionStartQuotaError",
				code: "session-start-quota",
				message: "quota",
				fields: {},
				retryable: false,
				cause: {
					name: "Error",
					message: "store failed",
					cause: { name: "IoError", message: "disk", code: "EIO" },
				},
			},
		});
		const bare = serializeSessionStartError(new SessionStartError("session-start-timeout", "bare"));
		assert.deepEqual(bare, {
			name: "SessionStartError",
			code: "session-start-timeout",
			message: "bare",
			retryable: false,
			fields: {},
		});
	});

	test("keeps eight causes and drops the rest, and rehydrates all eight", () => {
		let deep: Error = new Error("root");
		for (let level = 0; level < 12; level++) deep = new Error(`level ${level}`, { cause: deep });
		const serialized = serializeSessionStartError(new SessionStartTimeoutError(SETUP_TIMEOUT, { cause: deep }));
		let serializedDepth = 0;
		for (let cause = serialized.cause; cause !== undefined; cause = cause.cause) serializedDepth++;
		assert.equal(serializedDepth, 8);
		let rehydratedDepth = 0;
		for (
			let cause: unknown = rehydrateSessionStartError(serialized).cause;
			cause instanceof Error;
			cause = cause.cause
		)
			rehydratedDepth++;
		assert.equal(rehydratedDepth, 8);
	});

	test("keeps eight causes of a chain of session start errors too", () => {
		let deep: SessionStartError = new SessionStartError("session-start-timeout", "root");
		for (let level = 0; level < 12; level++)
			deep = new SessionStartError("session-start-timeout", `level ${level}`, { cause: deep });
		const serialized = serializeSessionStartError(new SessionStartTimeoutError(SETUP_TIMEOUT, { cause: deep }));
		let depth = 0;
		for (let cause = serialized.cause; cause !== undefined; cause = cause.cause) depth++;
		assert.equal(depth, 8);
		const leaf = serializeSessionStartError(
			new SessionStartTimeoutError(SETUP_TIMEOUT, { cause: new SessionStartError("session-start-timeout", "x") }),
		).cause;
		assert.deepEqual(leaf, {
			name: "SessionStartError",
			code: "session-start-timeout",
			message: "x",
			fields: {},
			retryable: false,
		});
	});

	test("rehydrates no more than eight causes of a deeper chain it is given", () => {
		const chain = (depth: number): SerializedSessionStartError["cause"] =>
			depth === 0 ? undefined : { name: "Error", message: `level ${depth}`, cause: chain(depth - 1) };
		const serialized = { ...serializeSessionStartError(timeout()), cause: chain(12) };
		let depth = 0;
		for (
			let cause: unknown = rehydrateSessionStartError(serialized).cause;
			cause instanceof Error;
			cause = cause.cause
		)
			depth++;
		assert.equal(depth, 8);
	});

	test("rehydrates every phase, step and config source as its class", () => {
		for (const phase of ["admission", "setup", "dispatch", "event-loop"] as const) {
			for (const step of [
				"opening-session",
				"loading-resources",
				"creating-session",
				"awaiting-admission",
				"dispatching-task",
			] as const) {
				const rehydrated = roundTrip(timeout({ phase, step, steps: [{ step, elapsedMs: 1 }] }));
				assert.ok(rehydrated instanceof SessionStartTimeoutError, `${phase} ${step}`);
				assert.equal(rehydrated.phase, phase);
				assert.deepEqual(rehydrated.steps, [{ step, elapsedMs: 1 }]);
			}
		}
		for (const source of ["sdk", "cli", "env", "settings"] as const) {
			for (const reason of ["not-a-positive-integer", "exceeds-maximum"] as const) {
				const rehydrated = roundTrip(new SessionStartConfigError(source, "f", reason, "1"));
				assert.ok(rehydrated instanceof SessionStartConfigError, `${source} ${reason}`);
				assert.equal(rehydrated.source, source);
				assert.equal(rehydrated.reason, reason);
				assert.equal(Object.hasOwn(rehydrated, "cause"), false);
			}
		}
	});

	test("rehydrates a cause as plain data unless it carries a session start code and fields", () => {
		const coded = Object.assign(new Error("lookalike"), { code: "session-start-timeout" });
		const rehydrated = roundTrip(new SessionStartTimeoutError(SETUP_TIMEOUT, { cause: coded })).cause as Error & {
			code?: string;
		};
		assert.ok(!(rehydrated instanceof SessionStartError));
		assert.equal(rehydrated.code, "session-start-timeout");
		const leaf = roundTrip(new SessionStartTimeoutError(SETUP_TIMEOUT, { cause: new Error("leaf") })).cause as Error;
		assert.equal(Object.hasOwn(leaf, "cause"), false);
		assert.equal(Object.hasOwn(leaf, "code"), false);
		const text = roundTrip(new SessionStartTimeoutError(SETUP_TIMEOUT, { cause: "lost" })).cause as Error;
		assert.equal(text.name, "Error");
	});

	test("rehydrates a family cause's retryability as given, false when missing", () => {
		const base = serializeSessionStartError(timeout());
		const family = { name: "SessionStartQuotaError", code: "session-start-timeout", message: "q", fields: {} };
		const missing = rehydrateSessionStartError({ ...base, cause: family }).cause as SessionStartError;
		assert.ok(missing instanceof SessionStartError);
		assert.equal(missing.retryable, false);
		assert.equal(missing.hint, undefined);
		assert.equal(Object.hasOwn(missing, "cause"), false);
		const given = rehydrateSessionStartError({
			...base,
			cause: { ...family, retryable: true, hint: "h", cause: { name: "Error", message: "below" } },
		}).cause as SessionStartError;
		assert.equal(given.retryable, true);
		assert.equal(given.hint, "h");
		assert.equal((given.cause as Error).message, "below");
	});

	test("rehydrates a known class only under its own name", () => {
		const timeoutShaped = { ...serializeSessionStartError(timeout()), name: "SessionStartError" };
		assert.ok(!(rehydrateSessionStartError(timeoutShaped) instanceof SessionStartTimeoutError));
		const configShaped = {
			...serializeSessionStartError(new SessionStartConfigError("sdk", "f", "exceeds-maximum", "1")),
			name: "SessionStartError",
		};
		assert.ok(!(rehydrateSessionStartError(configShaped) instanceof SessionStartConfigError));
	});
});
