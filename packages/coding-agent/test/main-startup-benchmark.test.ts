import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import type { SerializedTypedError } from "../src/core/error-contract.js";
import { isStdoutTakenOver, restoreStdout } from "../src/core/output-guard.js";
import { main } from "../src/main.js";
import type { AppMode } from "../src/main-app-mode.js";
import {
	isStartupBenchmarkConfigError,
	isStartupBenchmarkError,
	measureInteractiveStartup,
	rehydrateStartupBenchmarkError,
	resolveStartupBenchmark,
	StartupBenchmarkConfigError,
	StartupBenchmarkError,
	type StartupBenchmarkUnsupportedMode,
	startupBenchmarkEngineEnv,
} from "../src/main-startup-benchmark.js";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import { createRpcClientProcessEnvironment } from "../src/modes/rpc/rpc-client-process.js";

const APP_MODES: readonly AppMode[] = ["interactive", "print", "json", "rpc"];
const UNSUPPORTED_MODES: readonly StartupBenchmarkUnsupportedMode[] = ["print", "json", "rpc"];
const HOST = { child: undefined };
const ENGINE_CHILD = { child: "1" };

function assertConfigError(error: Error, appMode: StartupBenchmarkUnsupportedMode): StartupBenchmarkConfigError {
	assert.ok(error instanceof StartupBenchmarkConfigError);
	assert.ok(error instanceof StartupBenchmarkError);
	assert.ok(isStartupBenchmarkConfigError(error));
	assert.ok(isStartupBenchmarkError(error));
	assert.equal(error.name, "StartupBenchmarkConfigError");
	assert.equal(error.code, "unsupported-mode");
	assert.equal(error.source, "env");
	assert.equal(error.field, "ATOMIC_STARTUP_BENCHMARK");
	assert.equal(error.appMode, appMode);
	assert.equal(error.retryable, false);
	assert.equal(Object.hasOwn(error, "cause"), false);
	assert.deepEqual(error.fields, { source: "env", field: "ATOMIC_STARTUP_BENCHMARK", appMode });
	return error;
}

function recordingStartup(calls: string[], dispose: () => Promise<void> = async () => void calls.push("dispose")) {
	const mode = {
		init: async () => void calls.push("init"),
		ensureDeferredStartupComplete: async () => void calls.push("ensureDeferredStartupComplete"),
		stop: () => void calls.push("stop"),
	};
	const timings = {
		time: (label: string) => void calls.push(`time:${label}`),
		printTimings: () => void calls.push("printTimings"),
	};
	const inProcessRuntime = { dispose };
	const isolatedRuntime = (waitUntilResourcesReady: () => Promise<void>): IsolatedInteractiveRuntime =>
		Object.assign(Object.create(IsolatedInteractiveRuntime.prototype), { waitUntilResourcesReady, dispose });
	return { mode, timings, inProcessRuntime, isolatedRuntime };
}

