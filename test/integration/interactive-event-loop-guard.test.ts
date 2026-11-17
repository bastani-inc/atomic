/**
 * The interactive host and its isolated engine keep their event loops responsive while a user works.
 *
 * Each scenario starts the built CLI (laid out as npm installs it) in a pseudo-terminal with the event-loop diagnostic
 * on, so the host and the engine each write their event-loop delay for startup and for the rest of the session, and
 * every block with its stacks. A scripted loopback provider plays the model. The scenarios: typing and editing, a long
 * answer streaming while the user types ahead and pages, a workflow of five stages, four subagents, and paging through
 * a resumed transcript of 10,400 entries. Each scenario is its own launch, so its numbers are its own.
 *
 * The file runs in its own Vitest project after every other integration file (see vitest.config.ts): the budgets hold
 * a real process's delay, which a runner busy with other files would add to.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import {
	type BlockRecord,
	type DelayRecord,
	delayOf,
	describeBlock,
	GUARD_WORKFLOW,
	GUARD_WORKFLOW_STAGES,
	type GuardReply,
	guardReply,
	type LogRecord,
	type Phase,
	type ProcessRole,
	prepareAgentDir,
	prepareInstalledPackage,
	readRecords,
	STREAM_MARKER,
	SUBAGENTS_MARKER,
	writeLargeSession,
} from "../helpers/event-loop-guard-fixture.js";
import { LAG_TAIL_SAMPLES } from "../helpers/event-loop-lag.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir, sleep } from "../helpers/runtime.js";
import { messageText, type ScriptedChatServer, startScriptedChatServer } from "../helpers/scripted-chat-server.js";

const ROOT = join(moduleDir(import.meta.url), "../..");
const PACKAGE = join(ROOT, "packages/coding-agent");
const CLI = join(PACKAGE, "dist/cli.js");

/**
 * Host budgets. The host draws every frame and echoes every keystroke, so its delay is the lag a user sees. Input that
 * answers within 100 ms feels instant; a p99 under half that keeps a typing burst smooth, and no single stall may
 * last long enough to drop a visible run of frames or land a keystroke late. Measured with the package laid out as
 * installed (milliseconds; session phase unless noted; local Linux, then remote Linux and Windows, worst of repeats):
 * p99 1–4 and max 9–40 for typing, streaming, workflow and subagents; startup max 60–82. The resumed transcript
 * breaks both (see the PR notes): its p99 was 19–33 and max 0.6–1.2 s, every stall rendering the whole transcript.
 */
const HOST_LOOP_DELAY_P99_BUDGET_MS = 50;
const HOST_LOOP_DELAY_MAX_BUDGET_MS = 150;
/**
 * Engine budgets. The engine runs the agent, its tools and extensions; its stalls hold back streamed text, tool
 * progress and extension frames on their way to the host, and the host's requests (custom UI input, renders) waiting
 * on them. Measured as above: p99 0.6–14, max 62–98, the largest a workflow-discovery scan as the session starts.
 * Its startup, a one-time extension load of 0.7–1.3 s while the host keeps the terminal responsive, is reported in
 * the failure message but not held to these budgets.
 */
const ENGINE_LOOP_DELAY_P99_BUDGET_MS = 50;
const ENGINE_LOOP_DELAY_MAX_BUDGET_MS = 250;
/**
 * The diagnostic's block threshold: the smallest max budget. A block this long already fails a budget, so the stack
 * capture that lengthens it on Node (it attaches the debugger inside the block) never decides a result, and the
 * failure message names the code that held the loop.
 */
const BLOCK_THRESHOLD_MS = Math.min(HOST_LOOP_DELAY_MAX_BUDGET_MS, ENGINE_LOOP_DELAY_MAX_BUDGET_MS);
/**
 * A session phase must hold enough ticks for its p99 to be the 99th percentile of many, not one of the last few
 * (event-loop-lag.ts, LAG_TAIL_SAMPLES): 500 ticks of the diagnostic's 10 ms histogram, five seconds.
 */
const MIN_SESSION_TICKS = 100 * LAG_TAIL_SAMPLES;
/**
 * Each scenario drives the terminal at least this long, so both processes' session phases reach MIN_SESSION_TICKS:
 * Windows timers fire every 15.6 ms rather than every 10, so 500 ticks there take about eight seconds.
 */
const MIN_SCENARIO_MS = 10_000;

const COLS = 120;
const ROWS = 40;
/** Turns of four entries in the resumed transcript: 10,400 entries. */
const RESUMED_TURNS = 2_600;
const RESUMED_SESSION_ID = "01900000-0000-7000-8000-000000000001";

