import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	AgentRehydrateError,
	AgentReleaseConfigError,
	isAgentRehydrateError,
	isAgentReleaseConfigError,
	isLocalOnlySessionStorage,
	isRetryableAgentRehydrateError,
	rehydrateAgentRehydrateError,
	type SerializedAgentRehydrateError,
	serializeAgentRehydrateError,
	TEAM_JOIN_COMMAND,
} from "../src/core/agent-rehydrate-errors.ts";
import {
	type AgentWake,
	type AgentWakeClock,
	AgentWakeDispatcher,
	agentWakeDispatcher,
	wakeKeyNamespace,
} from "../src/core/agent-wake-dispatcher.ts";

/** A clock tests move by hand; it counts the timers it arms and clears. */
function manualClock() {
	let now = 1_000;
	const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
	let nextId = 1;
	let armed = 0;
	let cleared = 0;
	const clock: AgentWakeClock = {
		now: () => now,
		setTimer(callback, delayMs) {
			armed += 1;
			const id = nextId++;
			timers.set(id, { at: now + delayMs, callback });
			return { id } as { id: number };
		},
		clearTimer(timer) {
			cleared += 1;
			timers.delete((timer as { id: number }).id);
		},
	};
	return {
		clock,
		get armed() {
			return armed;
		},
		get cleared() {
			return cleared;
		},
		get live() {
			return timers.size;
		},
		advance(ms: number) {
			now += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at > now) continue;
				timers.delete(id);
				timer.callback();
			}
		},
	};
}

function wake(id: string, kind: AgentWake["kind"] = "intercom"): AgentWake {
	return { id, kind };
}

async function flush(): Promise<void> {
	for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
}

