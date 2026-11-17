import type * as ChildProcessModule from "node:child_process";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { createLocalPowerShellOperations } from "../src/core/tools/powershell.ts";
import type * as Shell from "../src/utils/shell.ts";

const { envRead } = vi.hoisted(() => ({
	envRead: { started: undefined as (() => void) | undefined, release: undefined as Promise<void> | undefined },
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcessModule>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("../src/utils/shell.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof Shell>();
	return {
		...actual,
		getPowerShellConfigAsync: async () => ({ shell: process.execPath, args: ["-e", ""] }),
		getShellEnvAsync: async () => {
			envRead.started?.();
			await envRead.release;
			return actual.getShellEnvAsync();
		},
	};
});

afterEach(() => {
	envRead.started = undefined;
	envRead.release = undefined;
	vi.mocked(spawn).mockClear();
});

async function cancelDuringEnvironmentRead(
	run: (signal: AbortSignal) => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>> {
	const controller = new AbortController();
	let release!: () => void;
	envRead.release = new Promise((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		envRead.started = resolve;
	});
	const execution = run(controller.signal);
	await started;
	controller.abort();
	release();
	const [settled] = await Promise.allSettled([execution]);
	return settled;
}

test("a bash command cancelled while its shell environment is read never starts the shell", async () => {
	const settled = await cancelDuringEnvironmentRead((signal) =>
		createLocalBashOperations().exec("echo started", tmpdir(), { onData: () => {}, signal }),
	);
	expect(settled.status).toBe("rejected");
	expect(String((settled as PromiseRejectedResult).reason)).toMatch(/aborted/);
	expect(vi.mocked(spawn)).not.toHaveBeenCalled();
});

test("a PowerShell command cancelled while its shell environment is read never starts the shell", async () => {
	const settled = await cancelDuringEnvironmentRead((signal) =>
		createLocalPowerShellOperations().exec("Write-Output started", tmpdir(), { onData: () => {}, signal }),
	);
	expect(settled.status).toBe("rejected");
	expect(String((settled as PromiseRejectedResult).reason)).toMatch(/aborted/);
	expect(vi.mocked(spawn)).not.toHaveBeenCalled();
});
