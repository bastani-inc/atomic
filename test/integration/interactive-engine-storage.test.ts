import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { parseArgs } from "../../packages/coding-agent/src/cli/args.js";
import {
	createAgentSessionServices,
	createUnstartedAgentSessionFromServices,
} from "../../packages/coding-agent/src/core/agent-session-services.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { quoteIfNeeded } from "../../packages/coding-agent/src/modes/interactive/chat-input-actions.js";
import { formatResumeCommand } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-helpers.js";
import { buildInteractiveEngineArgs } from "../../packages/coding-agent/src/modes/interactive-engine/engine-args.js";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.js";
import { getShellConfig } from "../../packages/coding-agent/src/utils/shell.js";

// A real built CLI child loads all startup resources and serves RPC over pipes.
const BUILT_ENGINE_RPC_TIMEOUT_MS = 90_000;

/**
 * Normally well under a second after `client.stop()`. The bound only names an engine that never exits, inside the
 * test's own limit, instead of leaving it to fail later as an unreadable EBUSY from removing its project directory.
 */
const ENGINE_EXIT_TIMEOUT_MS = 20_000;
const ENGINE_EXIT_POLL_MS = 20;

/**
 * A `--require` module that records the pid of the node process it is loaded into.
 *
 * `client.stop()` ends the process the client spawned, which behind a shell is the shell, not the engine: on Windows,
 * Git Bash's `exec` and cmd.exe's `/c` leave the shell running as node's parent. `stop()` then waits only a bounded
 * time for the pipes the engine inherited, so it can return while the engine is still shutting down, and Windows
 * refuses to remove a directory a live process has as its working directory (EBUSY on the project directory).
 */