describe("AgentWakeDispatcher (#4326)", () => {
	test("wakes for one key arrive in order, one handler call at a time, batched while it runs", async () => {
		const dispatcher = new AgentWakeDispatcher();
		const calls: string[][] = [];
		let active = 0;
		let maxActive = 0;
		let release!: () => void;
		const firstCallDone = new Promise<void>((resolve) => {
			release = resolve;
		});
		dispatcher.handle("child", async (_key, wakes) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			calls.push(wakes.map((entry) => entry.id));
			if (calls.length === 1) await firstCallDone;
			active -= 1;
		});

		const first = dispatcher.deliver("child:a", wake("m1"));
		const second = dispatcher.deliver("child:a", wake("m2"));
		const third = dispatcher.deliver("child:a", wake("m3", "tool-result"));
		await flush();
		assert.deepEqual(dispatcher.stats(), {
			keys: 1,
			queued: 2,
			running: 1,
			scheduled: 0,
			timers: 0,
			handlers: 1,
			namespaces: 1,
			unobservedFailures: 0,
		});
		release();
		await Promise.all([first, second, third]);

		assert.deepEqual(calls, [["m1"], ["m2", "m3"]]);
		assert.equal(maxActive, 1);
		assert.equal(dispatcher.stats().keys, 0);
	});

	test("different keys are handled independently", async () => {
		const dispatcher = new AgentWakeDispatcher();
		const seen: string[] = [];
		let releaseA!: () => void;
		const blockA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		dispatcher.handle("child", async (key) => {
			seen.push(key);
			if (key === "child:a") await blockA;
		});

		const a = dispatcher.deliver("child:a", wake("1"));
		await dispatcher.deliver("child:b", wake("1"));
		assert.deepEqual(seen, ["child:a", "child:b"]);
		releaseA();
		await a;
	});

	test("a wake already queued or running is delivered once and settles with the first", async () => {
		const dispatcher = new AgentWakeDispatcher();
		const handled: string[] = [];
		let releaseRun!: () => void;
		const blocked = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});
		dispatcher.handle("child", async (_key, wakes) => {
			handled.push(...wakes.map((entry) => entry.id));
			if (handled.length === 1) await blocked;
		});

		const running = dispatcher.deliver("child:a", wake("m1"));
		const runningAgain = dispatcher.deliver("child:a", wake("m1"));
		const queued = dispatcher.deliver("child:a", wake("m2"));
		const queuedAgain = dispatcher.deliver("child:a", wake("m2"));
		assert.equal(runningAgain, running);
		assert.equal(queuedAgain, queued);
		releaseRun();
		await Promise.all([running, queued]);
		await dispatcher.deliver("child:a", wake("m1"));

		assert.deepEqual(handled, ["m1", "m2", "m1"]);
	});

	test("a key with no handler fails at once and leaves no entry", async () => {
		const dispatcher = new AgentWakeDispatcher();
		const delivery = dispatcher.deliver("ghost:a", wake("1"));
		assert.equal(dispatcher.stats().keys, 0, "refused before any work");
		await assert.rejects(delivery, (error: Error) => {
			assert.ok(isAgentRehydrateError(error));
			assert.equal(error.code, "no-wake-handler");
			assert.deepEqual(error.fields, { wakeKey: "ghost:a", namespace: "ghost" });
			assert.equal(error.retryable, false);
			return true;
		});
		assert.equal(dispatcher.stats().keys, 0);
	});

	test("a handler removed while wakes are queued fails them as no-wake-handler", async () => {
		const dispatcher = new AgentWakeDispatcher();
		let releaseRun!: () => void;
		const blocked = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});
		const remove = dispatcher.handle("child", () => blocked);
		const running = dispatcher.deliver("child:a", wake("1"));
		const queued = dispatcher.deliver("child:a", wake("2"));
		remove();
		releaseRun();
		await running;
		await assert.rejects(queued, (error: AgentRehydrateError) => error.code === "no-wake-handler");
		assert.equal(dispatcher.stats().keys, 0);
	});

	test("each namespace has one handler; removing it frees the namespace", () => {
		const dispatcher = new AgentWakeDispatcher();
		const remove = dispatcher.handle("child", async () => {});
		assert.throws(
			() => dispatcher.handle("child", async () => {}),
			(error: AgentRehydrateError) =>
				error.code === "wake-handler-conflict" && error.fields.namespace === "child" && !error.retryable,
		);
		const removeOther = dispatcher.handle("session-idle", async () => {});
		remove();
		remove();
		assert.equal(dispatcher.stats().handlers, 1);
		dispatcher.handle("child", async () => {});
		removeOther();
		assert.equal(dispatcher.stats().handlers, 1);
	});

	test("a handler failure rejects the batch as wake-failed with its cause, and the key recovers", async () => {
		const dispatcher = new AgentWakeDispatcher();
		const cause = new Error("store unavailable");
		let fail = true;
		dispatcher.handle("child", async () => {
			if (fail) throw cause;
		});
		await assert.rejects(dispatcher.deliver("child:a", wake("1")), (error: AgentRehydrateError) => {
			assert.equal(error.code, "wake-failed");
			assert.equal(error.cause, cause);
			assert.deepEqual(error.fields, { wakeKey: "child:a", wakes: 1 });
			return true;
		});
		assert.equal(dispatcher.stats().keys, 0);
		fail = false;
		await dispatcher.deliver("child:a", wake("2"));
	});

	test("timed wakes share one timer armed for the earliest, and cancelling the last disarms it", async () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		const fired: string[] = [];
		dispatcher.handle("session-idle", async (key, wakes) => {
			fired.push(`${key}/${wakes.map((entry) => entry.id).join(",")}`);
		});
		for (let index = 0; index < 50; index++)
			dispatcher.schedule(`session-idle:s${index}`, wake("idle", "timer"), 500 + index);
		assert.equal(time.live, 1);
		assert.deepEqual(dispatcher.stats(), {
			keys: 0,
			queued: 0,
			running: 0,
			scheduled: 50,
			timers: 1,
			handlers: 1,
			namespaces: 1,
			unobservedFailures: 0,
		});
		dispatcher.schedule("session-idle:early", wake("idle", "timer"), 100);
		assert.equal(time.live, 1);
		time.advance(100);
		await flush();
		assert.deepEqual(fired, ["session-idle:early/idle"]);
		assert.equal(time.live, 1);

		for (let index = 0; index < 49; index++) assert.ok(dispatcher.cancel(`session-idle:s${index}`, "idle"));
		assert.equal(dispatcher.cancel("session-idle:s0", "idle"), false);
		time.advance(449);
		await flush();
		assert.deepEqual(fired, ["session-idle:early/idle", "session-idle:s49/idle"]);
		assert.equal(time.live, 0);
		assert.equal(dispatcher.stats().timers, 0);
		assert.equal(dispatcher.stats().scheduled, 0);
	});

	test("scheduling the same key and id again replaces the earlier wake", async () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		let calls = 0;
		dispatcher.handle("session-idle", async () => {
			calls += 1;
		});
		dispatcher.schedule("session-idle:a", wake("idle", "timer"), 100);
		dispatcher.schedule("session-idle:a", wake("idle", "timer"), 300);
		assert.equal(dispatcher.stats().scheduled, 1);
		time.advance(100);
		await flush();
		assert.equal(calls, 0);
		time.advance(200);
		await flush();
		assert.equal(calls, 1);
	});

	test("a negative or non-finite delay is due at once", async () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		const fired: string[] = [];
		dispatcher.handle("t", async (key) => {
			fired.push(key);
		});
		dispatcher.schedule("t:negative", wake("x", "timer"), -50);
		dispatcher.schedule("t:nan", wake("x", "timer"), Number.NaN);
		time.advance(0);
		await flush();
		assert.deepEqual(fired.sort(), ["t:nan", "t:negative"]);
	});

	test("a failed timed wake is counted and reported, never lost silently", async () => {
		const time = manualClock();
		const reported: AgentRehydrateError[] = [];
		const dispatcher = new AgentWakeDispatcher({
			clock: time.clock,
			onUnobservedFailure: (error) => reported.push(error),
		});
		dispatcher.handle("session-idle", async () => {
			throw new Error("boom");
		});
		dispatcher.schedule("session-idle:a", wake("idle", "timer"), 10);
		time.advance(10);
		await flush();
		assert.equal(dispatcher.stats().unobservedFailures, 1);
		assert.equal(reported.length, 1);
		assert.equal(reported[0]?.code, "wake-failed");
		assert.equal(dispatcher.lastFailure, reported[0]);

		const silent = new AgentWakeDispatcher({ clock: time.clock });
		silent.handle("session-idle", async () => {
			throw new Error("boom");
		});
		silent.schedule("session-idle:a", wake("idle", "timer"), 10);
		time.advance(10);
		await flush();
		assert.equal(silent.lastFailure?.code, "wake-failed");
	});

	test("the system clock arms a real, unref'd timer", async () => {
		const dispatcher = new AgentWakeDispatcher();
		const fired: string[] = [];
		dispatcher.handle("t", async (key) => {
			fired.push(key);
		});
		dispatcher.schedule("t:a", wake("x", "timer"), 1);
		assert.equal(dispatcher.stats().timers, 1);
		while (fired.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
		assert.deepEqual(fired, ["t:a"]);
		assert.equal(dispatcher.stats().timers, 0);
		dispatcher.schedule("t:b", wake("x", "timer"), 60_000);
		assert.ok(dispatcher.cancel("t:b", "x"));
	});

	test("namespaces are the text before the first colon", () => {
		assert.equal(wakeKeyNamespace("subagent:owner/child:1"), "subagent");
		assert.equal(wakeKeyNamespace("plain"), "plain");
		assert.equal(wakeKeyNamespace(":x"), "");
	});

	test("the process has one dispatcher", () => {
		assert.equal(agentWakeDispatcher(), agentWakeDispatcher());
	});
});

