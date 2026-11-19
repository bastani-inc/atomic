#!/usr/bin/env bun
/**
 * View-latency benchmark: keystroke-to-paint and stream-chunk-to-paint latency of the main chat, an attached subagent chat (opened from `/tasks` and from the agent panel) and the `/tasks` list,
 * measured on the built CLI in a real pseudo-terminal under the same load.
 *
 * The load: a resumed session of `--entries` entries (10,000 by default) streaming in the main chat, `--subagents` background subagents forked from it streaming,
 * and `--shells` background shells printing a line every 50 ms. Every agent is an endless loop against a loopback
 * `openai-completions` endpoint (`model-server.ts`) that streams a marker in every delta and records when it sent it.
 *
 * Each view is measured for `--keys` keystrokes, one every `--key-interval-ms`:
 * - keystroke-to-paint: from writing a key to the PTY until the screen shows the text typed so far (in `/tasks`,
 *   until the selection moved);
 * - stream-chunk-to-paint: from the endpoint writing a delta until its marker is on screen, for the stream the view
 *   shows.
 * Both are timed by the chunk of terminal output that drew them. The event-loop delay of the host and the engine over
 * each window comes from `loop-monitor.mjs`, preloaded into every Atomic process; `--profile-dir` also writes a CPU
 * profile of each process per window (take latencies from a run without it).
 *
 *   bun run scripts/perf/view-latency/benchmark.ts --label before --out /tmp/viewlat-before.json
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	benchEnvironment,
	createDirectories,
	SUBAGENT_NAME,
	seedSession,
	writeAgentConfiguration,
} from "./fixtures.js";
import { ViewLatencyModelServer } from "./model-server.js";
import { startPty } from "./pty.js";
import { BenchScreen } from "./screen.js";

type ViewName = "main" | "subagent" | "panel" | "tasks";

interface Options {
	readonly label: string;
	readonly repo: string;
	readonly entries: number;
	readonly subagents: number;
	readonly shells: number;
	readonly keys: number;
	readonly keyIntervalMs: number;
	readonly deltaIntervalMs: number;
	readonly deltasPerTurn: number;
	readonly cols: number;
	readonly rows: number;
	readonly warmupMs: number;
	readonly views: readonly ViewName[];
	readonly out: string | undefined;
	readonly profileDir: string | undefined;
	readonly keep: boolean;
}

interface Stats {
	readonly count: number;
	readonly missed: number;
	readonly p50: number;
	readonly p90: number;
	readonly p99: number;
	readonly max: number;
}

interface LoopWindow {
	readonly role: string;
	readonly window: string;
	readonly p50: number;
	readonly p99: number;
	readonly max: number;
	readonly mean: number;
}

interface ViewResult {
	readonly keystroke: Stats;
	readonly stream: Stats | undefined;
	readonly loop: readonly LoopWindow[];
}

const KEY_WORD_LENGTH = 16;
/** Typed-prefix probes start at this length, so a prefix cannot match text that was already on screen. */
const MIN_PROBE_PREFIX = 4;
const PROBE_TIMEOUT_MS = 5_000;
const WORD_ALPHABET = "abcdefghijklmnoprstuvwy";
const ESC = "\x1b";
const KEY = {
	enter: "\r",
	escape: ESC,
	left: `${ESC}[D`,
	up: `${ESC}[A`,
	down: `${ESC}[B`,
	f2: `${ESC}OQ`,
	clearLine: "\x15",
} as const;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const now = (): number => performance.now();
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const number = (name: string, fallback: number): number => {
		const raw = value(name);
		if (raw === undefined) return fallback;
		const parsed = Number(raw);
		if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} needs a non-negative number`);
		return parsed;
	};
	const views = (value("views") ?? "main,subagent,panel,tasks").split(",") as ViewName[];
	return {
		label: value("label") ?? "run",
		repo: resolve(value("repo") ?? join(scriptDir, "..", "..", "..")),
		entries: number("entries", 10_000),

		subagents: number("subagents", 2),
		shells: number("shells", 2),
		keys: number("keys", 160),
		keyIntervalMs: number("key-interval-ms", 60),
		deltaIntervalMs: number("delta-interval-ms", 30),
		deltasPerTurn: number("deltas-per-turn", 60),
		cols: number("cols", 160),
		rows: number("rows", 48),
		warmupMs: number("warmup-ms", 8_000),
		views,
		out: value("out"),
		profileDir: value("profile-dir"),
		keep: argv.includes("--keep"),
	};
}

function stats(samples: readonly number[], missed: number): Stats {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (q: number): number => {
		if (sorted.length === 0) return Number.NaN;
		return Math.round((sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0) * 10) / 10;
	};
	return {
		count: sorted.length,
		missed,
		p50: at(0.5),
		p90: at(0.9),
		p99: at(0.99),
		max: Math.round((sorted.at(-1) ?? Number.NaN) * 10) / 10,
	};
}

function randomWord(): string {
	let word = "vk";
	while (word.length < KEY_WORD_LENGTH) word += WORD_ALPHABET[Math.floor(Math.random() * WORD_ALPHABET.length)];
	return word;
}

const includes =
	(needle: string) =>
	(lines: readonly string[]): boolean =>
		lines.some((line) => line.includes(needle));

const TASK_LIST_HINT = "space peek";
const PANEL_HINT = "back to prompt";

function panelSubagentSelected(lines: readonly string[]): boolean {
	return lines.some((line) => line.startsWith("❯ ") && line.includes(SUBAGENT_NAME));
}

/** The title of the selected `/tasks` row, without its status and clock, which change on their own. */
function selectedTaskTitle(lines: readonly string[]): string | undefined {
	for (const line of lines) {
		const match = /^ ❯ (.+?)\s{3,}(.+?)(?:\s{2,}|$)/.exec(line);
		if (match) return `${match[1]} ${match[2]}`;
	}
	return undefined;
}

class Bench {
	private readonly options: Options;
	private readonly screen: BenchScreen;
	private readonly server: ViewLatencyModelServer;
	readonly writeKey: (data: string) => void;
	private readonly windowFile: string;
	private readonly loopFile: string;

	constructor(
		options: Options,
		screen: BenchScreen,
		server: ViewLatencyModelServer,
		writeKey: (data: string) => void,
		files: { window: string; loop: string },
	) {
		this.options = options;
		this.screen = screen;
		this.server = server;
		this.writeKey = writeKey;
		this.windowFile = files.window;
		this.loopFile = files.loop;
	}

	setWindow(name: string): void {
		writeFileSync(this.windowFile, name);
	}

	async waitForRequests(streams: readonly string[], timeoutMs: number, label: string): Promise<void> {
		const deadline = now() + timeoutMs;
		while (!streams.every((stream) => (this.server.requests.get(stream) ?? 0) > 0)) {
			if (now() > deadline) throw new Error(`timed out waiting for ${label}\n${this.screen.text()}`);
			await sleep(100);
		}
	}

	/** Types a slash command or prompt and submits it; a second Enter accepts an open completion first. */
	async submit(text: string): Promise<void> {
		this.writeKey(KEY.clearLine);
		this.writeKey(text);
		await this.screen.waitFor(includes(text), 10_000, `the composer to show ${text}`);
		await sleep(300);
		this.writeKey(KEY.enter);
		await sleep(600);
		if (this.screen.lines().some((line) => line.includes(`❯ ${text}`))) {
			this.writeKey(KEY.enter);
			await sleep(600);
		}
	}

	async typeIntoComposer(keys: number): Promise<{ samples: number[]; missed: number }> {
		const samples: number[] = [];
		let missed = 0;
		let typed = 0;
		while (typed < keys) {
			const word = randomWord();
			const pending = new Set<{ readonly prefix: string; readonly sentAt: number }>();
			const unsubscribe = this.screen.subscribe((lines, atMs) => {
				for (const probe of pending) {
					if (!includes(probe.prefix)(lines)) continue;
					pending.delete(probe);
					samples.push(atMs - probe.sentAt);
				}
			});
			for (let index = 1; index <= word.length; index++) {
				const sentAt = now();
				this.writeKey(word[index - 1] ?? "");
				if (index >= MIN_PROBE_PREFIX) {
					pending.add({ prefix: word.slice(0, index), sentAt });
					typed++;
				}
				await sleep(this.options.keyIntervalMs);
			}
			const deadline = now() + PROBE_TIMEOUT_MS;
			while (pending.size > 0 && now() < deadline) await sleep(20);
			missed += pending.size;
			unsubscribe();
			this.writeKey(KEY.clearLine);
			await this.screen.waitFor((lines) => !includes(word.slice(0, 6))(lines), 5_000, "the composer to clear");
			await sleep(this.options.keyIntervalMs);
		}
		return { samples, missed };
	}

	async moveTaskSelection(keys: number): Promise<{ samples: number[]; missed: number }> {
		const samples: number[] = [];
		let missed = 0;
		for (let index = 0; index < keys; index++) {
			const before = selectedTaskTitle(this.screen.lines());
			const sentAt = now();
			this.writeKey(index % 2 === 0 ? KEY.down : KEY.up);
			const moved = await new Promise<number | undefined>((done) => {
				const timer = setTimeout(() => {
					unsubscribe();
					done(undefined);
				}, PROBE_TIMEOUT_MS);
				const unsubscribe = this.screen.subscribe((lines, atMs) => {
					const title = selectedTaskTitle(lines);
					if (title === undefined || title === before) return;
					clearTimeout(timer);
					unsubscribe();
					done(atMs - sentAt);
				});
			});
			if (moved === undefined) missed++;
			else samples.push(moved);
			await sleep(this.options.keyIntervalMs);
		}
		return { samples, missed };
	}

	/** Records the paint of every marker of `stream` sent after the call, until the returned stop function runs. */
	watchStream(stream: string | undefined): () => { samples: number[]; missed: number } {
		if (stream === undefined) return () => ({ samples: [], missed: 0 });
		const since = now();
		const painted = new Map<string, number>();
		const pattern = new RegExp(`ZQ${stream}x[0-9a-z]{5}`, "g");
		const unsubscribe = this.screen.subscribe((lines, atMs) => {
			for (const line of lines) {
				for (const match of line.matchAll(pattern)) {
					const marker = match[0];
					if (painted.has(marker)) continue;
					const emitted = this.server.markers.get(marker);
					if (emitted === undefined || emitted.atMs < since) continue;
					painted.set(marker, atMs - emitted.atMs);
				}
			}
		});
		return () => {
			unsubscribe();
			const until = now() - 2_000;
			let missed = 0;
			for (const [marker, emitted] of this.server.markers) {
				if (emitted.stream === stream && emitted.atMs >= since && emitted.atMs < until && !painted.has(marker)) {
					missed++;
				}
			}
			return { samples: [...painted.values()], missed };
		};
	}

	loopWindows(window: string): LoopWindow[] {
		let text = "";
		try {
			text = readFileSync(this.loopFile, "utf8");
		} catch {
			return [];
		}
		return text
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as LoopWindow & { window: string })
			.filter((entry) => entry.window === window)
			.map(({ role, window: name, p50, p99, max, mean }) => ({ role, window: name, p50, p99, max, mean }));
	}

	streamOnScreen(): string | undefined {
		const counts = new Map<string, number>();
		for (const line of this.screen.lines()) {
			for (const match of line.matchAll(/ZQ(\w+?)x[0-9a-z]{5}/g)) {
				const stream = match[1] ?? "";
				counts.set(stream, (counts.get(stream) ?? 0) + 1);
			}
		}
		return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
	}
}

async function measureView(bench: Bench, view: ViewName, options: Options, screen: BenchScreen): Promise<ViewResult> {
	await enterView(bench, view, screen);
	await sleep(1_500);
	const stream = view === "main" ? "m" : view === "tasks" ? undefined : bench.streamOnScreen();
	if (view !== "tasks" && stream === undefined) throw new Error(`no stream is painted in the ${view} view`);
	const window = `${options.label}-${view}`;
	bench.setWindow(window);
	await sleep(300);
	const stopStream = bench.watchStream(stream);
	const keys =
		view === "tasks" ? await bench.moveTaskSelection(options.keys) : await bench.typeIntoComposer(options.keys);
	const streamed = stopStream();
	bench.setWindow(`${window}-leave`);
	await sleep(400);
	await leaveView(bench, view, screen);
	return {
		keystroke: stats(keys.samples, keys.missed),
		stream: stream === undefined ? undefined : stats(streamed.samples, streamed.missed),
		loop: bench.loopWindows(window),
	};
}

async function enterView(bench: Bench, view: ViewName, screen: BenchScreen): Promise<void> {
	switch (view) {
		case "main":
			return;
		case "subagent":
			await bench.submit("/tasks");
			await screen.waitFor(includes(TASK_LIST_HINT), 15_000, "the task list");
			await sleep(500);
			bench.writeKey(KEY.enter);
			await screen.waitFor(includes("← tasks"), 15_000, "the subagent chat");
			return;
		case "panel":
			bench.writeKey(KEY.down);
			await screen.waitFor(includes(PANEL_HINT), 15_000, "the agent panel");
			for (let row = 0; row < 8 && !panelSubagentSelected(screen.lines()); row++) {
				bench.writeKey(KEY.down);
				await sleep(300);
			}
			if (!panelSubagentSelected(screen.lines())) throw new Error("no subagent row in the agent panel");
			bench.writeKey(KEY.enter);
			await screen.waitFor(includes("← main chat"), 15_000, "the subagent chat opened from the agent panel");
			return;
		case "tasks":
			await bench.submit("/tasks");
			await screen.waitFor(includes(TASK_LIST_HINT), 15_000, "the task list");
			return;
	}
}

async function leaveView(bench: Bench, view: ViewName, screen: BenchScreen): Promise<void> {
	switch (view) {
		case "main":
			return;
		case "subagent":
			bench.writeKey(KEY.left);
			await screen.waitFor(includes(TASK_LIST_HINT), 15_000, "the task list after the subagent chat");
			await sleep(300);
			bench.writeKey(KEY.escape);
			await screen.waitFor((lines) => !includes(TASK_LIST_HINT)(lines), 15_000, "the main chat");
			return;
		case "panel":
			bench.writeKey(KEY.left);
			await screen.waitFor(includes(PANEL_HINT), 15_000, "the agent panel after the subagent chat");
			await sleep(300);
			bench.writeKey(KEY.escape);
			await screen.waitFor((lines) => !includes(PANEL_HINT)(lines), 15_000, "the main chat");
			return;
		case "tasks":
			bench.writeKey(KEY.escape);
			await screen.waitFor((lines) => !includes(TASK_LIST_HINT)(lines), 15_000, "the main chat");
			return;
	}
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const root = mkdtempSync(join(tmpdir(), "atomic-viewlat-"));
	const dirs = createDirectories(root);
	const distIndex = join(options.repo, "packages", "coding-agent", "dist", "index.js");
	const cli = join(options.repo, "packages", "coding-agent", "dist", "cli.js");
	const shellCommand = "while :; do echo shell-line-$RANDOM; sleep 0.05; done";
	const server = new ViewLatencyModelServer({
		deltaIntervalMs: options.deltaIntervalMs,
		deltasPerTurn: options.deltasPerTurn,
		subagents: options.subagents,
		shells: options.shells,
		shellCommand,
		subagentName: SUBAGENT_NAME,
		readPath: dirs.readPath,
		now,
	});
	const port = await server.listen();
	writeAgentConfiguration(dirs, port);
	const seedStarted = now();
	const sessionId = seedSession(dirs, distIndex, options.entries, join(scriptDir, "seed-session.mjs"));
	process.stderr.write(`seeded ${options.entries} entries in ${Math.round(now() - seedStarted)} ms\n`);

	const windowFile = join(root, "window");
	const loopFile = join(root, "loop.jsonl");
	if (options.profileDir) mkdirSync(options.profileDir, { recursive: true });
	const env = benchEnvironment(dirs, {
		NODE_OPTIONS: `--import=${pathToFileURL(join(scriptDir, "loop-monitor.mjs")).href}`,
		VIEWLAT_WINDOW_FILE: windowFile,
		VIEWLAT_LOOP_FILE: loopFile,
		...(options.profileDir ? { VIEWLAT_PROFILE_DIR: resolve(options.profileDir) } : {}),
	});
	const screen = new BenchScreen(options.cols, options.rows);
	const pty = startPty({
		argv: ["node", cli, "--session", sessionId],
		cwd: dirs.project,
		env,
		cols: options.cols,
		rows: options.rows,
		now,
		onData: (chunk, atMs) => screen.feed(chunk, atMs),
	});
	// Windows' pseudo-console answers the application's terminal queries itself; a second answer would arrive as typing.
	if (process.platform !== "win32") screen.onReply((data) => pty.write(data));
	const bench = new Bench(options, screen, server, (data) => pty.write(data), { window: windowFile, loop: loopFile });
	const results: Partial<Record<ViewName, ViewResult>> = {};
	try {
		await screen.waitFor(includes("viewlat-model"), 120_000, "the main chat");
		await sleep(2_000);
		await bench.submit("VL-LAUNCH");
		const subagentStreams = Array.from({ length: options.subagents }, (_, index) => `u${index}`);
		await bench.waitForRequests(subagentStreams, 120_000, "every subagent to stream");
		await screen.waitFor(includes("Load launched."), 60_000, "the launch turn to end");
		await bench.submit("VL-STREAM m");
		await bench.waitForRequests(["m"], 60_000, "the main chat to stream");
		await sleep(options.warmupMs);
		for (const view of options.views) {
			results[view] = await measureView(bench, view, options, screen);
			process.stderr.write(`${view}: ${JSON.stringify(results[view])}\n`);
		}
		bench.setWindow("end");
		await sleep(500);
	} finally {
		pty.kill();
		await Promise.race([pty.exited, sleep(5_000)]);
		await server.close();
		if (!options.keep) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
	const summary = {
		label: options.label,
		platform: process.platform,
		entries: options.entries,

		subagents: options.subagents,
		shells: options.shells,
		keys: options.keys,
		keyIntervalMs: options.keyIntervalMs,
		results,
	};
	const text = `${JSON.stringify(summary, null, 2)}\n`;
	if (options.out) writeFileSync(options.out, text);
	process.stdout.write(`VIEWLAT-RESULT ${JSON.stringify(summary)}\n`);
	process.exit(0);
}

await main();