describe("measureInteractiveStartup", () => {
	test("an in-process session leaves the TUI, prints the timings once, then disposes the runtime", async () => {
		const calls: string[] = [];
		const { mode, timings, inProcessRuntime } = recordingStartup(calls);
		await measureInteractiveStartup(mode, inProcessRuntime, timings);
		assert.deepEqual(calls, [
			"init",
			"time:interactiveMode.init",
			"ensureDeferredStartupComplete",
			"stop",
			"printTimings",
			"dispose",
		]);
	});

	test("the isolated host waits for the engine's resources and prints after leaving the TUI (#4354)", async () => {
		const calls: string[] = [];
		const { mode, timings, isolatedRuntime } = recordingStartup(calls);
		const runtime = isolatedRuntime(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			calls.push("waitUntilResourcesReady");
		});
		await measureInteractiveStartup(mode, runtime, timings);
		assert.deepEqual(calls, [
			"init",
			"time:interactiveMode.init",
			"ensureDeferredStartupComplete",
			"waitUntilResourcesReady",
			"time:interactiveEngine.resourcesReady",
			"stop",
			"printTimings",
			"dispose",
		]);
	});

	test("records into the process startup timings by default", async () => {
		const calls: string[] = [];
		const { mode, inProcessRuntime } = recordingStartup(calls);
		await measureInteractiveStartup(mode, inProcessRuntime);
		assert.deepEqual(calls, ["init", "ensureDeferredStartupComplete", "stop", "dispose"]);
	});

	test("a failed startup still ends the session and rethrows its own error without printing", async () => {
		const calls: string[] = [];
		const { mode, timings, isolatedRuntime } = recordingStartup(calls);
		const failure = new Error("engine resources failed");
		const runtime = isolatedRuntime(() => Promise.reject(failure));
		await assert.rejects(measureInteractiveStartup(mode, runtime, timings), (error: Error) => error === failure);
		assert.deepEqual(calls, [
			"init",
			"time:interactiveMode.init",
			"ensureDeferredStartupComplete",
			"stop",
			"dispose",
		]);
		assert.equal("cleanupCause" in failure, false);
	});

	test("a teardown failure after a failed startup is attached to the startup error, not thrown instead", async () => {
		const calls: string[] = [];
		const teardownFailure = new Error("engine did not stop");
		const { mode, timings, isolatedRuntime } = recordingStartup(calls, () => Promise.reject(teardownFailure));
		const failure = new Error("engine resources failed");
		await assert.rejects(
			measureInteractiveStartup(
				mode,
				isolatedRuntime(() => Promise.reject(failure)),
				timings,
			),
			(error: Error) => error === failure,
		);
		assert.equal((failure as Error & { cleanupCause?: Error }).cleanupCause, teardownFailure);
		assert.equal(calls.includes("stop"), true);
		assert.equal(calls.includes("printTimings"), false);
	});

	test("a non-Error startup failure keeps both failures when the teardown fails too", async () => {
		const teardownFailure = new Error("engine did not stop");
		const { mode, timings, isolatedRuntime } = recordingStartup([], () => Promise.reject(teardownFailure));
		const nonErrorFailure = () => Promise.reject("resources failed");
		await assert.rejects(
			measureInteractiveStartup(mode, isolatedRuntime(nonErrorFailure), timings),
			(error: Error) => {
				assert.ok(error instanceof AggregateError);
				assert.deepEqual(error.errors, ["resources failed", teardownFailure]);
				assert.equal(error.message, "Startup benchmark failed, and so did its teardown");
				return true;
			},
		);
		const { mode: quietMode, isolatedRuntime: quietRuntime } = recordingStartup([]);
		await assert.rejects(
			measureInteractiveStartup(quietMode, quietRuntime(nonErrorFailure), timings),
			(error: string) => error === "resources failed",
		);
	});
});

describe("startupBenchmarkEngineEnv", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("the engine of a benchmarking host gets timing switched off, so only the host prints (#4354)", () => {
		for (const value of ["1", "true", "yes"]) {
			assert.deepEqual(startupBenchmarkEngineEnv(value), { ATOMIC_TIMING: "0" }, value);
			const engineEnv = createRpcClientProcessEnvironment(startupBenchmarkEngineEnv(value), { ATOMIC_TIMING: "1" });
			assert.equal(engineEnv.ATOMIC_TIMING, "0");
		}
		for (const value of ["", "0", "false", "no"]) assert.deepEqual(startupBenchmarkEngineEnv(value), {}, value);
	});

	test("reads ATOMIC_STARTUP_BENCHMARK when no value is passed", () => {
		vi.stubEnv("ATOMIC_STARTUP_BENCHMARK", "1");
		assert.deepEqual(startupBenchmarkEngineEnv(), { ATOMIC_TIMING: "0" });
		vi.stubEnv("ATOMIC_STARTUP_BENCHMARK", "0");
		assert.deepEqual(startupBenchmarkEngineEnv(), {});
	});
});