describe("AgentRehydrateError (#4326)", () => {
	test("session-not-found on local-only storage names the team join command", () => {
		const error = new AgentRehydrateError("session-not-found", {
			sessionId: "s-1",
			storage: "node-sqlite",
			localOnly: true,
		});
		assert.equal(
			error.message,
			`Session s-1 is not in this node's node-sqlite storage (session-not-found). This node keeps sessions in local-only storage (node-sqlite) and is not joined to shared storage, so a session saved on another node is not here. Join shared storage with \`${TEAM_JOIN_COMMAND}\`, or pass the id of a session saved on this node.`,
		);
		assert.ok(error.hint.includes("atomic team join <url> --token-file <path>"));
		const shared = new AgentRehydrateError("session-not-found", {
			sessionId: "s-1",
			storage: "libsql",
			localOnly: false,
		});
		assert.ok(!shared.hint.includes("team join"));
		assert.ok(shared.hint.includes("libsql"));
	});

	test("every code has a hint, a message built from its fields, and only session-busy is retryable", () => {
		const cases: Array<[AgentRehydrateError, string, boolean]> = [
			[new AgentRehydrateError("session-busy", { sessionId: "s", activity: "streaming" }), "streaming", true],
			[new AgentRehydrateError("no-wake-handler", { wakeKey: "x:1", namespace: "x" }), "x:1", false],
			[new AgentRehydrateError("wake-handler-conflict", { namespace: "x" }), '"x"', false],
			[new AgentRehydrateError("wake-failed", { wakeKey: "x:1", wakes: 2 }), "x:1", false],
			[new AgentReleaseConfigError({ source: "sdk", field: "releaseWhenIdle.afterMs", value: "-1" }), "-1", false],
		];
		for (const [error, subject, retryable] of cases) {
			assert.ok(error.message.includes(subject), error.message);
			assert.ok(error.message.includes(`(${error.code}). ${error.hint}`), error.message);
			assert.ok(error.hint.length > 0);
			assert.equal(error.retryable, retryable);
			assert.ok(isAgentRehydrateError(error));
		}
	});

	test("errors round-trip through JSON as the same class with fields and a bounded cause chain", () => {
		let cause: Error = Object.assign(new Error("leaf"), { code: "ENOENT" });
		for (let depth = 0; depth < 12; depth++) cause = new Error(`level ${depth}`, { cause });
		const original = new AgentRehydrateError("wake-failed", { wakeKey: "child:a", wakes: 3 }, { cause });
		const wire = JSON.parse(JSON.stringify(serializeAgentRehydrateError(original))) as SerializedAgentRehydrateError;
		assert.equal(wire.name, "AgentRehydrateError");
		assert.equal(wire.code, "wake-failed");
		assert.equal(wire.retryable, false);
		let depth = 0;
		for (let link = wire.cause; link !== undefined; link = link.cause) depth += 1;
		assert.equal(depth, 8);

		const rebuilt = rehydrateAgentRehydrateError(wire);
		assert.ok(rebuilt instanceof AgentRehydrateError);
		assert.equal(rebuilt.code, "wake-failed");
		assert.deepEqual(rebuilt.fields, original.fields);
		assert.equal(rebuilt.message, original.message);
		assert.equal((rebuilt.cause as Error).message, "level 11");
		assert.equal((rebuilt.cause as Error).name, "Error");

		const config = new AgentReleaseConfigError({ source: "settings", field: "releaseWhenIdle", value: "true" });
		const rebuiltConfig = rehydrateAgentRehydrateError(JSON.parse(JSON.stringify(config)));
		assert.ok(rebuiltConfig instanceof AgentReleaseConfigError);
		assert.ok(isAgentReleaseConfigError(rebuiltConfig));
		assert.deepEqual(
			[rebuiltConfig.source, rebuiltConfig.field, rebuiltConfig.value],
			["settings", "releaseWhenIdle", "true"],
		);
	});

	test("a cause with a code, or a non-error cause, keeps what it can", () => {
		const coded = new AgentRehydrateError(
			"wake-failed",
			{ wakeKey: "k" },
			{ cause: { name: "StorageError", message: "x", code: "EBUSY" } },
		);
		assert.deepEqual(coded.toJSON().cause, { name: "StorageError", message: "x", code: "EBUSY" });
		const text = new AgentRehydrateError("wake-failed", { wakeKey: "k" }, { cause: "plain" });
		assert.deepEqual(text.toJSON().cause, { name: "Error", message: "plain" });
		const odd = new AgentRehydrateError("wake-failed", { wakeKey: "k" }, { cause: { code: 7 } });
		assert.deepEqual(odd.toJSON().cause, { name: "Error", message: "" });
		const rebuilt = rehydrateAgentRehydrateError(coded.toJSON());
		assert.equal((rebuilt.cause as Error & { code?: string }).code, "EBUSY");
		assert.equal((rebuilt.cause as Error).name, "StorageError");
		assert.equal(
			new AgentRehydrateError("session-busy", { sessionId: "s", activity: "shell" }).toJSON().cause,
			undefined,
		);
	});

	test("an unknown name or code rehydrates into the family base keeping name, code, message and hint", () => {
		const rebuilt = rehydrateAgentRehydrateError({
			name: "AgentFutureError",
			code: "future-code",
			message: "from a newer node",
			hint: "upgrade",
			retryable: true,
			fields: { sessionId: "s" },
		});
		assert.ok(rebuilt instanceof AgentRehydrateError);
		assert.equal(rebuilt.name, "AgentFutureError");
		assert.equal(rebuilt.code as string, "future-code");
		assert.equal(rebuilt.message, "from a newer node");
		assert.equal(rebuilt.hint, "upgrade");
		assert.equal(rebuilt.retryable, true);
		const sameNameUnknownCode = rehydrateAgentRehydrateError({
			name: "AgentRehydrateError",
			code: "other",
			message: "m",
			hint: "h",
			retryable: false,
			fields: {},
		});
		assert.equal(sameNameUnknownCode.code as string, "other");
		const configNameOtherCode = rehydrateAgentRehydrateError({
			name: "AgentReleaseConfigError",
			code: "session-busy",
			message: "m",
			hint: "h",
			retryable: true,
			fields: { sessionId: "s", activity: "prompt" },
		});
		assert.ok(!(configNameOtherCode instanceof AgentReleaseConfigError));
		assert.equal(configNameOtherCode.name, "AgentReleaseConfigError");
		const configMissingFields = rehydrateAgentRehydrateError({
			name: "AgentReleaseConfigError",
			code: "invalid-release-policy",
			message: "m",
			hint: "h",
			retryable: false,
			fields: {},
		});
		assert.deepEqual(
			[
				(configMissingFields as AgentReleaseConfigError).source,
				(configMissingFields as AgentReleaseConfigError).field,
			],
			["sdk", ""],
		);
	});

	test("guards accept structural copies and reject look-alikes", () => {
		const copy = JSON.parse(
			JSON.stringify(new AgentRehydrateError("session-busy", { sessionId: "s", activity: "prompt" })),
		);
		assert.ok(isAgentRehydrateError(copy));
		assert.ok(!isAgentReleaseConfigError(copy));
		const configCopy = JSON.parse(
			JSON.stringify(new AgentReleaseConfigError({ source: "sdk", field: "f", value: "v" })),
		);
		assert.ok(isAgentReleaseConfigError(configCopy));
		assert.ok(isAgentRehydrateError(configCopy));
		assert.ok(!isAgentRehydrateError({ name: "AgentRehydrateError", code: "nope" }));
		assert.ok(!isAgentRehydrateError({ name: "AgentRehydrateError", code: 3 }));
		assert.ok(!isAgentRehydrateError({ name: "Other", code: "session-busy" }));
		assert.ok(!isAgentReleaseConfigError({ name: "AgentReleaseConfigError", code: "session-busy" }));
		assert.ok(!isAgentRehydrateError(null));
		assert.ok(!isAgentRehydrateError(undefined));
		assert.ok(!isAgentReleaseConfigError(null));
		assert.ok(!isAgentRehydrateError(new Error("x")));
	});

	test("retryability is found anywhere in a bounded cause chain", () => {
		const busy = new AgentRehydrateError("session-busy", { sessionId: "s", activity: "prompt" });
		const wrapped = new AgentRehydrateError("wake-failed", { wakeKey: "k" }, { cause: busy });
		assert.ok(isRetryableAgentRehydrateError(wrapped));
		assert.ok(!isRetryableAgentRehydrateError(new AgentRehydrateError("wake-failed", { wakeKey: "k" })));
		let deep: Error = busy;
		for (let depth = 0; depth < 8; depth++) deep = new Error("wrap", { cause: deep });
		assert.ok(!isRetryableAgentRehydrateError(deep));
		assert.ok(!isRetryableAgentRehydrateError(null));
		assert.ok(isRetryableAgentRehydrateError(JSON.parse(JSON.stringify(busy))));
	});

	test("local-only storage is the node's own stores, not shared adapters", () => {
		for (const adapter of ["node-sqlite", "jsonl", "memory"]) assert.ok(isLocalOnlySessionStorage(adapter));
		for (const adapter of ["libsql", "postgres", ""]) assert.ok(!isLocalOnlySessionStorage(adapter));
	});
});