function recordEnginePid(directory: string): { preload: string; pidFile: string } {
	const preload = join(directory, "record-engine-pid.cjs");
	const pidFile = join(directory, "engine.pid");
	writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n`);
	return { preload, pidFile };
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Resolves once the engine whose pid `recordEnginePid` captured has exited and released its working directory. */
async function waitForEngineExit(pidFile: string): Promise<void> {
	let pid: number;
	try {
		pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
	} catch {
		// The engine never started, so nothing holds the project directory.
		return;
	}
	// Each session of a test starts its own engine; never read this one's pid for the next.
	rmSync(pidFile, { force: true });
	const deadline = performance.now() + ENGINE_EXIT_TIMEOUT_MS;
	while (isRunning(pid)) {
		if (performance.now() > deadline) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// It exited just now; the deadline still passed.
			}
			throw new Error(`engine ${pid} still running ${ENGINE_EXIT_TIMEOUT_MS} ms after client.stop()`);
		}
		await sleep(ENGINE_EXIT_POLL_MS);
	}
}

test(
	"the built engine resumes the selected SQLite database and prefix from a different project",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "engine-storage-"));
		const projectA = join(root, "project-a");
		const projectB = join(root, "project-b");
		const agentDir = join(root, "agent");
		for (const directory of [projectA, projectB, agentDir]) mkdirSync(directory, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ onboardedVersion: "0.0.0" }));
		const store = await resolveSessionStore(projectA, {
			agentDir,
			settings: { sessions: { storage: { path: "selected.sqlite", prefix: "kept_" } } },
		});
		const manager = await SessionManager.create(store, projectB);
		await manager.appendSessionInfo("selected conversation");
		const parsed = parseArgs([
			"--offline",
			"--no-extensions",
			"--no-mcp",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--approve",
		]);
		const client = new RpcClient({
			cliPath: fileURLToPath(new URL("../../packages/coding-agent/dist/cli.js", import.meta.url)),
			cwd: projectB,
			runtimeExecutable: process.execPath,
			args: buildInteractiveEngineArgs(parsed, manager, {}),
			env: { ATOMIC_CODING_AGENT_DIR: agentDir, ANTHROPIC_API_KEY: "test-only-no-requests" },
			interactiveEngine: { onDiagnostic: () => {} },
		});
		try {
			await client.start();
			// Startup includes builtin loading; the short get_state deadline is not a startup budget.
			await client.waitForInteractiveEngineResources();
			const state = await client.getState();
			assert.equal(state.sessionId, manager.getSessionId());
			assert.equal(state.sessionName, "selected conversation");
			assert.equal(state.sessionLocation, manager.getSessionFile());
			assert.deepEqual((await store.load(manager.getSessionId())).entries[0], manager.getEntries()[0]);
			const beforeMirror = await store.load(manager.getSessionId());
			const modelRuntime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const services = await createAgentSessionServices({
				cwd: projectB,
				agentDir,
				modelRuntime,
				settingsManager: SettingsManager.inMemory(),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noContextFiles: true,
				},
			});
			const mirror = await createUnstartedAgentSessionFromServices(
				{ services, sessionManager: await SessionManager.open(store, manager.getSessionId()) },
				false,
			);
			try {
				assert.deepEqual(await store.load(manager.getSessionId()), beforeMirror);
				await client.setSessionName("child still writes");
				const latest = (await store.load(manager.getSessionId())).entries.at(-1);
				assert.ok(latest?.type === "session_info");
				assert.equal(latest.name, "child still writes");
			} finally {
				await mirror.session.dispose();
			}
		} finally {
			await client.stop();
			await store.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
	BUILT_ENGINE_RPC_TIMEOUT_MS,
);

test(
	"the printed SQLite resume hint reopens project B from project A's store through the real CLI",
	async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "sqlite-resume-hint-")));
		const projectA = join(root, "project A's store");
		const projectB = join(root, "project-b");
		const agentDir = join(root, "agent");
		for (const directory of [projectA, projectB, agentDir]) mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ sessions: { storage: { path: "project-b.sqlite" } } }),
		);
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		const path = join(projectA, "selected.sqlite");
		const { preload, pidFile } = recordEnginePid(root);
		const store = await resolveSessionStore(projectA, { sessionStore: { kind: "sqlite", path, prefix: "kept_" } });
		try {
			for (const id of ["", "session's ID"]) {
				await store.create({ id, version: 4, cwd: projectB, createdAt: new Date().toISOString() }, []);
				const manager = await SessionManager.open(store, id);
				await manager.appendSessionInfo("conversation from A");
				const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
				let hint: string | undefined;
				try {
					Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
					// Atomic's bash shell runs it, Git Bash on Windows, so it takes the POSIX hint.
					hint = formatResumeCommand(manager, "linux");
				} finally {
					if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
					else Reflect.deleteProperty(process.stdout, "isTTY");
				}
				assert.ok(hint);
				const shell = getShellConfig();
				const cli = fileURLToPath(new URL("../../packages/coding-agent/dist/cli.js", import.meta.url));
				const client = new RpcClient({
					cliPath: "",
					cwd: projectB,
					runtimeExecutable: shell.shell,
					runtimeArgs: [
						...shell.args,
						`atomic() { exec ${quoteIfNeeded(process.execPath)} --require ${quoteIfNeeded(preload)} ${quoteIfNeeded(cli)} --mode rpc --offline --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --approve "$@"; }; ${hint}`,
					],
					env: { ATOMIC_CODING_AGENT_DIR: agentDir, ANTHROPIC_API_KEY: "test-only-no-requests" },
				});
				try {
					await client.start();
					const state = await client.getState();
					assert.equal(state.sessionId, id);
					assert.equal(state.sessionName, "conversation from A");
					assert.equal(
						hint,
						`atomic --session-store ${quoteIfNeeded(path)} --session-prefix kept_ --session ${quoteIfNeeded(id)}`,
					);
				} finally {
					await client.stop();
					await waitForEngineExit(pidFile);
				}
			}
		} finally {
			await store.close();
			vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
		}
	},
	BUILT_ENGINE_RPC_TIMEOUT_MS,
);

test.runIf(process.platform === "win32")(
	"the printed SQLite resume hint reopens the session from cmd.exe (#4095)",
	async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "sqlite-resume-hint-cmd-")));
		const projectA = join(root, "project A's store");
		const projectB = join(root, "project-b");
		const agentDir = join(root, "agent");
		const bin = join(root, "bin");
		for (const directory of [projectA, projectB, agentDir, bin]) mkdirSync(directory, { recursive: true });
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		const path = join(projectA, "selected.sqlite");
		const { preload, pidFile } = recordEnginePid(root);
		const store = await resolveSessionStore(projectA, { sessionStore: { kind: "sqlite", path, prefix: "kept_" } });
		const cli = fileURLToPath(new URL("../../packages/coding-agent/dist/cli.js", import.meta.url));
		// `atomic` on cmd.exe's PATH, as a global npm install puts it.
		writeFileSync(
			join(bin, "atomic.cmd"),
			`@"${process.execPath}" --require "${preload}" "${cli}" --mode rpc --offline --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --approve %*\r\n`,
		);
		try {
			for (const [index, id] of ["", "session's ID"].entries()) {
				await store.create({ id, version: 4, cwd: projectB, createdAt: new Date().toISOString() }, []);
				const manager = await SessionManager.open(store, id);
				await manager.appendSessionInfo("conversation from A");
				const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
				let hint: string | undefined;
				try {
					Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
					hint = formatResumeCommand(manager, "win32");
				} finally {
					if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
					else Reflect.deleteProperty(process.stdout, "isTTY");
				}
				assert.ok(hint);
				assert.ok(!hint.includes("'C:") && !hint.includes(`'${root}`), hint);
				// The hint exactly as printed, pasted into cmd.exe.
				const script = join(root, `resume-${index}.cmd`);
				writeFileSync(script, `@set "PATH=${bin};%PATH%"\r\n@${hint}\r\n`);
				const client = new RpcClient({
					cliPath: "",
					cwd: projectB,
					runtimeExecutable: process.env.ComSpec ?? "cmd.exe",
					runtimeArgs: ["/d", "/c", script],
					env: { ATOMIC_CODING_AGENT_DIR: agentDir, ANTHROPIC_API_KEY: "test-only-no-requests" },
				});
				try {
					await client.start();
					const state = await client.getState();
					assert.equal(state.sessionId, id);
					assert.equal(state.sessionName, "conversation from A");
				} finally {
					await client.stop();
					await waitForEngineExit(pidFile);
				}
			}
		} finally {
			await store.close();
			vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
		}
	},
	BUILT_ENGINE_RPC_TIMEOUT_MS,
);
