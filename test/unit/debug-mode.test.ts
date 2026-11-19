import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import { ENV_DEBUG, getEnvNames } from "../../packages/coding-agent/src/config.js";
import {
	appendDebugRecord,
	DEBUG_AREA_VARIABLES,
	type DebugArea,
	flushDebugLog,
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
} from "../../packages/coding-agent/src/core/debug-errors.js";
import {
	DEBUG_SETTING_ENV,
	inheritsDebugSetting,
	onDebugSettingChange,
	setDebugSetting,
} from "../../packages/coding-agent/src/core/debug-setting.js";
import { createChildProcessEnvironment } from "../../packages/coding-agent/src/utils/child-process.js";
import { getBrokerSpawnOptions } from "../../packages/intercom/broker/spawn.js";
import { DEBUG_ENV_VARS } from "../helpers/debug-env.js";
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
			decision: undefined,
			storage: undefined,
			engine: undefined,
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

	test("tests start with every variable that turns debug output on cleared", () => {
		const names = [
			...Object.values(DEBUG_AREA_VARIABLES).filter((name) => name !== undefined),
			DEBUG_SETTING_ENV,
			...getEnvNames(ENV_DEBUG),
		];
		assert.deepEqual(
			names.filter((name) => !DEBUG_ENV_VARS.includes(name)),
			[],
		);
	});

	test("retired workflow variables do not enable debug mode", () => {
		const env = { ATOMIC_WORKFLOW_DEBUG: "1", ATOMIC_DEBUG_POOLED_WATCH: "/tmp/trace.jsonl" };
		for (const area of AREAS) assert.equal(isDebugEnabled(area, env), false);
		assert.equal(isDebugEnabled(undefined, env), false);
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

	test("reads process.env at call time, so a variable set later counts", () => {
		assert.equal(isDebugEnabled(), false);
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

	test("a process knows whether its parent passed the setting down", () => {
		assert.equal(inheritsDebugSetting({ ATOMIC_DEBUG_SETTING: "1" }), true);
		assert.equal(inheritsDebugSetting({ ATOMIC_DEBUG_SETTING: "0" }), true);
		assert.equal(inheritsDebugSetting({}), false);
		vi.stubEnv("ATOMIC_DEBUG_SETTING", "0");
		assert.equal(inheritsDebugSetting(), true, "process.env by default");
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

	test("reaches the Intercom broker through the environment it starts with", () => {
		assert.equal(getBrokerSpawnOptions("/extension").env.ATOMIC_DEBUG_SETTING, "0");
		setDebugSetting(true);
		assert.equal(getBrokerSpawnOptions("/extension").env.ATOMIC_DEBUG_SETTING, "1");
	});

	const REAL_BUN_CHILD_PROBES_TIMEOUT_MS = 60_000;
	test("a child process started with that environment is in debug mode, and one started after it is off is not", {
		timeout: REAL_BUN_CHILD_PROBES_TIMEOUT_MS,
	}, () => {
		const script = `import { isDebugEnabled } from ${JSON.stringify(join(process.cwd(), "packages/coding-agent/src/core/debug.ts"))};
process.stdout.write(String(isDebugEnabled("storage")) + "|" + String(isDebugEnabled()));`;
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
		await withDebugLog("off", async (log) => {
			const own = vi.fn();
			for (const area of AREAS) reportDebug(area, "probe", { value: 1 }, own);
			assert.equal(own.mock.calls.length, 0);
			assert.equal(await log.exists(), false);
		});
	});

	test.each(DEBUG_MODE_SOURCES)(
		"in debug mode from %s, appends one JSON line per event to the debug log",
		async (source) => {
			await withDebugLog(source, async (log) => {
				const own = vi.fn();
				const before = Date.now();
				reportDebug(
					"storage",
					"probe",
					{ root: "r1", count: 3, ok: true, none: null, gone: undefined, ids: ["a", 2] },
					own,
				);
				reportDebug("engine", "second", {});
				assert.equal(own.mock.calls.length, 0, "the area variable is not set");
				const records = await log.records();
				assert.deepEqual(
					records.map(({ area, event, data }) => ({ area, event, data })),
					[
						{
							area: "storage",
							event: "probe",
							data: { root: "r1", count: 3, ok: true, none: null, ids: ["a", 2] },
						},
						{ area: "engine", event: "second", data: {} },
					],
				);
				assert.equal(records[0]?.pid, process.pid);
				assert.ok(Date.parse(records[0]!.at) >= before - 1_000);
			});
		},
	);

	test("redacts credentials and bounds long text, never adding to what the caller passed", async () => {
		await withDebugLog("setting", async (log) => {
			const token = `sk-${"a".repeat(30)}`;
			reportDebug("engine", "redacted", {
				message: `send failed: Authorization: Bearer ${token}`,
				ids: [`api_key=${token}`, 7],
				long: "x".repeat(5_000),
				limit: "y".repeat(2_000),
				short: "kept as is",
			});
			const [record] = await areaRecords(log, "engine");
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
		await withDebugLog("setting", async (log) => {
			const body = "A1b2C3d4E5f6G7h8I9j0";
			const privateKeyMarker = (boundary: "BEGIN" | "END", kind = "") =>
				`-----${boundary} ${kind ? `${kind} ` : ""}PRIVATE KEY-----`;
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
					`before\n${privateKeyMarker("BEGIN", "RSA")}\nMIIEowIBAAKCAQEA\n${privateKeyMarker("END", "RSA")}\nafter`,
					"before\n[redacted]\nafter",
				],
				plainKeyBlock: [`${privateKeyMarker("BEGIN")}\nMIIEvQ\n${privateKeyMarker("END")} tail`, "[redacted] tail"],
				cutKeyBlock: [`seen ${privateKeyMarker("BEGIN", "OPENSSH")}\nb3BlbnNzaC1rZXktdjEA`, "seen [redacted]"],
				labelledKeyBlock: [
					`key:\n${privateKeyMarker("BEGIN", "EC")}\nMHcCAQEE\n${privateKeyMarker("END", "EC")}`,
					// The whole block is redacted; its label keeps its own line, as no value runs past a line break (#5142).
					"key:\n[redacted]",
				],
				publicKey: [
					"-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----",
					"-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----",
				],
			};
			reportDebug(
				"engine",
				"shapes",
				Object.fromEntries(Object.entries(cases).map(([key, [input]]) => [key, input])),
			);
			const [record] = await areaRecords(log, "engine");
			assert.deepEqual(
				record?.data,
				Object.fromEntries(Object.entries(cases).map(([key, [, output]]) => [key, output])),
			);
		});
	});

	test("creates the agent directory when it does not exist yet", async () => {
		await withDebugLog("setting", async (log) => {
			const nested = join(log.agentDir, "not", "yet");
			vi.stubEnv("ATOMIC_CODING_AGENT_DIR", nested);
			reportDebug("storage", "created", {});
			await flushDebugLog();
			assert.equal(existsSync(join(nested, "atomic-debug.log")), true);
		});
	});

	test("appendDebugRecord writes one redacted line to the file it is given", async () => {
		const directory = makeTempDirectory("atomic-debug-record-");
		try {
			const path = join(directory, "deeper", "trace.jsonl");
			appendDebugRecord(path, { step: "one", secret: `token=${"b".repeat(20)}` });
			appendDebugRecord(path, { step: "two" });
			await flushDebugLog();
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

describe("decision area", () => {
	test("has no variable of its own and writes the debug log only in debug mode", async () => {
		const own = vi.fn();
		await withDebugLog("off", async (log) => {
			reportDebug("decision", "classifier-fallback", { message: "off" }, own);
			assert.equal(await log.exists(), false);
		});
		for (const source of DEBUG_MODE_SOURCES)
			await withDebugLog(source, async (log) => {
				reportDebug("decision", "classifier-fallback", { message: `from ${source}` }, own);
				assert.deepEqual(await areaRecords(log, "decision"), [
					{ event: "classifier-fallback", data: { message: `from ${source}` } },
				]);
			});
		assert.equal(own.mock.calls.length, 0, "nothing is printed");
	});
});

describe("debug log writes", () => {
	const EXITING_CHILD_TIMEOUT_MS = 60_000;
	test("writes every record when the process exits right after reporting it", {
		timeout: EXITING_CHILD_TIMEOUT_MS,
	}, () => {
		const agentDir = makeTempDirectory("atomic-debug-exit-");
		try {
			const script = `import { reportDebugAsync } from ${JSON.stringify(join(process.cwd(), "packages/coding-agent/src/core/debug.ts"))};
for (const event of ["first", "second", "third"]) void reportDebugAsync("storage", event, {});
process.exit(0);`;
			const result = spawnSyncCollect([bunExecutable(), "-e", script], {
				env: createChildProcessEnvironment(undefined, {
					...process.env,
					ATOMIC_DEBUG: "1",
					ATOMIC_CODING_AGENT_DIR: agentDir,
				}),
			});
			assert.equal(result.exitCode, 0, result.stderr.toString());
			const events = readFileSync(join(agentDir, "atomic-debug.log"), "utf8")
				.trimEnd()
				.split("\n")
				.map((line) => (JSON.parse(line) as { event: string }).event);
			assert.deepEqual(events, ["first", "second", "third"], "each once, in the order they were reported");
		} finally {
			removeTempDirectory(agentDir);
		}
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
			reportDebug("storage", "first", {});
			// The synchronous report writes before it returns, so its failure is recorded by then too.
			const failure = getDebugLogFailure();
			reportDebug("storage", "second", {});
			await flushDebugLog();
			assert.equal(getDebugLogFailure(), failure, "the first failure stays the one recorded");
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

	test("a synchronous report is in the debug log when it returns (#5377)", async () => {
		await withDebugLog("setting", async (log) => {
			reportDebug("storage", "landed-before-return", {});
			const written = readFileSync(join(log.agentDir, "atomic-debug.log"), "utf8");
			assert.match(written, /"event":"landed-before-return"/);
		});
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