describe("AgentWakeDispatcher concurrency (#4326)", () => {
	test("a namespace's cap runs that many keys at once and lets the rest in first in, first out", async () => {
		const dispatcher = new AgentWakeDispatcher();
		const started: string[] = [];
		let active = 0;
		let maxActive = 0;
		const gates = new Map<string, () => void>();
		dispatcher.handle(
			"bench",
			async (key) => {
				started.push(key);
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise<void>((resolve) => gates.set(key, resolve));
				active -= 1;
			},
			{ maxConcurrent: 2 },
		);
		const keys = ["bench:a", "bench:b", "bench:c", "bench:d", "bench:e"];
		const delivered = keys.map((key) => dispatcher.deliver(key, wake("1")));
		const late = dispatcher.deliver("bench:e", wake("2"));
		await flush();
		assert.deepEqual(started, ["bench:a", "bench:b"]);
		assert.equal(dispatcher.stats().queued, 4, "waiting keys keep their wakes queued");
		gates.get("bench:b")?.();
		await flush();
		assert.deepEqual(started, ["bench:a", "bench:b", "bench:c"]);
		for (const key of ["bench:a", "bench:c"]) gates.get(key)?.();
		await flush();
		assert.deepEqual(started, ["bench:a", "bench:b", "bench:c", "bench:d", "bench:e"]);
		gates.get("bench:d")?.();
		gates.get("bench:e")?.();
		await Promise.all([...delivered, late]);
		assert.equal(maxActive, 2);
		assert.deepEqual(
			started.filter((key) => key === "bench:e"),
			["bench:e"],
			"a wake that arrived while its key waited for a slot joined that key's batch",
		);
		assert.equal(dispatcher.stats().keys, 0);
	});

	test("an invalid cap is refused as a config error before the handler is registered", () => {
		const dispatcher = new AgentWakeDispatcher();
		for (const [value, shown] of [
			[0, "0"],
			[-1, "-1"],
			[1.5, "1.5"],
			[Number.NaN, "NaN"],
		] as const)
			assert.throws(
				() => dispatcher.handle("bench", async () => {}, { maxConcurrent: value }),
				(error: AgentReleaseConfigError) => {
					assert.ok(isAgentReleaseConfigError(error));
					assert.deepEqual([error.source, error.field, error.value], ["sdk", "maxConcurrent", shown]);
					assert.match(error.hint, /maxConcurrent as a whole number of at least 1/);
					return true;
				},
			);
		assert.equal(dispatcher.stats().handlers, 0);
		dispatcher.handle("bench", async () => {}, { maxConcurrent: 1 });
		dispatcher.handle("other", async () => {}, { maxConcurrent: Number.POSITIVE_INFINITY });
		assert.equal(dispatcher.stats().namespaces, 2);
	});

	test("a removed namespace keeps no slot record once its last running key finishes", async () => {
		const dispatcher = new AgentWakeDispatcher();
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const remove = dispatcher.handle("bench", () => blocked, { maxConcurrent: 1 });
		const running = dispatcher.deliver("bench:a", wake("1"));
		await flush();
		remove();
		assert.equal(dispatcher.stats().namespaces, 1, "still running");
		release();
		await running;
		assert.equal(dispatcher.stats().namespaces, 0);
		const again = dispatcher.handle("bench", async () => {});
		again();
		assert.equal(dispatcher.stats().namespaces, 0);
	});
});

