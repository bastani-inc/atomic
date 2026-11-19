import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { OWNED_ELSEWHERE } from "../../scripts/event-loop/policy.ts";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import {
	type BlockRecord,
	blockOwner,
	type DelayRecord,
	delayOf,
	describeBlock,
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
	WORKFLOW_MARKER,
	writeLargeSession,
} from "../helpers/event-loop-guard-fixture.js";
import { LAG_TAIL_SAMPLES } from "../helpers/event-loop-lag.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir, sleep } from "../helpers/runtime.js";
import { messageText, type ScriptedChatServer, startScriptedChatServer } from "../helpers/scripted-chat-server.js";

const ROOT = join(moduleDir(import.meta.url), "../..");
const PACKAGE = join(ROOT, "packages/coding-agent");
const CLI = join(PACKAGE, "dist/cli.js");

const HOST_LOOP_DELAY_P99_BUDGET_MS = 50;
const HOST_LOOP_DELAY_MAX_BUDGET_MS = 150;
const ENGINE_LOOP_DELAY_P99_BUDGET_MS = 50;
const ENGINE_LOOP_DELAY_MAX_BUDGET_MS = 250;
const BLOCK_THRESHOLD_MS = Math.min(HOST_LOOP_DELAY_MAX_BUDGET_MS, ENGINE_LOOP_DELAY_MAX_BUDGET_MS);
const MIN_SESSION_TICKS = 100 * LAG_TAIL_SAMPLES;
const MIN_SCENARIO_MS = 10_000;

const COLS = 120;
const ROWS = 40;
const RESUMED_TURNS = 2_600;
const RESUMED_SESSION_ID = "01900000-0000-7000-8000-000000000001";

const STARTUP_BUDGET_MS = 60_000;
const SCENARIO_BUDGET_MS = 90_000;
const EXIT_BUDGET_MS = 30_000;
const SCENARIO_TIMEOUT_MS = STARTUP_BUDGET_MS + SCENARIO_BUDGET_MS + EXIT_BUDGET_MS + 10_000;
const LOG_POLL_MS = 100;
const EDITOR_SETTLE_MS = 500;
const PROVIDER_QUIET_MS = 2_000;

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

const TYPING_INTERVAL_MS = 15;

let root: string;
let agentDir: string;
let packageDir: string;
let server: ScriptedChatServer;
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

const bothReady = (records: readonly LogRecord[]) =>
	delayOf(records, "host", "startup") !== undefined && delayOf(records, "engine", "startup") !== undefined;
const quitRecorded = (records: readonly LogRecord[]) =>
	delayOf(records, "host", "shutdown") !== undefined && delayOf(records, "engine", "session") !== undefined;

interface ProcessDelays {
	readonly startup: DelayRecord;
	readonly session: DelayRecord;
	readonly shutdown: DelayRecord | undefined;
}

interface ScenarioResult {
	readonly name: string;
	readonly delays: Readonly<Record<ProcessRole, ProcessDelays>>;
	readonly blocks: readonly BlockRecord[];
}

function phaseOf(block: BlockRecord, delays: ProcessDelays): Phase {
	const start = Date.parse(block.at);
	if (delays.shutdown !== undefined && start >= Date.parse(delays.shutdown.at)) return "shutdown";
	return start >= Date.parse(delays.session.at) ? "session" : "startup";
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
			// Measure normal responsiveness without a debugger pausing the process being measured.
			ATOMIC_EVENT_LOOP_BLOCK_STACKS: "0",
			ATOMIC_OFFLINE: "1",
			ATOMIC_PACKAGE_DIR: packageDir,
			ATOMIC_SKIP_VERSION_CHECK: "1",
			ATOMIC_TELEMETRY: "0",
			CI: "0",
			NODE_ENV: "",
			NODE_OPTIONS: "",
			TERM: "xterm-256color",
		},
		timeoutMs: SCENARIO_TIMEOUT_MS,
		cols: COLS,
		rows: ROWS,
	});
	try {
		await waitForRecords(log, bothReady, STARTUP_BUDGET_MS, `${name}: host and engine ready`, program);
		await program.waitForScreen((screen) => screen.includes("❯"), STARTUP_BUDGET_MS, "the editor");
		await sleep(EDITOR_SETTLE_MS);
		program.write(KEY.clearLine);
		const drivenAt = Date.now();
		await drive(program);
		await sleep(Math.max(0, MIN_SCENARIO_MS - (Date.now() - drivenAt)));
		program.write(KEY.clearLine);
		await typeText(program, "/quit", TYPING_INTERVAL_MS);
		await sleep(200);
		program.write("\r");
		const exited = await Promise.race([program.exited, sleep(EXIT_BUDGET_MS).then(() => undefined)]);
		if (exited === undefined)
			assert.fail(`${name}: still running ${EXIT_BUDGET_MS} ms after /quit. Screen:\n${program.screen()}`);
		const records = await waitForRecords(log, quitRecorded, EXIT_BUDGET_MS, `${name}: quit records`, program);
		for (const role of ["host", "engine"] as const) {
			const started = records.find((record) => record.type === "start" && record.role === role);
			assert.ok(started?.type === "start");
			assert.equal(started.stacks, "disabled", `${name}: ${role} must not use an intrusive stack sampler`);
		}
		const delays = (role: ProcessRole): ProcessDelays => ({
			startup: delayOf(records, role, "startup") as DelayRecord,
			session: delayOf(records, role, "session") as DelayRecord,
			shutdown: delayOf(records, role, "shutdown"),
		});
		const result: ScenarioResult = {
			name,
			delays: { host: delays("host"), engine: delays("engine") },
			blocks: records.filter((record): record is BlockRecord => record.type === "block"),
		};
		const report = process.env.EVENT_LOOP_GUARD_REPORT;
		if (report) appendFileSync(report, `${JSON.stringify({ platform: process.platform, ...result })}\n`);
		return result;
	} finally {
		program.kill();
	}
}

