import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	clearConfigValueCache,
	resolveConfigValue,
	resolveConfigValueAsync,
	resolveConfigValueOrThrow,
	resolveConfigValueOrThrowAsync,
	resolveConfigValueUncachedAsync,
} from "../src/core/resolve-config-value.js";
import { killTrackedDetachedChildren } from "../src/utils/shell.js";

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

	test("resolveConfigValueOrThrow and resolveConfigValueOrThrowAsync omit raw commands and unset template fragments from errors", async () => {
		const bangSecret = "opaqueBangSecret991122";
		const dollarSuffix = "UnsetSecretSegment778899";

		expect(() => resolveConfigValueOrThrow(`!${bangSecret}`, 'MCP server "s" oauth.clientSecret')).toThrow(
			'Failed to resolve MCP server "s" oauth.clientSecret from shell command',
		);
		try {
			resolveConfigValueOrThrow(`!${bangSecret}`, 'MCP server "s" oauth.clientSecret');
		} catch (error) {
			expect((error as Error).message).not.toContain(bangSecret);
		}

		await expect(
			resolveConfigValueOrThrowAsync(`!${bangSecret}`, 'MCP server "s" oauth.clientSecret'),
		).rejects.toThrow('Failed to resolve MCP server "s" oauth.clientSecret from shell command');
		try {
			await resolveConfigValueOrThrowAsync(`!${bangSecret}`, 'MCP server "s" oauth.clientSecret');
		} catch (error) {
			expect((error as Error).message).not.toContain(bangSecret);
		}

		await expect(
			resolveConfigValueOrThrowAsync(`prefix$${dollarSuffix}`, 'MCP server "s" oauth.clientSecret', {}),
		).rejects.toThrow('Failed to resolve MCP server "s" oauth.clientSecret from environment variable');
		try {
			await resolveConfigValueOrThrowAsync(`prefix$${dollarSuffix}`, 'MCP server "s" oauth.clientSecret', {});
		} catch (error) {
			expect((error as Error).message).not.toContain(dollarSuffix);
		}
	});

	/** How long a stopped command may take to settle, far below the 10 s command timeout and the grandchild's 30 s. */
	const SETTLE_WITHIN_MS = 1_500;
	/** The command timeout the runner arms, shortened in the timeout case so the test does not wait for it. */
	const COMMAND_TIMEOUT_MS = 10_000;
	const SHORTENED_COMMAND_TIMEOUT_MS = 100;
	/** Polls, 10 ms apart, for a stopped grandchild to be gone. */
	const EXIT_POLLS = 50;
	const EXIT_POLL_MS = 10;

	test.skipIf(process.platform === "win32")(
		"a command running in its own process group is stopped with Atomic's other detached children on hangup (#5377)",
		async () => {
			const started = join(tempDir, "started");
			const resolving = resolveConfigValueUncachedAsync(`!sh -c 'touch "${started}"; exec sleep 30'`);
			await vi.waitFor(() => expect(existsSync(started)).toBe(true));
			killTrackedDetachedChildren();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				expect(
					await Promise.race([
						resolving,
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error("the command kept running")), SETTLE_WITHIN_MS);
						}),
					]),
				).toBeUndefined();
			} finally {
				clearTimeout(timer);
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"settles promptly on timeout and maxBuffer when a background grandchild holds stdout (#5377)",
		async () => {
			const within = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					return await Promise.race([
						promise,
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error("timed out waiting for command")), ms);
						}),
					]);
				} finally {
					if (timer !== undefined) clearTimeout(timer);
				}
			};
			const waitForProcessExit = async (pid: number): Promise<void> => {
				for (let i = 0; i < EXIT_POLLS; i++) {
					try {
						process.kill(pid, 0);
					} catch {
						return;
					}
					await new Promise<void>((resolve) => setTimeout(resolve, EXIT_POLL_MS));
				}
				expect(() => process.kill(pid, 0)).toThrow();
			};
			const pidFile = join(tempDir, "grandchild.pid");
			const escapedPidPath = pidFile.replace(/\\/g, "/").replace(/[\\"]/g, "\\$&");
			expect(
				await within(
					resolveConfigValueUncachedAsync(
						`!node -e 'const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); const g = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setTimeout(() => {}, 30000);"], { stdio: "inherit" }); writeFileSync("${escapedPidPath}", String(g.pid)); process.stdout.write("x".repeat(1100000)); setTimeout(() => {}, 30000);'`,
					),
					SETTLE_WITHIN_MS,
				),
			).toBeUndefined();
			await waitForProcessExit(Number(readFileSync(pidFile, "utf-8").trim()));

			const realSetTimeout = globalThis.setTimeout;
			vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...rest: unknown[]) =>
				realSetTimeout(
					fn,
					ms === COMMAND_TIMEOUT_MS ? SHORTENED_COMMAND_TIMEOUT_MS : ms,
					...rest,
				)) as typeof setTimeout);
			expect(
				await within(
					resolveConfigValueUncachedAsync(
						`!node -e 'const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); const g = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setTimeout(() => {}, 30000);"], { stdio: "inherit" }); writeFileSync("${escapedPidPath}", String(g.pid)); setTimeout(() => {}, 30000);'`,
					),
					SETTLE_WITHIN_MS,
				),
			).toBeUndefined();
			await waitForProcessExit(Number(readFileSync(pidFile, "utf-8").trim()));
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