describe("AgentWakeDispatcher handler replacement (#4326)", () => {
	test("replace takes a namespace over; the older handler's remover then does nothing", async () => {
		const dispatcher = new AgentWakeDispatcher();
		const calls: string[] = [];
		const removeOld = dispatcher.handle("child", async () => {
			calls.push("old");
		});
		const removeNew = dispatcher.handle(
			"child",
			async () => {
				calls.push("new");
			},
			{ replace: true },
		);
		removeOld();
		await dispatcher.deliver("child:a", wake("1"));
		assert.deepEqual(calls, ["new"]);
		assert.throws(
			() => dispatcher.handle("child", async () => {}, { replace: false }),
			(error: AgentRehydrateError) => error.code === "wake-handler-conflict",
		);
		removeNew();
		assert.equal(dispatcher.stats().handlers, 0);
	});
});

describe("AgentRehydrateError messages and serialization (#4326)", () => {
	test("each code renders its subject, code and hint", () => {
		const cases: Array<[AgentRehydrateError, string]> = [
			[
				new AgentReleaseConfigError({ source: "sdk", field: "releaseWhenIdle.afterMs", value: "-1" }),
				"Invalid releaseWhenIdle.afterMs from sdk: -1 (invalid-release-policy). Pass releaseWhenIdle as { afterMs } with afterMs a finite number of milliseconds of at least 0, or leave it unset.",
			],
			[
				new AgentReleaseConfigError({ source: "sdk", field: "maxConcurrent", value: "0" }),
				"Invalid maxConcurrent from sdk: 0 (invalid-release-policy). Pass maxConcurrent as a whole number of at least 1, or leave it unset for no limit.",
			],
			[
				new AgentRehydrateError("session-busy", { sessionId: "s-1", activity: "compaction" }),
				"Session s-1 cannot be released while its compaction is active (session-busy). Wait until the session settles (its agent_settled event), then release it again.",
			],
			[
				new AgentRehydrateError("session-not-found", { sessionId: "s-2", storage: "libsql", localOnly: false }),
				"Session s-2 is not in this node's libsql storage (session-not-found). Check the session id: the libsql storage this node uses has no session with it.",
			],
			[
				new AgentRehydrateError("no-wake-handler", { wakeKey: "bench:a", namespace: "bench" }),
				'No wake handler for bench:a (no-wake-handler). Register a handler for the "bench" wake namespace with AgentWakeDispatcher.handle() before delivering wakes to its keys.',
			],
			[
				new AgentRehydrateError("wake-handler-conflict", { namespace: "bench" }),
				'A wake handler for namespace "bench" is already registered (wake-handler-conflict). Dispose the handler already registered for the "bench" wake namespace first; each namespace has one handler.',
			],
			[
				new AgentRehydrateError("wake-failed", { wakeKey: "bench:b", wakes: 2 }),
				"Waking bench:b failed (wake-failed). The agent was not rehydrated and its wakes were not handled; fix the cause, then deliver them again.",
			],
		];
		for (const [error, message] of cases) assert.equal(error.message, message);
	});

	test("an error without a cause serializes without one, and rebuilds without one", () => {
		const error = new AgentRehydrateError("session-busy", { sessionId: "s", activity: "prompt" });
		const wire = error.toJSON();
		assert.deepStrictEqual(wire, {
			name: "AgentRehydrateError",
			code: "session-busy",
			message: error.message,
			hint: error.hint,
			retryable: true,
			fields: { sessionId: "s", activity: "prompt" },
		});
		const rebuilt = rehydrateAgentRehydrateError(wire);
		assert.equal("cause" in rebuilt, false);
		assert.equal(rebuilt.retryable, true);
	});

	test("a serialized chain deeper than the bound rebuilds to eight links, keeping names and codes", () => {
		type Link = { name: string; message: string; code?: string; cause?: Link };
		let chain: Link | undefined;
		for (let depth = 11; depth >= 0; depth--)
			chain = {
				name: `E${depth}`,
				message: `m${depth}`,
				...(depth % 2 === 0 ? { code: `c${depth}` } : {}),
				...(chain ? { cause: chain } : {}),
			};
		const rebuilt = rehydrateAgentRehydrateError({
			name: "AgentRehydrateError",
			code: "wake-failed",
			message: "m",
			hint: "h",
			retryable: false,
			fields: { wakeKey: "k" },
			...(chain ? { cause: chain } : {}),
		});
		const links: Array<Error & { code?: string }> = [];
		for (let link = rebuilt.cause as (Error & { code?: string }) | undefined; link; link = link.cause as typeof link)
			links.push(link);
		assert.deepEqual(
			links.map((link) => [link.name, link.message, link.code]),
			[
				["E0", "m0", "c0"],
				["E1", "m1", undefined],
				["E2", "m2", "c2"],
				["E3", "m3", undefined],
				["E4", "m4", "c4"],
				["E5", "m5", undefined],
				["E6", "m6", "c6"],
				["E7", "m7", undefined],
			],
		);
		assert.equal("cause" in (links.at(-1) as Error), false, "the last link carries no cause");
		assert.equal("code" in (links[1] as Error), false, "a link without a code gets none");
	});

	test("a config error rebuilt without fields falls back to sdk and empty texts", () => {
		const rebuilt = rehydrateAgentRehydrateError({
			name: "AgentReleaseConfigError",
			code: "invalid-release-policy",
			message: "m",
			hint: "h",
			retryable: false,
			fields: {},
		}) as AgentReleaseConfigError;
		assert.deepEqual([rebuilt.source, rebuilt.field, rebuilt.value], ["sdk", "", ""]);
		assert.ok(!isAgentReleaseConfigError(undefined));
		const configLookalike = rehydrateAgentRehydrateError({
			name: "AgentReleaseConfigError",
			code: "not-a-code",
			message: "m",
			hint: "h",
			retryable: false,
			fields: {},
		});
		assert.ok(!(configLookalike instanceof AgentReleaseConfigError));
		assert.equal(configLookalike.code as string, "not-a-code");
	});
});

