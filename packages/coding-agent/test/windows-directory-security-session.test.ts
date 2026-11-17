import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn };
});
vi.mock("../src/utils/module-require.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/module-require.js")>();
	return {
		createModuleRequire: (url: string) => {
			const require = actual.createModuleRequire(url);
			return (specifier: string) => {
				if (specifier !== "@bastani/atomic-natives") return require(specifier);
				const binding = require(specifier) as {
					windowsDirectorySecurity(
						path: string,
					): import("../src/core/tools/windows-directory-security.js").WindowsDirectorySecurity | null;
					windowsDirectorySecurityAsync(
						path: string,
					): Promise<import("../src/core/tools/windows-directory-security.js").WindowsDirectorySecurity | null>;
				};
				return {
					...binding,
					windowsDirectorySecurity: (path: string) =>
						path.includes("atomic-security-owner-") ? null : binding.windowsDirectorySecurity(path),
					windowsDirectorySecurityAsync: async (path: string) =>
						path.includes("atomic-security-owner-") ? null : binding.windowsDirectorySecurityAsync(path),
				};
			};
		},
	};
});

const { AgentSessionRuntime } = await import("../src/core/agent-session-runtime.js");
const { trackSessionWork } = await import("../src/core/session-lifecycle-work.js");
const {
	resetWindowsDirectorySecurityStateForTesting,
	verifyWindowsDirectorySecurity,
	waitForWindowsDirectorySecurityReadsForTesting,
} = await import("../src/core/tools/windows-directory-security.js");
const { createHarness } = await import("./suite/harness.js");

const sandboxes: string[] = [];
afterEach(async () => {
	resetWindowsDirectorySecurityStateForTesting();
	await waitForWindowsDirectorySecurityReadsForTesting();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const path of sandboxes.splice(0)) rmSync(path, { recursive: true, force: true });
});

function directory(): string {
	const path = mkdtempSync(join(tmpdir(), "atomic-security-owner-"));
	sandboxes.push(path);
	return path;
}

async function host() {
	const harness = await createHarness();
	const runtime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			resourceLoader: harness.session.resourceLoader,
		} as never,
		async () => {
			throw new Error("unused replacement factory");
		},
	);
	return { harness, runtime };
}

function pendingChild() {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
		ref: vi.fn(),
		unref: vi.fn(),
	});
}

test.each(["session", "runtime", "nested session", "nested runtime"] as const)(
	"host disposal cancels an owned %s ACL fallback and waits for its child to close (#5324)",
	async (owner) => {
		const child = pendingChild();
		spawn.mockReturnValue(child);
		const { harness, runtime } = await host();
		const path = directory();
		try {
			await trackSessionWork(owner.endsWith("session") ? harness.session : runtime, async () => {
				const start = async () => {
					verifyWindowsDirectorySecurity(path);
				};
				if (owner.startsWith("nested")) await trackSessionWork({}, start);
				else await start();
			});
			await setImmediate();
			assert.ok(spawn.mock.calls.length > 0);
			let closed = false;
			const closing = runtime.dispose().then(() => {
				closed = true;
			});
			await setImmediate();
			assert.equal(child.kill.mock.calls.length, 1, "the retiring host cancels its fallback");
			assert.equal(closed, false, "disposal waits for process closure, not just a kill request");
			child.emit("close", null, "SIGTERM");
			await closing;
			rmSync(path, { recursive: true });
			assert.equal(existsSync(path), false);
		} finally {
			resetWindowsDirectorySecurityStateForTesting();
			child.emit("close", null, "SIGTERM");
			await runtime.dispose();
			await harness.cleanup();
		}
	},
);

test("closing one host leaves another host's shared ACL read running (#5324)", async () => {
	const child = pendingChild();
	spawn.mockReturnValue(child);
	const first = await host();
	const second = await host();
	const path = directory();
	try {
		for (const { harness } of [first, second]) {
			await trackSessionWork(harness.session, async () => {
				verifyWindowsDirectorySecurity(path);
			});
		}
		await first.runtime.dispose();
		assert.equal(child.kill.mock.calls.length, 0, "the second host still owns its read");
		const closing = second.runtime.dispose();
		await setImmediate();
		assert.equal(child.kill.mock.calls.length, 1);
		child.emit("close", null, "SIGTERM");
		await closing;
	} finally {
		resetWindowsDirectorySecurityStateForTesting();
		child.emit("close", null, "SIGTERM");
		await Promise.all([first.runtime.dispose(), second.runtime.dispose()]);
		await first.harness.cleanup();
		await second.harness.cleanup();
	}
});

test.skipIf(process.platform !== "win32")(
	"a host's in-flight PowerShell ACL fallback leaves no child or locked home after close (#5324)",
	async () => {
		const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
		const children: ChildProcess[] = [];
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		spawn.mockImplementation((executable, _args, options) => {
			const child = actual.spawn(
				executable,
				["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write('ready'); Start-Sleep -Seconds 60"],
				{ ...options, cwd: options.env.ATOMIC_SECURITY_QUERY_PATH },
			);
			children.push(child);
			child.stdout?.once("data", ready);
			return child;
		});
		const path = directory();
		mkdirSync(join(path, "cache", "tmp"), { recursive: true });
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", path);
		const { harness, runtime } = await host();
		try {
			await started;
			await runtime.dispose();
			assert.ok(children.length > 0);
			for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null);
			rmSync(path, { recursive: true });
			assert.equal(existsSync(path), false, "no fallback process holds the retired home");
		} finally {
			for (const child of children) child.kill();
			await runtime.dispose();
			await harness.cleanup();
		}
	},
);
