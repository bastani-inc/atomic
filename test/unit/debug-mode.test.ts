import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import {
	appendDebugRecord,
	DEBUG_AREA_VARIABLES,
	type DebugArea,
	getDebugLogFailure,
	isDebugEnabled,
	reportDebug,
} from "../../packages/coding-agent/src/core/debug.js";
import {
	DebugConfigError,
	DebugError,
	DebugLogUnwritableError,
	isDebugConfigError,
	isDebugError,
	isDebugLogUnwritableError,
	rehydrateDebugError,
	type SerializedDebugError,
	serializeDebugError,
} from "../../packages/coding-agent/src/core/debug-errors.js";
import { onDebugSettingChange, setDebugSetting } from "../../packages/coding-agent/src/core/debug-setting.js";
import { reportModelRoutingDebug } from "../../packages/coding-agent/src/core/model-routing-debug.js";
import { createChildProcessEnvironment } from "../../packages/coding-agent/src/utils/child-process.js";
import { getBrokerSpawnOptions } from "../../packages/intercom/broker/spawn.js";
import { poolCoordinationLine } from "../../packages/workflows/src/shared/pool-coordination.js";
import type { PoolCoordinationStats } from "../../packages/workflows/src/shared/store-types.js";
import { POOL_DURABLE_JOURNAL_ENV, poolWorkerEnvironment } from "../../packages/workflows/src/workers/pool-journal.js";
import {
	configurePooledWatchTrace,
	tracePooledWatch,
} from "../../packages/workflows/src/workers/pooled-watch-trace.js";
import { areaRecords, DEBUG_MODE_SOURCES, withDebugLog } from "../helpers/debug-mode.js";
import { bunExecutable, makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const AREAS = Object.keys(DEBUG_AREA_VARIABLES) as DebugArea[];

afterEach(() => {
	setDebugSetting(false);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("isDebugEnabled (#4360)", () => {
	test("names each area's own variable", () => {
		assert.deepEqual(DEBUG_AREA_VARIABLES, {
			workflow: "ATOMIC_WORKFLOW_DEBUG",
			"model-routing": "ATOMIC_MODEL_ROUTING_DEBUG",
			"pooled-watch": "ATOMIC_DEBUG_POOLED_WATCH",
			pool: undefined,
		});
	});

	test.each(AREAS)("%s is off with no source, and on from the setting and from ATOMIC_DEBUG=1", (area) => {
		assert.equal(isDebugEnabled(area, {}), false);
		assert.equal(isDebugEnabled(area, { ATOMIC_DEBUG: "1" }), true);
		assert.equal(isDebugEnabled(area, { PI_DEBUG: "1" }), true, "the legacy alias");
		assert.equal(isDebugEnabled(area, { ATOMIC_DEBUG: "0" }), false);
		assert.equal(isDebugEnabled(area, { ATOMIC_DEBUG: "" }), false);
		assert.equal(isDebugEnabled(area, { ATOMIC_DEBUG: "0", PI_DEBUG: "1" }), false, "the Atomic name wins");
		assert.equal(isDebugEnabled(area, { ATOMIC_DEBUG: "1", PI_DEBUG: "0" }), true);
		setDebugSetting(true);
		assert.equal(isDebugEnabled(area, {}), true);
		setDebugSetting(false);
		assert.equal(isDebugEnabled(area, {}), false);
	});

	test.each(AREAS.filter((area) => DEBUG_AREA_VARIABLES[area] !== undefined))(
		"%s is on from its own variable alone",
		(area) => {
			const own = DEBUG_AREA_VARIABLES[area]!;
			assert.equal(isDebugEnabled(area, { [own]: "1" }), true);
			assert.equal(isDebugEnabled(area, { [own]: "" }), false);
			assert.equal(isDebugEnabled(area, { [own]: "0" }), false);
			assert.equal(isDebugEnabled(undefined, { [own]: "1" }), false, "an area variable is not debug mode");
			for (const other of AREAS.filter((candidate) => candidate !== area))
				assert.equal(isDebugEnabled(other, { [own]: "1" }), false, `${own} does not turn on ${other}`);
		},
	);

	test("the pool area has no variable of its own, whatever the environment holds", () => {
		assert.equal(isDebugEnabled("pool", { undefined: "1", "": "1" }), false);
	});

	test("a process starts with the setting its parent passed down", async () => {
		for (const [inherited, expected] of [
			["1", true],
			["0", false],
		] as const) {
			vi.resetModules();
			vi.stubEnv("ATOMIC_DEBUG_SETTING", inherited);
			const fresh = await import("../../packages/coding-agent/src/core/debug.js");
			assert.equal(fresh.isDebugEnabled(undefined, {}), expected, `ATOMIC_DEBUG_SETTING=${inherited}`);
		}
	});

	test("the pooled-watch variable also takes a trace file path, while the others need exactly 1", () => {
		assert.equal(isDebugEnabled("pooled-watch", { ATOMIC_DEBUG_POOLED_WATCH: "/tmp/trace.jsonl" }), true);
		assert.equal(isDebugEnabled("workflow", { ATOMIC_WORKFLOW_DEBUG: "yes" }), false);
		assert.equal(isDebugEnabled("model-routing", { ATOMIC_MODEL_ROUTING_DEBUG: "true" }), false);
	});

	test("reads process.env at call time, so a variable set later counts", () => {
		assert.equal(isDebugEnabled("workflow"), false);
		vi.stubEnv("ATOMIC_WORKFLOW_DEBUG", "1");
		assert.equal(isDebugEnabled("workflow"), true);
		vi.stubEnv("ATOMIC_DEBUG", "1");
		assert.equal(isDebugEnabled(), true);
	});
});

describe("the debug setting (#4360)", () => {
	test("notifies each subscriber once per change until it unsubscribes", () => {
		const seen: boolean[] = [];
		const stop = onDebugSettingChange((enabled) => seen.push(enabled));
		setDebugSetting(true);
		setDebugSetting(true);
		setDebugSetting(false);
		stop();
		setDebugSetting(true);
		assert.deepEqual(seen, [true, false]);
	});

	test("refuses anything but a boolean as a typed error, changing nothing", () => {
		const seen: boolean[] = [];
		const stop = onDebugSettingChange((enabled) => seen.push(enabled));
		try {
			for (const [value, received] of [
				["false", "string"],
				[1, "number"],
				[null, "null"],
				[undefined, "undefined"],
			] as const) {
				assert.throws(
					() => setDebugSetting(value as unknown as boolean),
					(error: unknown) =>
						error instanceof DebugConfigError &&
						isDebugConfigError(error) &&
						error.code === "invalid-setting" &&
						error.source === "sdk" &&
						error.field === "enabled" &&
						error.received === received &&
						error.retryable === false &&
						error.hint === "Pass true or false.",
				);
				assert.equal(isDebugEnabled(undefined, {}), false);
				assert.equal(createChildProcessEnvironment(undefined, {}).ATOMIC_DEBUG_SETTING, "0");
			}
			assert.throws(
				() => setDebugSetting("true" as unknown as boolean, "rpc"),
				(error: unknown) => isDebugConfigError(error) && error.source === "rpc",
			);
			assert.deepEqual(seen, [], "no subscriber hears a refused value");
		} finally {
			stop();
		}
	});

	test("reaches every child process environment, on or off, whatever the base environment held", () => {
		const inherited = { PATH: "/bin", ATOMIC_DEBUG_SETTING: "1" };
		assert.equal(createChildProcessEnvironment(undefined, inherited).ATOMIC_DEBUG_SETTING, "0");
		assert.equal(inherited.ATOMIC_DEBUG_SETTING, "1", "the base is not changed");
		setDebugSetting(true);
		const child = createChildProcessEnvironment({ ATOMIC_DEBUG_SETTING: "0" }, { PATH: "/bin" });
		assert.equal(child.ATOMIC_DEBUG_SETTING, "1");
		assert.equal(child.PATH, "/bin");
		assert.equal(child.AI_AGENT, "atomic");
	});

	test("reaches pool workers with the durable journal they read", () => {
		const durable = { selection: '{"kind":"sqlite","path":"/j.sqlite"}', agentDir: "/agent" };
		setDebugSetting(true);
		const env = poolWorkerEnvironment(durable);
		assert.equal(env[POOL_DURABLE_JOURNAL_ENV], JSON.stringify(durable));
		assert.equal(env.ATOMIC_DEBUG_SETTING, "1");
		assert.equal(POOL_DURABLE_JOURNAL_ENV in poolWorkerEnvironment(undefined), false);
	});

	test("reaches the Intercom broker through the environment it starts with", () => {
		assert.equal(getBrokerSpawnOptions("/extension").env.ATOMIC_DEBUG_SETTING, "0");
		setDebugSetting(true);
		assert.equal(getBrokerSpawnOptions("/extension").env.ATOMIC_DEBUG_SETTING, "1");
	});

	test("a child process started with that environment is in debug mode, and one started after it is off is not", {
		timeout: 60_000,
	}, () => {
		const script = `import { isDebugEnabled } from ${JSON.stringify(join(process.cwd(), "packages/coding-agent/src/core/debug.ts"))};
process.stdout.write(String(isDebugEnabled("workflow")) + "|" + String(isDebugEnabled()));`;
		const probe = () => {
			const result = spawnSyncCollect([bunExecutable(), "-e", script], {
				env: createChildProcessEnvironment(undefined, { ...process.env, ATOMIC_DEBUG: undefined }),
			});
			assert.equal(result.exitCode, 0, result.stderr.toString());
			return result.stdout.toString();
		};
		setDebugSetting(true);
		assert.equal(probe(), "true|true");
		setDebugSetting(false);
		assert.equal(probe(), "false|false");
	});
});

describe("reportDebug (#4360)", () => {
	test("writes nothing anywhere while every source is off", async () => {
		await withDebugLog("off", (log) => {
			const own = vi.fn();
			for (const area of AREAS) reportDebug(area, "probe", { value: 1 }, own);
			assert.equal(own.mock.calls.length, 0);
			assert.equal(log.exists(), false);
		});
	});

	test.each(DEBUG_MODE_SOURCES)(
		"in debug mode from %s, appends one JSON line per event to the debug log",
		async (source) => {
			await withDebugLog(source, (log) => {
				const own = vi.fn();
				const before = Date.now();
				reportDebug(
					"pool",
					"coordination",
					{ root: "r1", count: 3, ok: true, none: null, gone: undefined, ids: ["a", 2] },
					own,
				);
				reportDebug("workflow", "second", {});
				assert.equal(own.mock.calls.length, 0, "the area variable is not set");
				const records = log.records();
				assert.deepEqual(
					records.map(({ area, event, data }) => ({ area, event, data })),
					[
						{
							area: "pool",
							event: "coordination",
							data: { root: "r1", count: 3, ok: true, none: null, ids: ["a", 2] },
						},
						{ area: "workflow", event: "second", data: {} },
					],
				);
				assert.equal(records[0]?.pid, process.pid);
				assert.ok(Date.parse(records[0]!.at) >= before - 1_000);
			});
		},
	);

	test("an area's own variable keeps its own output and does not write the debug log", async () => {
		await withDebugLog("off", (log) => {
			vi.stubEnv("ATOMIC_WORKFLOW_DEBUG", "1");
			const own = vi.fn();
			reportDebug("workflow", "event", { value: 1 }, own);
			reportDebug("model-routing", "event", { value: 1 }, own);
			assert.equal(own.mock.calls.length, 1, "only the area whose variable is set");
			assert.equal(log.exists(), false);
		});
	});

	test("with both on, the event reaches the debug log and the area's own output", async () => {
		await withDebugLog("setting", (log) => {
			vi.stubEnv("ATOMIC_MODEL_ROUTING_DEBUG", "1");
			const own = vi.fn();
			reportDebug("model-routing", "event", { value: 1 }, own);
			reportDebug("model-routing", "without-own-output", {});
			assert.equal(own.mock.calls.length, 1);
			assert.deepEqual(
				areaRecords(log, "model-routing").map((record) => record.event),
				["event", "without-own-output"],
			);
		});
	});

	test("redacts credentials and bounds long text, never adding to what the caller passed", async () => {
		await withDebugLog("setting", (log) => {
			const token = `sk-${"a".repeat(30)}`;
			reportDebug("workflow", "redacted", {
				message: `send failed: Authorization: Bearer ${token}`,
				ids: [`api_key=${token}`, 7],
				long: "x".repeat(5_000),
				limit: "y".repeat(2_000),
				short: "kept as is",
			});
			const [record] = areaRecords(log, "workflow");
			assert.ok(record);
			const text = JSON.stringify(record);
			assert.equal(text.includes(token), false, text);
			assert.equal(record.data.short, "kept as is");
			assert.deepEqual(record.data.ids, ["api_key= [redacted]", 7]);
			assert.equal(record.data.long, `${"x".repeat(2_000)}…`);
			assert.equal(record.data.limit, "y".repeat(2_000), "text at the limit is kept whole");
			assert.equal(record.data.message, "send failed: Authorization: [redacted]");
		});
	});

	test("redacts GitHub tokens and private key blocks, and leaves look-alikes alone", async () => {
		await withDebugLog("setting", (log) => {
			const body = "A1b2C3d4E5f6G7h8I9j0";
			const cases: Record<string, readonly [string, string]> = {
				ghp: [`push rejected ${`ghp_${body}`}, try again`, "push rejected [redacted], try again"],
				gho: [`gho_${body}xyz`, "[redacted]"],
				ghu: [`ghu_${body}`, "[redacted]"],
				ghs: [`ghs_${body}`, "[redacted]"],
				ghr: [`ghr_${body}`, "[redacted]"],
				fineGrained: [`github_pat_${body}_k9`, "[redacted]"],
				shortClassic: [`ghp_${body.slice(1)}`, `ghp_${body.slice(1)}`],
				shortFineGrained: [`github_pat_${body.slice(1)}`, `github_pat_${body.slice(1)}`],
				otherPrefix: [`ghx_${body}`, `ghx_${body}`],
				inWord: [`xghp_${body}`, `xghp_${body}`],
				keyBlock: [
					"before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nafter",
					"before\n[redacted]\nafter",
				],
				plainKeyBlock: ["-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY----- tail", "[redacted] tail"],
				cutKeyBlock: ["seen -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA", "seen [redacted]"],
				labelledKeyBlock: [
					"key:\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----",
					"key: [redacted]",
				],
				publicKey: [
					"-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----",
					"-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----",
				],
			};
			reportDebug(
				"workflow",
				"shapes",
				Object.fromEntries(Object.entries(cases).map(([key, [input]]) => [key, input])),
			);
			const [record] = areaRecords(log, "workflow");
			assert.deepEqual(
				record?.data,
				Object.fromEntries(Object.entries(cases).map(([key, [, output]]) => [key, output])),
			);
		});
	});

	test("creates the agent directory when it does not exist yet", async () => {
		await withDebugLog("setting", (log) => {
			const nested = join(log.agentDir, "not", "yet");
			vi.stubEnv("ATOMIC_CODING_AGENT_DIR", nested);
			reportDebug("pool", "created", {});
			assert.equal(existsSync(join(nested, "atomic-debug.log")), true);
		});
	});

	test("appendDebugRecord writes one redacted line to the file it is given", () => {
		const directory = makeTempDirectory("atomic-debug-record-");
		try {
			const path = join(directory, "deeper", "trace.jsonl");
			appendDebugRecord(path, { step: "one", secret: `token=${"b".repeat(20)}` });
			appendDebugRecord(path, { step: "two" });
			const lines = readFileSync(path, "utf8")
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.deepEqual(lines, [{ step: "one", secret: "token= [redacted]" }, { step: "two" }]);
		} finally {
			removeTempDirectory(directory);
		}
	});
});

describe("model routing area (#4360)", () => {
	test("prints to stderr for its own variable and writes the debug log in debug mode", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await withDebugLog("off", (log) => {
			reportModelRoutingDebug("off message");
			vi.stubEnv("ATOMIC_MODEL_ROUTING_DEBUG", "1");
			reportModelRoutingDebug("own message");
			assert.equal(log.exists(), false);
		});
		assert.deepEqual(warn.mock.calls, [["own message"]]);
		for (const source of DEBUG_MODE_SOURCES)
			await withDebugLog(source, (log) => {
				reportModelRoutingDebug(`fallback from ${source}`);
				assert.deepEqual(areaRecords(log, "model-routing"), [
					{ event: "routing", data: { message: `fallback from ${source}` } },
				]);
			});
		assert.equal(warn.mock.calls.length, 1, "debug mode alone prints nothing");
		await withDebugLog("off", (log) => {
			reportModelRoutingDebug("injected", { ATOMIC_MODEL_ROUTING_DEBUG: "1" });
			assert.equal(log.exists(), false);
		});
		assert.deepEqual(warn.mock.calls[1], ["injected"], "the environment it is given decides");
	});
});

describe("pooled-watch area (#4360)", () => {
	test("its own variable traces next to the pool journal, or to the file it names, as before", async () => {
		await withDebugLog("off", (log) => {
			const journal = join(log.agentDir, "pool", "journal.sqlite");
			configurePooledWatchTrace(journal, "coordinator");
			tracePooledWatch("before", { key: "k0" });
			assert.equal(existsSync(join(log.agentDir, "pool", "pooled-watch-trace.jsonl")), false);
			vi.stubEnv("ATOMIC_DEBUG_POOLED_WATCH", "1");
			tracePooledWatch("coordinator.watch.open", { watch: "w1", worker: 3 });
			const beside = readFileSync(join(log.agentDir, "pool", "pooled-watch-trace.jsonl"), "utf8")
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.equal(beside.length, 1);
			assert.equal(beside[0].pid, process.pid);
			assert.equal(typeof beside[0].at, "string");
			assert.deepEqual(
				{ role: beside[0].role, step: beside[0].step, watch: beside[0].watch, worker: beside[0].worker },
				{ role: "coordinator", step: "coordinator.watch.open", watch: "w1", worker: 3 },
			);
			const named = join(log.agentDir, "named-trace.jsonl");
			vi.stubEnv("ATOMIC_DEBUG_POOLED_WATCH", named);
			tracePooledWatch("root.reconnect.start", { key: "k1" });
			assert.equal(JSON.parse(readFileSync(named, "utf8")).step, "root.reconnect.start");
			assert.equal(log.exists(), false, "the area variable does not write the debug log");
		});
	});

	test("before a process knows its pool journal, its own variable traces nothing", async () => {
		await withDebugLog("off", async (log) => {
			vi.stubEnv("ATOMIC_DEBUG_POOLED_WATCH", "1");
			vi.resetModules();
			const fresh = await import("../../packages/workflows/src/workers/pooled-watch-trace.js");
			fresh.tracePooledWatch("root.reconnect.start", { key: "k" });
			assert.equal(log.exists(), false);
		});
	});

	test.each(DEBUG_MODE_SOURCES)("debug mode from %s traces to the debug log with the process role", async (source) => {
		await withDebugLog(source, (log) => {
			configurePooledWatchTrace(join(log.agentDir, "journal.sqlite"), "worker:7");
			tracePooledWatch("worker.watch.opened", { watch: "w2", event: "turn" });
			assert.deepEqual(areaRecords(log, "pooled-watch"), [
				{ event: "worker.watch.opened", data: { role: "worker:7", watch: "w2", event: "turn" } },
			]);
			assert.equal(existsSync(join(log.agentDir, "pooled-watch-trace.jsonl")), false);
		});
	});
});

describe("pool area (#4360)", () => {
	const stats: PoolCoordinationStats = {
		since: 0,
		requests: { heartbeat: { count: 4, perSecond: 2 } },
		writes: { heartbeat: { count: 4, perSecond: 2 } },
	};

	test("the pool line is hidden unless debug mode is on", async () => {
		assert.equal(poolCoordinationLine({ coordination: stats }), undefined);
		assert.equal(poolCoordinationLine(undefined), undefined);
		for (const source of DEBUG_MODE_SOURCES)
			await withDebugLog(source, () => {
				assert.equal(
					poolCoordinationLine({ coordination: stats }),
					"pool: requests 2.0/s (heartbeat 2.0) · writes 2.0/s (heartbeat 2.0)",
				);
				assert.equal(poolCoordinationLine(undefined), undefined, "a run without a pool");
			});
	});
});

describe("debug log failures (#4360)", () => {
	test("an unwritable debug log is recorded once as a typed error and never thrown", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await withDebugLog("setting", async (log) => {
			const blocker = join(log.agentDir, "file");
			writeFileSync(blocker, "");
			vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(blocker, "agent"));
			assert.equal(getDebugLogFailure(), undefined);
			reportDebug("pool", "first", {});
			reportDebug("pool", "second", {});
			const failure = getDebugLogFailure();
			assert.ok(failure instanceof DebugLogUnwritableError);
			assert.ok(failure instanceof DebugError);
			assert.equal(failure.name, "DebugLogUnwritableError");
			assert.equal(failure.code, "debug-log-unwritable");
			assert.equal(failure.path, join(blocker, "agent", "atomic-debug.log"));
			assert.equal(failure.retryable, false);
			assert.equal(failure.hint, `Make ${join(blocker, "agent")} writable, or turn debug mode off.`);
			assert.ok(failure.cause instanceof Error);
			assert.equal(
				failure.message,
				`Debug log is not writable: ${join(blocker, "agent", "atomic-debug.log")} (debug-log-unwritable). ${failure.hint}`,
			);
			assert.deepEqual(warn.mock.calls, [[failure.message]], "reported once");
		});
	});

	test("every debug error survives a round trip across a process boundary as the same class", () => {
		const through = (error: DebugError) =>
			rehydrateDebugError(JSON.parse(JSON.stringify(serializeDebugError(error))));
		const unwritable = through(
			new DebugLogUnwritableError("/logs/atomic-debug.log", { cause: new TypeError("EACCES") }),
		);
		assert.ok(unwritable instanceof DebugLogUnwritableError);
		assert.equal(isDebugLogUnwritableError(unwritable), true);
		assert.deepEqual(
			{ code: unwritable.code, path: unwritable.path, hint: unwritable.hint, retryable: unwritable.retryable },
			{
				code: "debug-log-unwritable",
				path: "/logs/atomic-debug.log",
				hint: "Make /logs writable, or turn debug mode off.",
				retryable: false,
			},
		);
		assert.ok(unwritable.cause instanceof Error);
		assert.deepEqual(
			{ name: unwritable.cause.name, message: unwritable.cause.message },
			{ name: "TypeError", message: "EACCES" },
		);
		const config = through(new DebugConfigError({ source: "rpc", received: "string" }));
		assert.ok(config instanceof DebugConfigError);
		assert.equal(isDebugConfigError(config), true);
		assert.deepEqual(
			{
				code: config.code,
				source: config.source,
				field: config.field,
				received: config.received,
				hint: config.hint,
			},
			{ code: "invalid-setting", source: "rpc", field: "enabled", received: "string", hint: "Pass true or false." },
		);
		assert.deepEqual(config.fields(), { source: "rpc", field: "enabled", received: "string" });
		assert.equal(config.cause, undefined);
		assert.deepEqual(new DebugError("invalid-setting", "m", "h").fields(), {});
		const plainCause = through(new DebugLogUnwritableError("/x/log", { cause: "disk gone" }));
		assert.deepEqual(
			{ name: (plainCause.cause as Error).name, message: (plainCause.cause as Error).message },
			{ name: "Error", message: "disk gone" },
		);
	});

	test("an unknown debug error arrives as the family base with its name, code, fields and retryability kept", () => {
		const foreign = rehydrateDebugError({
			name: "DebugQuotaError",
			code: "quota",
			message: "Quota (quota). Wait.",
			hint: "Wait.",
			retryable: true,
			fields: { limit: "3" },
			cause: {
				name: "DebugLogUnwritableError",
				code: "debug-log-unwritable",
				message: "m",
				hint: "h",
				retryable: false,
				fields: { path: "/a/b" },
			},
		});
		assert.ok(foreign instanceof DebugError);
		assert.equal(isDebugError(foreign), true);
		assert.deepEqual(
			{
				name: foreign.name,
				code: foreign.code,
				message: foreign.message,
				hint: foreign.hint,
				retryable: foreign.retryable,
			},
			{ name: "DebugQuotaError", code: "quota", message: "Quota (quota). Wait.", hint: "Wait.", retryable: true },
		);
		assert.deepEqual(foreign.fields(), { limit: "3" });
		assert.ok(foreign.cause instanceof DebugLogUnwritableError);
		for (const [name, fields] of [
			["DebugLogUnwritableError", {}],
			["DebugConfigError", { source: "cli", received: "string" }],
			["DebugConfigError", { source: "rpc" }],
		] as const) {
			const malformed = rehydrateDebugError({ name, code: "x", message: "m", hint: "h", retryable: false, fields });
			assert.equal(
				malformed instanceof DebugLogUnwritableError || malformed instanceof DebugConfigError,
				false,
				name,
			);
			assert.equal(malformed.name, name, "kept as the family base");
		}
		assert.ok(
			rehydrateDebugError({
				name: "DebugConfigError",
				code: "invalid-setting",
				message: "m",
				hint: "h",
				retryable: false,
				fields: { source: "sdk", received: "number" },
			}) instanceof DebugConfigError,
		);
	});

	test("a serialized cause chain stops after eight errors", () => {
		let error = new DebugLogUnwritableError("/0/log");
		for (let index = 1; index < 12; index += 1)
			error = new DebugLogUnwritableError(`/${index}/log`, { cause: error });
		let serialized: SerializedDebugError | undefined = serializeDebugError(error);
		let depth = 0;
		while (serialized !== undefined) {
			depth += 1;
			serialized = serialized.cause as SerializedDebugError | undefined;
		}
		assert.equal(depth, 8);
		let rehydrated: unknown = rehydrateDebugError(serializeDebugError(error));
		let count = 0;
		while (rehydrated instanceof DebugLogUnwritableError) {
			count += 1;
			rehydrated = rehydrated.cause;
		}
		assert.equal(count, 8);
	});

	test("guards match by class and, across a process boundary, by name and code", () => {
		const error = new DebugLogUnwritableError("/x/atomic-debug.log");
		assert.equal(isDebugError(error), true);
		assert.equal(isDebugLogUnwritableError(error), true);
		const family = new DebugError("debug-log-unwritable", "m", "h");
		assert.equal(family.name, "DebugError");
		assert.equal(family.retryable, false);
		assert.equal(family.hint, "h");
		assert.equal(isDebugError(family), true);
		assert.equal(isDebugLogUnwritableError(family), false);
		const crossed = JSON.parse(JSON.stringify({ name: error.name, code: error.code, path: error.path }));
		assert.equal(isDebugError(crossed), true);
		assert.equal(isDebugLogUnwritableError(crossed), true);
		assert.equal(isDebugConfigError(crossed), false);
		const config = new DebugConfigError({ source: "rpc", received: "string" });
		assert.equal(
			config.message,
			"Invalid debug setting: enabled is string, not a boolean (invalid-setting). Pass true or false.",
		);
		assert.equal(isDebugError(config), true);
		assert.equal(isDebugLogUnwritableError(config), false);
		const crossedConfig = JSON.parse(JSON.stringify({ name: config.name, code: config.code, source: config.source }));
		assert.equal(isDebugError(crossedConfig), true);
		assert.equal(isDebugConfigError(crossedConfig), true);
		assert.equal(isDebugConfigError({ name: "DebugConfigError", code: "debug-log-unwritable" }), false);
		assert.equal(isDebugError({ name: "DebugError", code: "anything" }), true);
		assert.equal(isDebugLogUnwritableError({ name: "DebugLogUnwritableError", code: "other" }), false);
		assert.equal(isDebugError({ name: "DebugError", code: 1 }), false);
		assert.equal(isDebugError({ name: "StorageError", code: "debug-log-unwritable" }), false);
		for (const value of [null, undefined, "DebugError", 1]) {
			assert.equal(isDebugError(value), false);
			assert.equal(isDebugLogUnwritableError(value), false);
			assert.equal(isDebugConfigError(value), false);
		}
	});
});