describe("AgentWakeDispatcher scheduling and slots (#4326)", () => {
	test("timed wakes fire in time order, and wakes due at the same time in the order they were scheduled", async () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		const fired: string[] = [];
		dispatcher.handle("t", async (key) => {
			fired.push(key);
		});
		dispatcher.schedule("t:a", wake("x", "timer"), 10);
		dispatcher.schedule("t:b", wake("x", "timer"), 20);
		dispatcher.schedule("t:c", wake("x", "timer"), 20);
		time.advance(10);
		await flush();
		assert.deepEqual(fired, ["t:a"]);
		time.advance(10);
		await flush();
		assert.deepEqual(fired, ["t:a", "t:b", "t:c"]);
	});

	test("the timer is armed once for the earliest wake and not again for later ones", async () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		dispatcher.handle("t", async () => {});
		dispatcher.schedule("t:a", wake("x", "timer"), 100);
		dispatcher.schedule("t:b", wake("x", "timer"), 200);
		dispatcher.schedule("t:c", wake("x", "timer"), 300);
		assert.equal(time.armed, 1);
		time.advance(99);
		assert.equal(time.armed, 1, "the timer waits the full delay to the earliest wake");
		assert.equal(dispatcher.stats().scheduled, 3);
		time.advance(1);
		await flush();
		assert.equal(time.armed, 2, "firing arms one timer for the next wake");
		assert.equal(dispatcher.stats().scheduled, 2);
	});

	test("a namespace's cap still holds after its first run finishes", async () => {
		const dispatcher = new AgentWakeDispatcher();
		const gates: Array<() => void> = [];
		let active = 0;
		let maxActive = 0;
		dispatcher.handle(
			"bench",
			async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise<void>((resolve) => gates.push(resolve));
				active -= 1;
			},
			{ maxConcurrent: 1 },
		);
		const first = dispatcher.deliver("bench:a", wake("1"));
		await flush();
		gates.shift()?.();
		await first;
		assert.equal(dispatcher.stats().namespaces, 1);
		const later = [dispatcher.deliver("bench:b", wake("1")), dispatcher.deliver("bench:c", wake("1"))];
		await flush();
		assert.equal(active, 1);
		while (gates.length > 0 || active > 0) {
			gates.shift()?.();
			await flush();
		}
		await Promise.all(later);
		assert.equal(maxActive, 1);
	});

	test("a wake id delivered again after its batch finished, while the key waits for a slot, is handled again", async () => {
		const dispatcher = new AgentWakeDispatcher();
		const calls: string[] = [];
		const gates = new Map<string, () => void>();
		dispatcher.handle(
			"bench",
			async (key, wakes) => {
				calls.push(`${key}/${wakes.map((entry) => entry.id).join(",")}`);
				await new Promise<void>((resolve) => gates.set(key, resolve));
			},
			{ maxConcurrent: 1 },
		);
		const firstA = dispatcher.deliver("bench:a", wake("w1"));
		await flush();
		const onlyB = dispatcher.deliver("bench:b", wake("x"));
		const secondA = dispatcher.deliver("bench:a", wake("w2"));
		gates.get("bench:a")?.();
		await firstA;
		await flush();
		const againA = dispatcher.deliver("bench:a", wake("w1"));
		gates.get("bench:b")?.();
		await onlyB;
		await flush();
		gates.get("bench:a")?.();
		await Promise.all([secondA, againA]);
		assert.deepEqual(calls, ["bench:a/w1", "bench:b/x", "bench:a/w2,w1"]);
	});

	test("a handler removed while a key waits for a slot fails that key's wakes with its key and namespace", async () => {
		const dispatcher = new AgentWakeDispatcher();
		let releaseRun!: () => void;
		const blocked = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});
		const remove = dispatcher.handle("bench", () => blocked, { maxConcurrent: 1 });
		const running = dispatcher.deliver("bench:a", wake("1"));
		const waiting = dispatcher.deliver("bench:b", wake("1"));
		await flush();
		remove();
		releaseRun();
		await running;
		await assert.rejects(waiting, (error: AgentRehydrateError) => {
			assert.equal(error.code, "no-wake-handler");
			assert.deepEqual(error.fields, { wakeKey: "bench:b", namespace: "bench" });
			return true;
		});
	});

	test("any error a handler throws, a rehydrate error included, is reported as wake-failed caused by it", async () => {
		const dispatcher = new AgentWakeDispatcher();
		const notFound = new AgentRehydrateError("session-not-found", {
			sessionId: "s",
			storage: "sqlite",
			localOnly: true,
		});
		dispatcher.handle("child", async () => {
			throw notFound;
		});
		await assert.rejects(dispatcher.deliver("child:a", wake("1")), (error: AgentRehydrateError) => {
			assert.equal(error.code, "wake-failed");
			assert.equal(error.cause, notFound);
			return true;
		});
	});
});