/**
 * Starting the CLI and its engine: about 2 s with the extension cache warm and 3 s cold on an idle Linux machine;
 * Windows and a loaded runner take several times that.
 */
const STARTUP_BUDGET_MS = 60_000;
/** The longest scenario (subagents) takes about 20 s idle. */
const SCENARIO_BUDGET_MS = 90_000;
/** Quitting: the engine's session shutdown and both processes' exit records. */
const EXIT_BUDGET_MS = 30_000;
/** A real CLI and engine through a pseudo-terminal: startup, the scenario and exit, each within its own budget. */
const SCENARIO_TIMEOUT_MS = STARTUP_BUDGET_MS + SCENARIO_BUDGET_MS + EXIT_BUDGET_MS + 10_000;
const LOG_POLL_MS = 100;
/** How long the provider must be idle before a scenario that waits on model replies counts as settled. */
const PROVIDER_QUIET_MS = 2_000;

let root: string;
let agentDir: string;
let packageDir: string;
let server: ScriptedChatServer;
/** The last prompt of every provider request, for failure messages. */
const prompts: string[] = [];

beforeAll(async () => {
	root = makeTempDirectory("atomic-event-loop-guard-");
	agentDir = join(root, "agent");
	packageDir = join(root, "package");
	prepareInstalledPackage(PACKAGE, packageDir);
	server = await startScriptedChatServer((request): GuardReply => {
		const reply = guardReply(request);
		const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
		prompts.push(`${reply.label}: ${messageText(lastUser).slice(0, 200)}`);
		return reply;
	});
	prepareAgentDir(agentDir, server.baseUrl);
	writeLargeSession(join(root, "sessions"), join(root, "project-resume"), RESUMED_SESSION_ID, RESUMED_TURNS);
});

afterAll(async () => {
	await server?.close();
	await removeTempRootReleasingBroker(root, agentDir);
});

async function waitForRecords(
	path: string,
	ready: (records: readonly LogRecord[]) => boolean,
	timeoutMs: number,
	what: string,
	program: PtyProgram,
): Promise<LogRecord[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const records = readRecords(path);
		if (ready(records)) return records;
		if (Date.now() >= deadline) {
			throw new Error(
				`No ${what} within ${timeoutMs} ms.\nLog:\n${JSON.stringify(records)}\nScreen:\n${program.screen()}`,
			);
		}
		await sleep(LOG_POLL_MS);
	}
}

const bothWrote = (phase: Phase) => (records: readonly LogRecord[]) =>
	delayOf(records, "host", phase) !== undefined && delayOf(records, "engine", phase) !== undefined;

interface ScenarioResult {
	readonly name: string;
	readonly delays: Readonly<Record<ProcessRole, Readonly<Record<Phase, DelayRecord>>>>;
	readonly blocks: readonly BlockRecord[];
}

async function runScenario(
	name: string,
	options: { readonly args?: readonly string[]; readonly cwd?: string },
	drive: (program: PtyProgram) => Promise<void>,
): Promise<ScenarioResult> {
	const log = join(root, `${name}.jsonl`);
	const cwd = options.cwd ?? join(root, `project-${name}`);
	mkdirSync(cwd, { recursive: true });
	const program = startPtyProgram({
		executable: process.execPath,
		args: [CLI, ...(options.args ?? [])],
		cwd,
		env: {
			ATOMIC_CODING_AGENT_DIR: agentDir,
			ATOMIC_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
			ATOMIC_EVENT_LOOP_BLOCK_MS: String(BLOCK_THRESHOLD_MS),
			ATOMIC_EVENT_LOOP_BLOCK_LOG: log,
			ATOMIC_OFFLINE: "1",
			ATOMIC_PACKAGE_DIR: packageDir,
			ATOMIC_SKIP_VERSION_CHECK: "1",
			ATOMIC_TELEMETRY: "0",
			CI: "0",
			// Vitest's NODE_ENV=test would put workflow stages and subagents on their test sessions.
			NODE_ENV: "",
			NODE_OPTIONS: "",
			TERM: "xterm-256color",
		},
		timeoutMs: SCENARIO_TIMEOUT_MS,
		cols: COLS,
		rows: ROWS,
	});
	try {
		await waitForRecords(log, bothWrote("startup"), STARTUP_BUDGET_MS, `${name}: host and engine ready`, program);
		await program.waitForScreen((screen) => screen.includes("❯"), STARTUP_BUDGET_MS, "the editor");
		const drivenAt = Date.now();
		await drive(program);
		await sleep(Math.max(0, MIN_SCENARIO_MS - (Date.now() - drivenAt)));
		program.write("/quit");
		await sleep(200);
		program.write("\r");
		await program.exited;
		const records = await waitForRecords(log, bothWrote("session"), EXIT_BUDGET_MS, `${name}: exit records`, program);
		const delays = (role: ProcessRole) => ({
			startup: delayOf(records, role, "startup") as DelayRecord,
			session: delayOf(records, role, "session") as DelayRecord,
		});
		const result: ScenarioResult = {
			name,
			delays: { host: delays("host"), engine: delays("engine") },
			blocks: records.filter((record): record is BlockRecord => record.type === "block"),
		};
		// Measurement runs collect every scenario's numbers here.
		const report = process.env.EVENT_LOOP_GUARD_REPORT;
		if (report) appendFileSync(report, `${JSON.stringify({ platform: process.platform, ...result })}\n`);
		return result;
	} finally {
		program.kill();
	}
}

