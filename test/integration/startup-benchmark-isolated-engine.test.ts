import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { fileExists, moduleDir, readText, sleep, spawnSyncCollect, writeFileEnsuringDir } from "../helpers/runtime.js";

const repoRoot = join(moduleDir(import.meta.url), "../..");
const TMUX_AVAILABLE = (() => {
	try {
		return spawnSyncCollect(["tmux", "-V"]).exitCode === 0;
	} catch {
		return false;
	}
})();
const BENCHMARK_EXIT_TIMEOUT_MS = 120_000;
const RAW_STREAM_SETTLE_TIMEOUT_MS = 5_000;
const RAW_STREAM_STABLE_POLLS = 5;
const SCENARIO_OVERHEAD_MS = 10_000;
const REAL_BENCHMARK_RUN_TIMEOUT_MS = BENCHMARK_EXIT_TIMEOUT_MS + RAW_STREAM_SETTLE_TIMEOUT_MS + SCENARIO_OVERHEAD_MS;
const POLL_INTERVAL_MS = 50;
const TIMINGS_HEADER = "--- Startup Timings: main ---";
const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\x1b[?1049l";

interface LifecycleMarker {
	event: "session_start" | "session_shutdown";
	pid: number;
	ppid: number;
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

/** Whether `offset` lies between an alternate-screen enter and its matching leave, where output is discarded. */
function onAlternateScreen(raw: string, offset: number): boolean {
	const entered = raw.lastIndexOf(ENTER_ALTERNATE_SCREEN, offset);
	if (entered === -1) return false;
	const left = raw.indexOf(LEAVE_ALTERNATE_SCREEN, entered);
	return left === -1 || left > offset;
}

test.skipIf(!TMUX_AVAILABLE)(
	"ATOMIC_STARTUP_BENCHMARK under the default isolated engine shows the host's timings once on the terminal and shuts the engine down (#4354)",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-startup-benchmark-"));
		const socket = join(temp, "tmux.sock");
		const config = join(temp, "tmux.conf");
		const agentDir = join(temp, "agent");
		const probe = join(temp, "probe.mjs");
		const markersPath = join(temp, "markers.jsonl");
		const rawPath = join(temp, "pane.raw");
		mkdirSync(agentDir, { recursive: true });
		await writeFileEnsuringDir(config, "set -g remain-on-exit on\nset -g history-limit 50000\n");
		await writeFileEnsuringDir(
			probe,
			`import { appendFileSync } from "node:fs";
const mark = (event) =>
	appendFileSync(process.env.LIFECYCLE_MARKERS, JSON.stringify({ event, pid: process.pid, ppid: process.ppid }) + "\\n");
export default function (pi) {
	pi.on("session_start", () => mark("session_start"));
	pi.on("session_shutdown", () => mark("session_shutdown"));
}
`,
		);
		const tmux = (...args: string[]) => {
			const result = spawnSyncCollect(["tmux", "-S", socket, "-f", config, ...args]);
			assert.equal(result.exitCode, 0, result.stderr.toString());
			return result.stdout.toString().trim();
		};
		const waitUntil = async (ready: () => boolean | Promise<boolean>, deadline: number): Promise<boolean> => {
			while (!(await ready())) {
				if (Date.now() >= deadline) return false;
				await sleep(POLL_INTERVAL_MS);
			}
			return true;
		};
		try {
			// The pane waits for Enter before it execs the CLI, so the raw stream is recorded from the CLI's first byte
			// and the pane's process, exit status and history are the CLI's own.
			tmux(
				"new-session",
				"-d",
				"-s",
				"benchmark",
				"-x",
				"120",
				"-y",
				"40",
				"-c",
				repoRoot,
				"-e",
				`ATOMIC_CODING_AGENT_DIR=${agentDir}`,
				"-e",
				"ATOMIC_STARTUP_BENCHMARK=1",
				"-e",
				"ATOMIC_TIMING=1",
				"-e",
				"CI=0",
				"-e",
				`LIFECYCLE_MARKERS=${markersPath}`,
				"sh",
				"-c",
				'read _ && exec "$@"',
				"startup-benchmark",
				process.execPath,
				join(repoRoot, "packages/coding-agent/dist/cli.js"),
				"--no-session",
				"--offline",
				"--approve",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--provider",
				"anthropic",
				"--model",
				"claude-opus-4-8",
				"--extension",
				probe,
			);
			const hostPid = Number(tmux("display-message", "-p", "-t", "benchmark", "#{pane_pid}"));
			tmux("pipe-pane", "-o", "-t", "benchmark", `cat >> '${rawPath}'`);
			tmux("send-keys", "-t", "benchmark", "Enter");
			const exited = await waitUntil(
				() => tmux("display-message", "-p", "-t", "benchmark", "#{pane_dead}") === "1",
				Date.now() + BENCHMARK_EXIT_TIMEOUT_MS,
			);
			const pane = tmux("capture-pane", "-p", "-J", "-S", "-", "-t", "benchmark");
			assert.ok(exited, `the benchmark run must exit by itself\n${pane}`);
			assert.equal(tmux("display-message", "-p", "-t", "benchmark", "#{pane_dead_status}"), "0", pane);
			let rawSize = -1;
			let unchangedPolls = 0;
			await waitUntil(async () => {
				const size = (await fileExists(rawPath)) ? statSync(rawPath).size : -1;
				unchangedPolls = size > 0 && size === rawSize ? unchangedPolls + 1 : 0;
				rawSize = size;
				return unchangedPolls >= RAW_STREAM_STABLE_POLLS;
			}, Date.now() + RAW_STREAM_SETTLE_TIMEOUT_MS);
			const raw = await readText(rawPath);

			assert.ok(!pane.includes("only supports interactive mode"), pane);
			assert.ok(raw.includes(ENTER_ALTERNATE_SCREEN), "the run must use the fullscreen TUI on the alternate screen");
			assert.equal(occurrences(raw, TIMINGS_HEADER), 1, "the terminal must receive one timing block");
			assert.ok(
				!onAlternateScreen(raw, raw.indexOf(TIMINGS_HEADER)),
				"the timing block must not be written to the alternate screen",
			);
			assert.equal(occurrences(pane, TIMINGS_HEADER), 1, pane);
			const block = pane.slice(pane.indexOf(TIMINGS_HEADER), pane.indexOf("TOTAL initialization time"));
			assert.match(block, /^ {2}interactiveMode\.init: \d+ms\s*$/m, pane);
			assert.match(block, /^ {2}interactiveEngine\.resourcesReady: \d+ms\s*$/m, pane);

			const markers = (await readText(markersPath))
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as LifecycleMarker);
			const started = markers.filter((marker) => marker.event === "session_start");
			const shutDown = markers.filter((marker) => marker.event === "session_shutdown");
			assert.equal(started.length, 1, JSON.stringify(markers));
			const engine = started[0]!;
			assert.notEqual(engine.pid, hostPid, "the session must run in the isolated engine child, not the host");
			assert.equal(engine.ppid, hostPid, "the engine must be the host's child");
			assert.deepEqual(
				shutDown.map((marker) => marker.pid),
				[engine.pid],
				`the engine's extensions must get session_shutdown: ${JSON.stringify(markers)}`,
			);
		} finally {
			spawnSyncCollect(["tmux", "-S", socket, "kill-server"]);
			rmSync(temp, { recursive: true, force: true });
		}
	},
	REAL_BENCHMARK_RUN_TIMEOUT_MS,
);