describe("resolveStartupBenchmark", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("an isolated engine child ignores an inherited ATOMIC_STARTUP_BENCHMARK in every mode (#4354)", () => {
		for (const appMode of APP_MODES) {
			for (const value of ["1", "true", "yes"]) {
				assert.equal(resolveStartupBenchmark(appMode, ENGINE_CHILD, value), false, `${appMode} ${value}`);
			}
		}
	});

	test("the interactive host runs the benchmark only for a truthy flag", () => {
		for (const value of ["1", "true", "TRUE", "yes", "Yes"]) {
			assert.equal(resolveStartupBenchmark("interactive", HOST, value), true, value);
		}
		for (const value of [undefined, "", "0", "false", "no", "on"]) {
			assert.equal(resolveStartupBenchmark("interactive", HOST, value), false, String(value));
		}
	});

	test("reads ATOMIC_STARTUP_BENCHMARK when no value is passed", () => {
		vi.stubEnv("ATOMIC_STARTUP_BENCHMARK", "1");
		assert.equal(resolveStartupBenchmark("interactive", HOST), true);
		vi.stubEnv("ATOMIC_STARTUP_BENCHMARK", "0");
		assert.equal(resolveStartupBenchmark("interactive", HOST), false);
	});

	test("a disabled flag is not an error outside interactive mode", () => {
		for (const appMode of UNSUPPORTED_MODES) {
			assert.equal(resolveStartupBenchmark(appMode, HOST, "0"), false);
			assert.equal(resolveStartupBenchmark(appMode, HOST, undefined), false);
		}
	});

	test("the benchmark in print, JSON or standalone RPC mode is a typed config error", () => {
		for (const appMode of UNSUPPORTED_MODES) {
			assert.throws(
				() => resolveStartupBenchmark(appMode, HOST, "1"),
				(error: Error) => {
					assertConfigError(error, appMode);
					return true;
				},
			);
		}
	});
});

