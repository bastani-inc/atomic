import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import type { LifecycleTraceLine } from "../../packages/coding-agent/src/core/lifecycle-timings.ts";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir, sleep } from "../helpers/runtime.js";
import { messageText, startScriptedChatServer } from "../helpers/scripted-chat-server.js";

const CLI = join(moduleDir(import.meta.url), "../../packages/coding-agent/dist/cli.js");
// Real isolated CLI startup + 3 sequential background subagents + multiple /tasks PTY transitions under Node on Linux & Windows.
const PTY_SCENARIO_TIMEOUT_MS = 120_000;
const WAIT_MS = 45_000;

const ENTER = "\r";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const ESC = "\x1b";
const KITTY_ESC = "\x1b[27u";

const SEQUENTIAL_TASKS = [
	{ key: "alpha", command: "LAUNCH_ALPHA", task: "TASK-ALPHA first item" },
	{ key: "beta", command: "LAUNCH_BETA", task: "TASK-BETA middle item" },
	{ key: "gamma", command: "LAUNCH_GAMMA", task: "TASK-GAMMA newest item" },
] as const;

function selectedRow(screen: string): string {
	return (
		screen
			.split("\n")
			.map((line) => line.trimEnd())
			.find((line) => /^\s*(?:❯|∀)\s+.*worker\b/.test(line)) ?? ""
	);
}

function isTasksOpen(screen: string): boolean {
	return /Tasks\s+3 done/.test(screen) && screen.includes("↑↓ select") && selectedRow(screen) !== "";
}

function isViewingBeta(screen: string): boolean {
	return screen.includes("← main chat") && screen.includes("worker · TASK-BETA");
}

function dockLines(screen: string): string[] {
	const lines = screen.split("\n").map((line) => line.trimEnd());
	const promptIndex = lines.findLastIndex((line) => /^❯(?:\s|$)/.test(line));
	return promptIndex < 0 ? [] : lines.slice(promptIndex);
}

function promptShows(screen: string, text: string): boolean {
	return dockLines(screen).some((line) => line.startsWith(`❯ ${text}`));
}