/** Fails naming every budget a scenario broke, with the blocks of that process and phase and their stacks. */
function assertWithinBudgets(result: ScenarioResult): void {
	const violations: string[] = [];
	const check = (role: ProcessRole, phase: Phase, p99BudgetMs: number | undefined, maxBudgetMs: number) => {
		const delay = result.delays[role][phase];
		const broken = [
			p99BudgetMs !== undefined && !(delay.p99Ms < p99BudgetMs) ? `p99 ${delay.p99Ms} ms ≥ ${p99BudgetMs} ms` : "",
			!(delay.maxMs < maxBudgetMs) ? `max ${delay.maxMs} ms ≥ ${maxBudgetMs} ms` : "",
		].filter(Boolean);
		if (broken.length === 0) return;
		const sessionAt = result.delays[role].session.at;
		const blocks = result.blocks.filter(
			(block) => block.role === role && (phase === "session") === block.at >= sessionAt,
		);
		violations.push(
			`${result.name}: ${role} ${phase} ${broken.join(", ")} (p50 ${delay.p50Ms} ms, ${delay.ticks} ticks over ${delay.durationMs} ms)`,
			...blocks.map((block) => `  ${describeBlock(block)}`),
		);
	};
	// The host's startup has too few ticks for a p99; a stall there still shows in its max.
	check("host", "startup", undefined, HOST_LOOP_DELAY_MAX_BUDGET_MS);
	check("host", "session", HOST_LOOP_DELAY_P99_BUDGET_MS, HOST_LOOP_DELAY_MAX_BUDGET_MS);
	check("engine", "session", ENGINE_LOOP_DELAY_P99_BUDGET_MS, ENGINE_LOOP_DELAY_MAX_BUDGET_MS);
	if (violations.length > 0) {
		const engineStartup = result.delays.engine.startup;
		violations.push(`(engine startup, not budgeted: p99 ${engineStartup.p99Ms} ms, max ${engineStartup.maxMs} ms)`);
		assert.fail(violations.join("\n"));
	}
	for (const role of ["host", "engine"] as const) {
		const { ticks } = result.delays[role].session;
		assert.ok(
			ticks >= MIN_SESSION_TICKS,
			`${result.name}: ${role} session had ${ticks} ticks, under ${MIN_SESSION_TICKS}`,
		);
	}
}

async function typeText(program: PtyProgram, text: string, intervalMs: number): Promise<void> {
	for (const character of text) {
		program.write(character);
		await sleep(intervalMs);
	}
}

async function press(program: PtyProgram, key: string, times: number, intervalMs: number): Promise<void> {
	for (let index = 0; index < times; index++) {
		program.write(key);
		await sleep(intervalMs);
	}
}

/** Waits for `count` more replies labelled `label` from `from` on, then for the provider to stay idle a while. */
async function waitForReplies(
	program: PtyProgram,
	label: GuardReply["label"],
	count: number,
	from: number,
): Promise<void> {
	const deadline = Date.now() + SCENARIO_BUDGET_MS;
	const seen = () => server.completed.slice(from).filter((completed) => completed === label).length;
	while (seen() < count) {
		if (Date.now() >= deadline) {
			assert.fail(
				`${seen()} of ${count} ${label} replies within ${SCENARIO_BUDGET_MS} ms. Prompts:\n${prompts.join("\n")}\nScreen:\n${program.screen()}`,
			);
		}
		await sleep(LOG_POLL_MS);
	}
	let quietSince = Date.now();
	let completed = server.completed.length;
	while (Date.now() - quietSince < PROVIDER_QUIET_MS) {
		if (server.completed.length !== completed || server.streaming() > 0) {
			completed = server.completed.length;
			quietSince = Date.now();
		}
		if (Date.now() >= deadline) assert.fail(`The provider was still busy after ${SCENARIO_BUDGET_MS} ms`);
		await sleep(LOG_POLL_MS);
	}
}