describe("AgentWakeDispatcher cancellation and error rebuilding details (#4326)", () => {
	test("cancelling the earliest wake re-arms the timer for the next, and cancelling the last clears it", () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		dispatcher.handle("t", async () => {});
		dispatcher.schedule("t:a", wake("x", "timer"), 100);
		dispatcher.schedule("t:b", wake("x", "timer"), 200);
		assert.equal(dispatcher.cancel("t:a", "x"), true);
		assert.equal(time.armed, 2, "re-armed for the next wake");
		assert.equal(time.live, 1);
		assert.equal(dispatcher.cancel("t:b", "x"), true);
		assert.equal(time.live, 0);
		assert.equal(dispatcher.stats().timers, 0);
	});

	test("a null cause is no cause", () => {
		const error = new AgentRehydrateError("wake-failed", { wakeKey: "k", wakes: 1 }, { cause: null });
		assert.equal("cause" in error.toJSON(), false);
	});

	test("a known code is rebuilt with this version's message and hint from its fields", () => {
		const rebuilt = rehydrateAgentRehydrateError({
			name: "AgentRehydrateError",
			code: "session-busy",
			message: "worded by another version",
			hint: "hinted by another version",
			retryable: true,
			fields: { sessionId: "s", activity: "prompt" },
		});
		const local = new AgentRehydrateError("session-busy", { sessionId: "s", activity: "prompt" });
		assert.deepEqual([rebuilt.message, rebuilt.hint], [local.message, local.hint]);
	});

	test("the family base carrying the config code stays the family base", () => {
		const rebuilt = rehydrateAgentRehydrateError({
			name: "AgentRehydrateError",
			code: "invalid-release-policy",
			message: "m",
			hint: "h",
			retryable: false,
			fields: { source: "sdk", field: "releaseWhenIdle", value: "1" },
		});
		assert.equal(rebuilt instanceof AgentReleaseConfigError, false);
		assert.equal(rebuilt.code, "invalid-release-policy");
	});

	test("an error of a name or code this version does not know is still recognized as one of the family", () => {
		const rebuilt = rehydrateAgentRehydrateError({
			name: "AgentFutureError",
			code: "future-code" as AgentRehydrateError["code"],
			message: "m",
			hint: "h",
			retryable: false,
			fields: {},
		});
		assert.equal(isAgentRehydrateError(rebuilt), true);
	});
});