test(
	"isolated host PTY e2e: /tasks finished-subagent panelOnView open, Esc dismissal, and rapid Enter+Esc never leave a speculative preview or wrong selection",
	async () => {
		const root = makeTempDirectory("tasks-preview-esc-pty-");
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const trace = join(root, "startup.jsonl");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });

		const server = await startScriptedChatServer(({ messages }) => {
			const last = messages.at(-1);
			const lastUser = [...messages].reverse().find((m) => m.role === "user");
			const prompt = messageText(lastUser);

			for (const entry of SEQUENTIAL_TASKS) {
				if (prompt.includes(entry.command)) {
					if (last?.role === "tool") {
						return {
							label: `launched-${entry.key}`,
							text: `LAUNCHED_${entry.key.toUpperCase()}`,
							chunks: 1,
							chunkDelayMs: 0,
						};
					}
					return {
						label: `call-${entry.key}`,
						text: `Launching ${entry.key}.`,
						chunks: 1,
						chunkDelayMs: 0,
						toolCalls: [
							{
								name: "subagent",
								arguments: {
									context: "fresh",
									tasks: [{ agent: "worker", model: "scripted/local", task: entry.task }],
								},
							},
						],
					};
				}
			}

			if (prompt.includes("Subagent worker completed")) {
				for (const entry of SEQUENTIAL_TASKS) {
					if (prompt.includes(entry.task)) {
						return {
							label: `wake-${entry.key}`,
							text: `Acknowledged ${entry.task}.`,
							chunks: 1,
							chunkDelayMs: 0,
						};
					}
				}
			}

			for (const entry of SEQUENTIAL_TASKS) {
				if (prompt.includes(entry.task)) {
					return {
						label: `subagent-${entry.key}`,
						text: `Finished ${entry.task}.`,
						chunks: 1,
						chunkDelayMs: 0,
					};
				}
			}

			return { label: "other", text: "Done.", chunks: 1, chunkDelayMs: 0 };
		});

		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					scripted: {
						api: "openai-completions",
						apiKey: "fixture",
						baseUrl: server.baseUrl,
						models: [
							{
								id: "local",
								name: "local",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200000,
								maxTokens: 4096,
							},
						],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "scripted",
				defaultModel: "local",
				lastChangelogVersion: "0.0.0",
				firstRunOnboardingStartedVersion: "0.0.0",
				onboardedVersion: "0.0.0",
				sessionSummary: { enabled: false },
			}),
		);

		const osEnv: Record<string, string> = {};
		for (const key of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
			const value = process.env[key];
			if (value !== undefined) osEnv[key] = value;
		}
		const program = startPtyProgram({
			executable: process.execPath,
			args: [
				CLI,
				"--offline",
				"--no-mcp",
				"--no-session",
				"--approve",
				"--provider",
				"scripted",
				"--model",
				"local",
			],
			cwd,
			env: {
				...osEnv,
				// Override Vitest's inherited NODE_ENV=test so subagents run real sessions against the scripted server.
				NODE_ENV: "production",
				HOME: root,
				USERPROFILE: root,
				TERM: "xterm-256color",
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_CODING_AGENT_SESSION_DIR: "",
				ATOMIC_STORAGE: "",
				ATOMIC_SESSIONS_STORAGE: "",
				ATOMIC_INTERCOM_SESSION_ID: "",
				ATOMIC_SKIP_VERSION_CHECK: "1",
				ATOMIC_TELEMETRY: "0",
				ATOMIC_STARTUP_TRACE: trace,
			},
			timeoutMs: PTY_SCENARIO_TIMEOUT_MS,
			cols: 120,
			rows: 34,
		});

		const openTasks = async () => {
			program.write("/tasks");
			await program.waitForScreen((s) => promptShows(s, "/tasks"), WAIT_MS, "/tasks typed");
			program.write(ENTER);
			await program.waitForScreen(isTasksOpen, WAIT_MS, "/tasks list with 3 finished subagents");
		};

		const isMainPanelHidden = (screen: string): boolean =>
			!isViewingBeta(screen) &&
			screen.includes("/tasks to see subagents") &&
			!dockLines(screen).some(
				(line) => line.includes("● main") || line.includes("◯ main") || line.includes("worker"),
			);

		try {
			await program.waitForScreen((s) => dockLines(s).length > 0, WAIT_MS, "initial prompt");

			// Launch the 3 subagents sequentially so settlement order is deterministically
			// ALPHA < BETA < GAMMA, giving /tasks Done order [TASK-GAMMA, TASK-BETA, TASK-ALPHA].
			for (const entry of SEQUENTIAL_TASKS) {
				program.write(entry.command);
				await program.waitForScreen((s) => promptShows(s, entry.command), WAIT_MS, `${entry.command} typed`);
				program.write(ENTER);
				await program.waitForScreen(
					(s) =>
						server.completed.includes(`subagent-${entry.key}`) &&
						server.completed.includes(`wake-${entry.key}`) &&
						server.streaming() === 0 &&
						!promptShows(s, entry.command) &&
						isMainPanelHidden(s),
					WAIT_MS,
					`${entry.task} finished and idle panel hidden`,
				);
			}

			// 1. Happy path panelOnView: open TASK-BETA from /tasks -> opens single chat screen with pinned panel row!
			await openTasks();
			assert.match(selectedRow(program.screen()), /TASK-GAMMA/, "fresh /tasks starts at top (TASK-GAMMA)");
			program.write(DOWN);
			await program.waitForScreen((s) => /TASK-BETA/.test(selectedRow(s)), WAIT_MS, "TASK-BETA selected in /tasks");
			program.write(ENTER);
			await program.waitForScreen(
				(s) => isViewingBeta(s) && dockLines(s).some((line) => line.includes("● worker")),
				WAIT_MS,
				"TASK-BETA chat and pinned panel row shown",
			);

			// 2. Return via Left -> main shown, idle panel hides again, /tasks restores TASK-BETA.
			program.write(LEFT);
			await program.waitForScreen(isMainPanelHidden, WAIT_MS, "returned to main and idle panel hidden");
			await openTasks();
			assert.match(selectedRow(program.screen()), /TASK-BETA/, "/tasks keeps TASK-BETA after returning via Left");

			// 3. Dismiss /tasks on main with Esc -> next /tasks resets to top (TASK-GAMMA, matching reference).
			program.write(ESC);
			await program.waitForScreen(
				(s) => !s.includes("↑↓ select") && isMainPanelHidden(s),
				WAIT_MS,
				"/tasks dismissed on main",
			);
			await openTasks();
			assert.match(selectedRow(program.screen()), /TASK-GAMMA/, "fresh /tasks after Esc starts at top");

			// 4a. Deterministic pre-view Esc (Enter + Kitty CSI-u Esc in the same PTY write, 0ms buffer delay):
			// Esc arrives at host BEFORE engine_view_agent returns from the engine, so it must ALWAYS cancel cleanly.
			program.write(DOWN);
			await program.waitForScreen(
				(s) => /TASK-BETA/.test(selectedRow(s)),
				WAIT_MS,
				"TASK-BETA selected (kitty Esc)",
			);
			program.write(`${ENTER}${KITTY_ESC}`);
			await program.waitForScreen(
				(s) => !s.includes("↑↓ select") && isMainPanelHidden(s),
				WAIT_MS,
				"/tasks closed after Enter+Kitty-Esc",
			);
			await sleep(350);
			const kittySettled = program.screen();
			assert.equal(isViewingBeta(kittySettled), false, `pre-view Kitty Esc must cancel open:\n${kittySettled}`);
			assert.ok(
				!dockLines(kittySettled).some((line) => line.includes("● worker") || line.includes("TASK-BETA")),
				`speculative preview leaked on main after Kitty Esc:\n${kittySettled}`,
			);
			await openTasks();
			assert.match(
				selectedRow(program.screen()),
				/TASK-GAMMA/,
				`next /tasks after pre-view Kitty Esc must land at top:\n${program.screen()}`,
			);

			// 4b. Rapid Enter + legacy Esc on TASK-BETA (with idle panel empty -> panelOnView: true).
			// Verify across 0ms, 5ms, and 15ms delays that neither a stale speculative preview nor a bad selection survives.
			for (const delayMs of [0, 5, 15]) {
				program.write(DOWN);
				await program.waitForScreen(
					(s) => /TASK-BETA/.test(selectedRow(s)),
					WAIT_MS,
					`TASK-BETA selected (delay=${delayMs}ms)`,
				);
				program.write(ENTER);
				if (delayMs > 0) await sleep(delayMs);
				program.write(ESC);
				// Wait for /tasks to close and any in-flight open/cancel to settle past the 250ms panel frame cap.
				await program.waitForScreen(
					(s) => !s.includes("↑↓ select"),
					WAIT_MS,
					`/tasks closed after Enter+Esc (delay=${delayMs}ms)`,
				);
				await sleep(350);

				const settled = program.screen();
				if (isViewingBeta(settled)) {
					// Open committed before Esc reached the host: Left returns cleanly, and Esc resets /tasks to top.
					program.write(LEFT);
					await program.waitForScreen(
						isMainPanelHidden,
						WAIT_MS,
						`returned from committed TASK-BETA (delay=${delayMs}ms)`,
					);
					await openTasks();
					assert.match(selectedRow(program.screen()), /TASK-BETA/);
					program.write(ESC);
					await program.waitForScreen((s) => !s.includes("↑↓ select"), WAIT_MS, "dismiss after return");
					await openTasks();
					assert.match(selectedRow(program.screen()), /TASK-GAMMA/);
				} else {
					// Esc cancelled the in-flight open: main MUST NOT show any speculative preview panel row,
					// and next /tasks MUST land at top (TASK-GAMMA), NOT TASK-BETA!
					assert.ok(
						!dockLines(settled).some((line) => line.includes("● worker") || line.includes("TASK-BETA")),
						`speculative preview leaked on main after Esc (delay=${delayMs}ms):\n${settled}`,
					);
					await openTasks();
					assert.match(
						selectedRow(program.screen()),
						/TASK-GAMMA/,
						`next /tasks after Esc-cancelled open must land at top (delay=${delayMs}ms):\n${program.screen()}`,
					);
				}
			}

			// Close /tasks and quit cleanly.
			program.write(ESC);
			await program.waitForScreen((s) => !s.includes("↑↓ select"), WAIT_MS, "close /tasks before quit");
			program.write("/quit");
			await program.waitForScreen((s) => promptShows(s, "/quit"), WAIT_MS, "/quit typed");
			program.write(ENTER);
			assert.equal((await program.exited).exitCode, 0);

			// Confirm we actually ran on the isolated engine host.
			const marks = readFileSync(trace, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as LifecycleTraceLine);
			assert.ok(
				marks.some((mark) => mark.label === "interactive-engine-spawn"),
				"test must exercise the isolated engine host",
			);
		} finally {
			program.kill();
			await program.exited;
			try {
				await server.close();
			} finally {
				await removeTempRootReleasingBroker(root, agentDir);
			}
		}
	},
	PTY_SCENARIO_TIMEOUT_MS,
);