function assertWithinBudgets(result: ScenarioResult): void {
	const violations: string[] = [];
	const deferred: string[] = [];
	const check = (
		role: ProcessRole,
		phase: "startup" | "session",
		p99BudgetMs: number | undefined,
		maxBudgetMs: number,
	) => {
		const delays = result.delays[role];
		const delay = delays[phase];
		const broken = [
			p99BudgetMs !== undefined && !(delay.p99Ms < p99BudgetMs) ? `p99 ${delay.p99Ms} ms ≥ ${p99BudgetMs} ms` : "",
			!(delay.maxMs < maxBudgetMs) ? `max ${delay.maxMs} ms ≥ ${maxBudgetMs} ms` : "",
		].filter(Boolean);
		if (broken.length === 0) return;
		const blocks = result.blocks.filter((block) => block.role === role && phaseOf(block, delays) === phase);
		const overMax = blocks.filter((block) => block.durationMs >= maxBudgetMs);
		const owners = overMax.map((block) => blockOwner(block, OWNED_ELSEWHERE));
		const onlyMaxBroken = p99BudgetMs === undefined || delay.p99Ms < p99BudgetMs;
		if (onlyMaxBroken && overMax.length > 0 && owners.every((owner) => owner !== undefined)) {
			deferred.push(
				`${result.name}: ${role} ${phase} max ${delay.maxMs} ms, every block over ${maxBudgetMs} ms in code owned by ${[...new Set(owners)].join(", ")}`,
			);
			return;
		}
		violations.push(
			`${result.name}: ${role} ${phase} ${broken.join(", ")} (p50 ${delay.p50Ms} ms, ${delay.ticks} ticks over ${delay.durationMs} ms)`,
			...blocks.map((block) => `  ${describeBlock(block)}`),
		);
	};
	check("host", "session", HOST_LOOP_DELAY_P99_BUDGET_MS, HOST_LOOP_DELAY_MAX_BUDGET_MS);
	check("engine", "session", ENGINE_LOOP_DELAY_P99_BUDGET_MS, ENGINE_LOOP_DELAY_MAX_BUDGET_MS);
	if (violations.length > 0) {
		const unbudgeted = (role: ProcessRole, phase: Phase) => {
			const delay = result.delays[role][phase];
			return delay === undefined ? [] : [`${role} ${phase}: p99 ${delay.p99Ms} ms, max ${delay.maxMs} ms`];
		};
		const notes = [
			...unbudgeted("host", "startup"),
			...unbudgeted("engine", "startup"),
			...unbudgeted("host", "shutdown"),
			...unbudgeted("engine", "shutdown"),
		];
		violations.push(`(not budgeted: ${notes.join("; ")})`);
		assert.fail([...violations, ...deferred].join("\n"));
	}
	if (deferred.length > 0) console.warn(deferred.join("\n"));
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
				await program.waitForScreen(
					(screen) => screen.includes("Refactor the session loader") && screen.includes("with measurements"),
					10_000,
					"the edited prompt",
				);
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
				await typeText(program, `${WORKFLOW_MARKER} run the guard workflow`, TYPING_INTERVAL_MS);
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
					await program.waitForScreen(
						(screen) => screen.includes(`case-${RESUMED_TURNS - 1}`),
						10_000,
						"the resumed transcript's tail",
					);
					await press(program, KEY.pageUp, 30, 50);
					program.write(KEY.transcriptTop);
					await program.waitForScreen(
						(screen) => screen.includes("Turn 0:"),
						10_000,
						"the resumed transcript's top",
					);
					await press(program, KEY.pageDown, 30, 50);
					await press(program, KEY.wheelUp, 30, 30);
					await press(program, KEY.wheelDown, 30, 30);
					program.write(KEY.transcriptBottom);
					await program.waitForScreen(
						(screen) => screen.includes(`case-${RESUMED_TURNS - 1}`),
						10_000,
						"the resumed transcript's bottom",
					);
				},
			);
			assertWithinBudgets(result);
		},
		SCENARIO_TIMEOUT_MS,
	);
});