describe("StartupBenchmarkError", () => {
	test("renders what failed, the code and what to do next", () => {
		const error = new StartupBenchmarkConfigError({ appMode: "print" });
		const hint =
			"ATOMIC_STARTUP_BENCHMARK measures interactive startup only. Unset it, or start atomic in a terminal without --print, --mode or piped input.";
		assert.equal(error.hint, hint);
		assert.equal(
			error.message,
			`Invalid startup benchmark configuration: ATOMIC_STARTUP_BENCHMARK in print mode (unsupported-mode). ${hint}`,
		);
	});

	test("serializes and rehydrates into the same class with its fields", () => {
		for (const appMode of UNSUPPORTED_MODES) {
			const original = new StartupBenchmarkConfigError({ appMode });
			const serialized = JSON.parse(JSON.stringify(original)) as SerializedTypedError;
			assert.deepEqual(serialized, {
				name: "StartupBenchmarkConfigError",
				code: "unsupported-mode",
				message: original.message,
				hint: original.hint,
				retryable: false,
				fields: { source: "env", field: "ATOMIC_STARTUP_BENCHMARK", appMode },
			});
			const rehydrated = assertConfigError(rehydrateStartupBenchmarkError(serialized), appMode);
			assert.equal(rehydrated.message, original.message);
			assert.equal(rehydrated.hint, original.hint);
		}
		const legacyName = rehydrateStartupBenchmarkError(
			new StartupBenchmarkConfigError({ appMode: "rpc", field: "PI_STARTUP_BENCHMARK" }).toJSON(),
		);
		assert.ok(isStartupBenchmarkConfigError(legacyName));
		assert.equal(legacyName.field, "PI_STARTUP_BENCHMARK");
	});

	test("an unknown name or malformed fields rehydrate into the family base with name, code and cause kept", () => {
		const config = new StartupBenchmarkConfigError({ appMode: "json" }).toJSON();
		const cases: SerializedTypedError[] = [
			{
				name: "StartupBenchmarkFutureError",
				code: "unsupported-mode",
				message: "future failure",
				retryable: true,
				fields: {},
				cause: { name: "TypeError", message: "inner", code: "inner-code" },
			},
			{ ...config, name: "StartupBenchmarkError" },
			{ ...config, fields: { ...config.fields, appMode: "interactive" } },
			{ ...config, fields: { ...config.fields, appMode: 3 } },
			{ ...config, fields: { source: "env", appMode: "json" } },
			{ ...config, fields: { source: "env", field: "ATOMIC_STARTUP_BENCHMARK" } },
		];
		for (const serialized of cases) {
			const error = rehydrateStartupBenchmarkError(serialized);
			assert.equal(Object.getPrototypeOf(error), StartupBenchmarkError.prototype, serialized.name);
			assert.ok(isStartupBenchmarkError(error));
			assert.equal(error.name, serialized.name);
			assert.equal(error.code, serialized.code);
			assert.equal(error.message, serialized.message);
			assert.equal(error.hint, serialized.hint);
			assert.equal(error.retryable, serialized.retryable);
			assert.deepEqual(error.fields, {});
		}
		const future = rehydrateStartupBenchmarkError(cases[0]!);
		assert.equal(isStartupBenchmarkConfigError(future), false);
		assert.ok(future.cause instanceof Error);
		assert.equal(future.cause.name, "TypeError");
		assert.equal(future.cause.message, "inner");
		assert.deepEqual(future.toJSON(), {
			name: "StartupBenchmarkFutureError",
			code: "unsupported-mode",
			message: "future failure",
			retryable: true,
			fields: {},
			cause: { name: "TypeError", message: "inner", code: "inner-code" },
		});
	});

	test("the family base names itself and serializes without a hint or cause", () => {
		const base = new StartupBenchmarkError("Startup benchmark failed", {
			code: "unsupported-mode",
			retryable: false,
		});
		assert.equal(base.name, "StartupBenchmarkError");
		assert.ok(isStartupBenchmarkError(base));
		assert.equal(isStartupBenchmarkConfigError(base), false);
		assert.equal(Object.hasOwn(base, "cause"), false);
		assert.deepEqual(base.toJSON(), {
			name: "StartupBenchmarkError",
			code: "unsupported-mode",
			message: "Startup benchmark failed",
			retryable: false,
			fields: {},
		});
	});

	test("guards accept relayed errors by name and code and reject everything else", () => {
		const relayedConfig = { name: "StartupBenchmarkConfigError", code: "unsupported-mode" };
		const relayedFamily = { name: "StartupBenchmarkError", code: "unsupported-mode" };
		assert.ok(isStartupBenchmarkConfigError(relayedConfig));
		assert.ok(isStartupBenchmarkError(relayedConfig));
		assert.ok(isStartupBenchmarkError(relayedFamily));
		assert.equal(isStartupBenchmarkConfigError(relayedFamily), false);
		assert.ok(isStartupBenchmarkError(Object.create(StartupBenchmarkError.prototype)));
		assert.ok(isStartupBenchmarkConfigError(Object.create(StartupBenchmarkConfigError.prototype)));
		for (const other of [
			{ name: "StartupBenchmarkConfigError", code: "unsupported" },
			{ name: "StorageConfigError", code: "unsupported-mode" },
			new Error("ATOMIC_STARTUP_BENCHMARK only supports interactive mode"),
			"StartupBenchmarkConfigError",
			null,
			undefined,
		]) {
			assert.equal(isStartupBenchmarkError(other), false, String(other));
			assert.equal(isStartupBenchmarkConfigError(other), false, String(other));
		}
	});
});

describe("main with ATOMIC_STARTUP_BENCHMARK outside interactive mode", () => {
	afterEach(() => {
		restoreStdout();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	test("prints the typed error and exits 1 before taking over stdout (#4354)", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "atomic-startup-benchmark-"));
		try {
			vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
			vi.stubEnv("ATOMIC_STARTUP_BENCHMARK", "1");
			const cases: ReadonlyArray<readonly [StartupBenchmarkUnsupportedMode, string[]]> = [
				["print", ["--print", "hello"]],
				["json", ["--mode", "json", "hello"]],
				["rpc", ["--mode", "rpc"]],
			];
			for (const [appMode, args] of cases) {
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
				const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
					throw new Error(`process.exit(${code})`);
				}) as typeof process.exit);
				await assert.rejects(main(["--no-extensions", ...args]), { message: "process.exit(1)" });
				assert.deepEqual(exitSpy.mock.calls, [[1]]);
				assert.equal(isStdoutTakenOver(), false, appMode);
				const stderr = errorSpy.mock.calls.map(([line]) => String(line));
				assert.equal(stderr.length, 1, stderr.join("\n"));
				assert.ok(stderr[0]!.includes(`Error: ${new StartupBenchmarkConfigError({ appMode }).message}`), stderr[0]);
				vi.restoreAllMocks();
			}
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