const KEY = {
	left: "\x1b[D",
	end: "\x1b[F",
	backspace: "\x7f",
	deleteWordBackward: "\x17",
	clearLine: "\x15",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	transcriptTop: "\x1b[1;5H",
	transcriptBottom: "\x1b[1;5F",
	wheelUp: `\x1b[<64;${COLS / 2};${ROWS / 2}M`,
	wheelDown: `\x1b[<65;${COLS / 2};${ROWS / 2}M`,
} as const;

/** Keystrokes 15 ms apart: a fast typist. */
const TYPING_INTERVAL_MS = 15;

describe("the interactive host and engine keep their event loops responsive", () => {
	test(
		"while the user types and edits",
		async () => {
			const result = await runScenario("typing", {}, async (program) => {
				await typeText(
					program,
					"Refactor the session loader so that resume reads entries lazily",
					TYPING_INTERVAL_MS,
				);
				await press(program, KEY.left, 10, TYPING_INTERVAL_MS);
				await typeText(program, " incrementally", TYPING_INTERVAL_MS);
				await press(program, KEY.deleteWordBackward, 2, TYPING_INTERVAL_MS);
				await typeText(program, "and then report back with the numbers", TYPING_INTERVAL_MS);
				program.write(KEY.end);
				await press(program, KEY.backspace, 20, TYPING_INTERVAL_MS);
				await typeText(program, "with measurements", TYPING_INTERVAL_MS);
				await sleep(500);
				program.write(KEY.clearLine);
			});
			assertWithinBudgets(result);
		},
		SCENARIO_TIMEOUT_MS,
	);

	test(
		"while an answer streams and the user types ahead and pages",
		async () => {
			const from = server.completed.length;
			const result = await runScenario("streaming", {}, async (program) => {
				await typeText(program, `${STREAM_MARKER} explain the change`, TYPING_INTERVAL_MS);
				program.write("\r");
				await sleep(1_000);
				await typeText(program, "next: summarize the risks", TYPING_INTERVAL_MS * 2);
				await press(program, KEY.pageUp, 3, 100);
				await press(program, KEY.pageDown, 3, 100);
				await waitForReplies(program, "stream", 1, from);
				program.write(KEY.transcriptBottom);
				await program.waitForScreen(
					(screen) => screen.includes(`${STREAM_MARKER}-END`),
					10_000,
					"the answer's end",
				);
				program.write(KEY.clearLine);
			});
			assertWithinBudgets(result);
		},
		SCENARIO_TIMEOUT_MS,
	);

	test(
		"while a workflow runs its stages",
		async () => {
			const from = server.completed.length;
			const result = await runScenario("workflow", {}, async (program) => {
				await typeText(program, `/workflow ${GUARD_WORKFLOW}`, TYPING_INTERVAL_MS);
				await sleep(300);
				program.write("\r");
				await waitForReplies(program, "stage", GUARD_WORKFLOW_STAGES, from);
			});
			assertWithinBudgets(result);
		},
		SCENARIO_TIMEOUT_MS,
	);

	test(
		"while subagents run",
		async () => {
			const from = server.completed.length;
			const result = await runScenario("subagents", {}, async (program) => {
				await typeText(program, `${SUBAGENTS_MARKER} fan out the review`, TYPING_INTERVAL_MS);
				program.write("\r");
				await waitForReplies(program, "child", 4, from);
				await waitForReplies(program, "parent-final", 1, from);
			});
			assertWithinBudgets(result);
		},
		SCENARIO_TIMEOUT_MS,
	);

	test(
		`while the user pages through a resumed transcript of ${RESUMED_TURNS * 4} entries`,
		async () => {
			const result = await runScenario(
				"resume",
				{ args: ["--session", RESUMED_SESSION_ID], cwd: join(root, "project-resume") },
				async (program) => {
					await press(program, KEY.pageUp, 30, 50);
					program.write(KEY.transcriptTop);
					await sleep(500);
					await press(program, KEY.pageDown, 30, 50);
					await press(program, KEY.wheelUp, 30, 30);
					await press(program, KEY.wheelDown, 30, 30);
					program.write(KEY.transcriptBottom);
				},
			);
			assertWithinBudgets(result);
		},
		SCENARIO_TIMEOUT_MS,
	);
});