describe("AgentWakeDispatcher handler takeover while a key runs (#4326)", () => {
	test("a namespace taken over while a run holds a slot keeps that slot, takes the new cap, and is forgotten once idle", async () => {
		const dispatcher = new AgentWakeDispatcher();
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		dispatcher.handle("child", () => blocked, { maxConcurrent: 1 });
		const running = dispatcher.deliver("child:a", wake("1"));
		await flush();
		const started: string[] = [];
		const gates: Array<() => void> = [];
		const removeNew = dispatcher.handle(
			"child",
			async (key) => {
				started.push(key);
				await new Promise<void>((resolve) => gates.push(resolve));
			},
			{ replace: true, maxConcurrent: 2 },
		);
		release();
		await running;
		const later = [dispatcher.deliver("child:b", wake("1")), dispatcher.deliver("child:c", wake("1"))];
		await flush();
		assert.deepEqual(started, ["child:b", "child:c"], "the earlier run's slot is free and the new cap is 2");
		for (const open of gates) open();
		await Promise.all(later);
		removeNew();
		assert.equal(dispatcher.stats().namespaces, 0);
	});

	test("a key started under the old handler still holds its slot after a takeover", async () => {
		const dispatcher = new AgentWakeDispatcher();
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		dispatcher.handle("child", () => blocked, { maxConcurrent: 1 });
		const running = dispatcher.deliver("child:a", wake("1"));
		await flush();
		const started: string[] = [];
		dispatcher.handle(
			"child",
			async (key) => {
				started.push(key);
			},
			{ replace: true, maxConcurrent: 1 },
		);
		const next = dispatcher.deliver("child:b", wake("1"));
		await flush();
		assert.deepEqual(started, [], "b waits for the slot a still holds");
		release();
		await Promise.all([running, next]);
		assert.deepEqual(started, ["child:b"]);
	});

	test("cancel drops only the wake with that id on that key", async () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		const fired: string[] = [];
		dispatcher.handle("t", async (_key, wakes) => {
			fired.push(...wakes.map((entry) => entry.id));
		});
		dispatcher.schedule("t:k", wake("x", "timer"), 10);
		dispatcher.schedule("t:k", wake("y", "timer"), 20);
		assert.equal(dispatcher.cancel("t:k", "y"), true);
		assert.equal(dispatcher.cancel("t:other", "x"), false);
		time.advance(20);
		await flush();
		assert.deepEqual(fired, ["x"]);
	});
});
