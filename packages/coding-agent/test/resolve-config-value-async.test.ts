import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	clearConfigValueCache,
	resolveConfigValue,
	resolveConfigValueAsync,
	resolveConfigValueUncachedAsync,
} from "../src/core/resolve-config-value.js";

describe("resolveConfigValueAsync", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-config-value-async-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		clearConfigValueCache();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	function countingCommand(name: string, exit = 0): { command: string; runs: () => string } {
		const counterFile = join(tempDir, name);
		writeFileSync(counterFile, "0");
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/[\\"]/g, "\\$&");
		return {
			command: `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; echo value; exit ${exit}'`,
			runs: () => readFileSync(counterFile, "utf-8").trim(),
		};
	}

	test("resolves commands and templates as the synchronous resolution does", async () => {
		process.env.TEST_CONFIG_ASYNC = "env-value";
		try {
			expect(await resolveConfigValueAsync("literal-key")).toBe("literal-key");
			expect(await resolveConfigValueAsync("$TEST_CONFIG_ASYNC")).toBe("env-value");
			expect(await resolveConfigValueAsync("!echo '  spaced-key  '")).toBe("spaced-key");
			expect(await resolveConfigValueAsync("!echo 'hello world' | tr ' ' '-'")).toBe("hello-world");
		} finally {
			delete process.env.TEST_CONFIG_ASYNC;
		}
	});

	test.each(["!exit 1", "!nonexistent-command-12345", "!printf ''"])(
		"returns undefined when command resolution fails: %s",
		async (command) => {
			expect(await resolveConfigValueAsync(command)).toBeUndefined();
		},
	);

	test("runs a command once for concurrent resolutions, and shares the cache with the synchronous one", async () => {
		const { command, runs } = countingCommand("concurrent");
		const values = await Promise.all([
			resolveConfigValueAsync(command),
			resolveConfigValueAsync(command),
			resolveConfigValueAsync(command),
		]);
		expect(values).toEqual(["value", "value", "value"]);
		expect(resolveConfigValue(command)).toBe("value");
		expect(runs()).toBe("1");

		const failing = countingCommand("failing", 1);
		expect(await resolveConfigValueAsync(failing.command)).toBeUndefined();
		expect(await resolveConfigValueAsync(failing.command)).toBeUndefined();
		expect(failing.runs()).toBe("1");
	});

	test("uncached resolution runs a command on every call", async () => {
		const { command, runs } = countingCommand("uncached");
		expect(await resolveConfigValueUncachedAsync(command)).toBe("value");
		expect(await resolveConfigValueUncachedAsync(command)).toBe("value");
		expect(runs()).toBe("2");
	});

	const PROBE_INTERVAL_MS = 5;
	const PROBE_SLEEP_SECONDS = 0.2;
	const MIN_PROBE_TICKS = 5;

	test.runIf(process.platform !== "win32")("keeps the event loop running while a command runs", async () => {
		let ticks = 0;
		const probe = setInterval(() => {
			ticks += 1;
		}, PROBE_INTERVAL_MS);
		try {
			expect(await resolveConfigValueAsync(`!sleep ${PROBE_SLEEP_SECONDS}; echo slow-value`)).toBe("slow-value");
		} finally {
			clearInterval(probe);
		}
		expect(ticks).toBeGreaterThanOrEqual(MIN_PROBE_TICKS);
	});
});
