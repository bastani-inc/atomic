import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultJournalStoreDirectory } from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";
import { parseArgs } from "../../packages/coding-agent/src/cli/args.js";
import { parseStorageCommand, runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import { ENV_AGENT_DIR } from "../../packages/coding-agent/src/config.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { consolidateJournalStore } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { JournalCatalog } from "../../packages/coding-agent/src/core/storage/journal-catalog.js";
import type { SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { createSessionManager } from "../../packages/coding-agent/src/main-session.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { ShardedRunJournal } from "../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { JournalEntry, RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import {
	prepareTargetedDurableResumable,
	resumeDurableWorkflow,
} from "../../packages/workflows/src/durable/resume-runtime.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * Runs `hook` once, the first time a database file is opened for writing while it is set: an import opens the journal
 * files it writes to only after it compared every run, so this is where another process can step in, deterministically.
 */
const sqlite = vi.hoisted(() => ({ onWritableOpen: undefined as ((path: string) => Promise<void>) | undefined }));
vi.mock("../../packages/coding-agent/src/core/storage/node-sqlite.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../packages/coding-agent/src/core/storage/node-sqlite.js")>();
	return {
		...actual,
		openNodeSqliteDatabase: async (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
			const hook = sqlite.onWritableOpen;
			if (hook !== undefined && args[1]?.readOnly !== true) await hook(resolve(args[0]));
			return actual.openNodeSqliteDatabase(...args);
		},
	};
});

const STORAGE_VARIABLES = [
	"ATOMIC_STORAGE",
	"ATOMIC_SESSIONS_STORAGE",
	"ATOMIC_WORKFLOWS_JOURNAL",
	"ATOMIC_CODING_AGENT_SESSION_DIR",
	"ATOMIC_WORKFLOW_JOURNAL_PATH",
	"ATOMIC_PROFILE",
];
const SECRET = "ghp_supersecrettoken";

let root: string;
let project: string;
let exports: string;
const closing: (() => Promise<void>)[] = [];

beforeEach(() => {
	for (const name of STORAGE_VARIABLES) vi.stubEnv(name, "");
	root = makeTempDirectory("storage-transfer-");
	project = join(root, "project");
	exports = join(root, "drive", "state");
	mkdirSync(project, { recursive: true });
});
afterEach(async () => {
	sqlite.onWritableOpen = undefined;
	vi.restoreAllMocks();
	for (const close of closing.splice(0).reverse()) await close().catch(() => {});
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

function machine(name: string): string {
	const agentDir = join(root, name, "agent");
	mkdirSync(agentDir, { recursive: true });
	return agentDir;
}

async function storage(agentDir: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runStorageCommand(args, {
		cwd: project,
		agentDir,
		log: (line) => out.push(line),
		error: (line) => err.push(line),
		loadControl: async () => {
			throw new Error("no broker in this test");
		},
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

async function sessionStore(agentDir: string): Promise<SessionStore> {
	const store = await resolveSessionStore(project, { agentDir });
	closing.push(() => store.close());
	return store;
}

/** A session in the agent directory's default session storage, with a tool output kept as a blob. */
async function recordSession(agentDir: string, texts: readonly string[]): Promise<string> {
	const store = await resolveSessionStore(project, { agentDir });
	try {
		const manager = await SessionManager.create(store, project);
		for (const text of texts) await manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		await manager.appendToolOutputBlob("call-1", Buffer.from(`tool output for ${texts[0]}`));
		return manager.getSessionId();
	} finally {
		await store.close();
	}
}

async function appendToSession(agentDir: string, sessionId: string, text: string): Promise<void> {
	const store = await resolveSessionStore(project, { agentDir });
	try {
		const manager = await SessionManager.open(store, sessionId);
		await manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	} finally {
		await store.close();
	}
}

async function sessionEntries(agentDir: string, sessionId: string): Promise<number> {
	const store = await resolveSessionStore(project, { agentDir });
	try {
		return (await store.load(sessionId)).entries.length;
	} finally {
		await store.close();
	}
}

async function openStore(agentDir: string): Promise<ShardedRunJournal> {
	const journal = await ShardedRunJournal.open({
		directory: defaultJournalStoreDirectory(agentDir),
		openShard: (path) => openSqlRunJournal(path),
	});
	closing.push(() => journal.close());
	return journal;
}

async function record(journal: RunJournal, runId: string, status: string, createdAt: number, from = 0, to = 2) {
	if (from === 0)
		await journal.createRun({
			runId,
			name: "transfer",
			cwd: "/project",
			createdAt,
			status: "running",
			inputs: { token: SECRET },
		});
	const outcome = await journal.acquire(runId, "holder-on-machine-a");
	assert.equal(outcome.status, "acquired");
	if (outcome.status !== "acquired") return;
	for (let index = from; index < to; index++)
		await journal.append(
			outcome.lease,
			{ type: "CheckpointRecorded", payload: { kind: "tool", checkpointId: `step-${index}`, output: SECRET } },
			{ key: JSON.stringify(["CheckpointRecorded", "tool", `step-${index}`]) },
		);
	await journal.append(outcome.lease, { type: "StatusChanged", payload: { status } });
	await journal.release(outcome.lease);
}

async function seedRuns(agentDir: string, runs: readonly [string, string, number][]): Promise<void> {
	const journal = await ShardedRunJournal.open({
		directory: defaultJournalStoreDirectory(agentDir),
		openShard: (path) => openSqlRunJournal(path),
	});
	try {
		for (const [runId, status, createdAt] of runs) await record(journal, runId, status, createdAt);
	} finally {
		await journal.close();
	}
}

async function runEntries(journal: RunJournal, runId: string): Promise<JournalEntry[]> {
	const read: JournalEntry[] = [];
	for await (const entry of journal.read(runId)) read.push(entry);
	return read;
}

function files(directory: string): Record<string, string> {
	if (!existsSync(directory)) return {};
	return Object.fromEntries(
		readdirSync(directory)
			.sort()
			.map((name) => [name, readFileSync(join(directory, name), "utf8")]),
	);
}

/** Every file of an export directory, by its path relative to it. */
function tree(directory: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const kind of ["sessions", "workflows"])
		for (const [name, content] of Object.entries(files(join(directory, kind)))) result[`${kind}/${name}`] = content;
	return result;
}

async function shardPathOf(agentDir: string, runId: string): Promise<string> {
	const catalog = await JournalCatalog.open(defaultJournalStoreDirectory(agentDir));
	try {
		return resolve((await catalog.locate(runId))!.shard.path);
	} finally {
		await catalog.close();
	}
}

const RUN_A = testRunId("state-a");
const RUN_B = testRunId("state-b");

test("storage export and import parse --sessions, --workflows and --since (#4720)", () => {
	assert.deepEqual(parseStorageCommand(["export", "out", "--sessions", "--since", "2026-11-01", "--limit", "2"]), {
		kind: "export",
		directory: "out",
		kinds: { sessions: true, workflows: false, explicit: true },
		unfinished: false,
		limit: 2,
		since: Date.parse("2026-11-01"),
	});
	assert.deepEqual(parseStorageCommand(["import", "in", "--workflows"]), {
		kind: "import",
		directory: "in",
		kinds: { sessions: false, workflows: true, explicit: true },
	});
	assert.deepEqual(parseStorageCommand(["export", "out", "--sessions", "--workflows"]).kind, "export");
	for (const args of [
		["export", "out", "--since", "yesterday"],
		["export", "out", "--sessions", "--run", "a"],
		["export", "out", "--sessions", "--unfinished"],
		["export", "out", "--workflows", "--since", "2026-11-01"],
		["import", "in", "--run", "a"],
	])
		assert.throws(() => parseStorageCommand(args));
});

test("sessions and workflow runs export to sessions/ and workflows/, import into a fresh agent directory and re-export byte for byte (#4720)", async () => {
	const source = machine("a");
	const sessionId = await recordSession(source, ["hello", `my token is ${SECRET}`]);
	await seedRuns(source, [
		[RUN_A, "completed", 1_000],
		[RUN_B, "paused", 2_000],
	]);
	const exported = await storage(source, ["export", exports]);
	assert.equal(exported.code, 0, exported.err);
	assert.match(exported.out, /Exported 1 session to .*sessions \(1 written, 0 unchanged\)/);
	assert.match(exported.out, /Exported 2 workflow runs to .*workflows \(2 written, 0 unchanged\)/);
	const before = tree(exports);
	assert.deepEqual(
		Object.keys(before).sort(),
		[`sessions/${sessionId}.jsonl`, `workflows/${RUN_A}.jsonl`, `workflows/${RUN_B}.jsonl`].sort(),
	);
	const lines = before[`sessions/${sessionId}.jsonl`]!.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual([lines[0].type, lines[0].version, lines[0].id], ["session", 4, sessionId]);
	assert.equal(lines.at(-1).data.base64, Buffer.from("tool output for hello").toString("base64"));
	assert.match((await storage(source, ["export", exports])).out, /1 session .*\(0 written, 1 unchanged\)/);

	// The session file is the format `atomic --import` reads.
	const viaImportFlag = machine("flag");
	const flagStore = await sessionStore(viaImportFlag);
	const flagged = await SessionManager.importFromJsonl(
		join(exports, "sessions", `${sessionId}.jsonl`),
		project,
		flagStore,
	);
	assert.equal(flagged.getEntries().length, lines.length - 1);

	const target = machine("b");
	const imported = await storage(target, ["import", exports]);
	assert.equal(imported.code, 0, imported.err);
	assert.match(imported.out, /Imported 1 session from .* \(1 added, 0 updated, 0 already up to date\)/);
	assert.match(imported.out, /Imported 2 workflow runs from .* \(2 added, 0 updated, 0 already up to date\)/);
	const again = join(root, "re-export");
	assert.equal((await storage(target, ["export", again])).code, 0);
	assert.deepEqual(tree(again), before, "the imported sessions and runs export to the same bytes");
});

test("export selects kinds with --sessions and --workflows, and sessions with --limit and --since (#4720)", async () => {
	const source = machine("a");
	const older = await recordSession(source, ["older"]);
	await sleep(20);
	const cutoff = new Date().toISOString();
	await sleep(20);
	const newer = await recordSession(source, ["newer"]);
	await seedRuns(source, [
		[RUN_A, "completed", 1_000],
		[RUN_B, "paused", 2_000],
	]);
	const select = async (name: string, args: string[]) => {
		const directory = join(root, name);
		const result = await storage(source, ["export", directory, ...args]);
		assert.equal(result.code, 0, result.err);
		return Object.keys(tree(directory)).map((file) => file.replace(".jsonl", ""));
	};
	assert.deepEqual(await select("sessions", ["--sessions"]), [`sessions/${newer}`, `sessions/${older}`].sort());
	assert.deepEqual(await select("workflows", ["--workflows"]), [`workflows/${RUN_A}`, `workflows/${RUN_B}`].sort());
	assert.deepEqual(await select("limit", ["--limit", "1"]), [`sessions/${newer}`, `workflows/${RUN_B}`]);
	assert.deepEqual(await select("since", ["--sessions", "--since", cutoff]), [`sessions/${newer}`]);
	assert.deepEqual(
		await select("run", ["--run", RUN_A]),
		[`sessions/${newer}`, `sessions/${older}`, `workflows/${RUN_A}`].sort(),
	);

	// Import restores only the kinds asked for.
	const all = join(root, "all");
	await storage(source, ["export", all]);
	const target = machine("b");
	const imported = await storage(target, ["import", all, "--workflows"]);
	assert.equal(imported.code, 0, imported.err);
	assert.doesNotMatch(imported.out, /session/);
	assert.equal(await (await sessionStore(target)).readHeader(newer), undefined);
	assert.ok(await (await openStore(target)).getRun(RUN_A));
});

test("importing sessions again adds nothing, a newer export appends the entries a session lacks, and a diverged session is refused with its file and line (#4720)", async () => {
	const source = machine("a");
	const sessionId = await recordSession(source, ["one", "two"]);
	await storage(source, ["export", exports, "--sessions"]);
	const target = machine("b");
	assert.match((await storage(target, ["import", exports])).out, /1 session .*\(1 added/);
	assert.match((await storage(target, ["import", exports])).out, /1 session .*1 already up to date/);
	const first = await sessionEntries(target, sessionId);

	await appendToSession(source, sessionId, "three");
	await storage(source, ["export", exports, "--sessions"]);
	assert.match((await storage(target, ["import", exports])).out, /1 session .*\(0 added, 1 updated/);
	assert.equal(await sessionEntries(target, sessionId), first + 1);
	assert.match((await storage(target, ["import", exports])).out, /1 already up to date/);
	assert.equal(await sessionEntries(target, sessionId), first + 1, "no duplicate entries");

	// The target continues the session differently; the source's next export is refused there.
	await appendToSession(target, sessionId, "four here");
	await appendToSession(source, sessionId, "four there");
	await appendToSession(source, sessionId, "five there");
	await storage(source, ["export", exports, "--sessions"]);
	const diverged = await storage(target, ["import", exports]);
	assert.equal(diverged.code, 1);
	const file = join(exports, "sessions", `${sessionId}.jsonl`);
	assert.ok(diverged.err.includes(`${file}:${first + 3}: entry ${first + 2} differs`), diverged.err);
	assert.match(diverged.err, /the session continued differently there\nNothing was imported\./);
	assert.equal(await sessionEntries(target, sessionId), first + 2);
});

test("session and workflow files whose strings a tool redacted import as what they came from (#4720)", async () => {
	const source = machine("a");
	const sessionId = await recordSession(source, [`my token is ${SECRET}`]);
	await seedRuns(source, [[RUN_A, "paused", 1_000]]);
	await storage(source, ["export", exports]);
	// What gh-aw's redaction does: replace each secret substring, line by line, keeping every line a JSON object.
	const redacted: Record<string, string> = {};
	for (const [name, content] of Object.entries(tree(exports))) {
		redacted[name] = content.replaceAll(SECRET, "***");
		writeFileSync(join(exports, name), redacted[name]!);
	}
	assert.ok(!Object.values(redacted).some((content) => content.includes(SECRET)));

	const target = machine("b");
	const imported = await storage(target, ["import", exports]);
	assert.equal(imported.code, 0, imported.err);
	const restored = await (await sessionStore(target)).load(sessionId);
	assert.deepEqual(
		restored.entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
		),
		["my token is ***"],
	);
	// The source still holds the unredacted session and run: the redacted files are the same ones, so up to date.
	const back = await storage(source, ["import", exports]);
	assert.match(back.out, /1 session .*1 already up to date/);
	assert.match(back.out, /1 workflow run .*1 already up to date/);
	const again = join(root, "again");
	await storage(target, ["export", again]);
	assert.deepEqual(tree(again), redacted);
});

test("a malformed or unknown-version session file fails the import with its file and line, and nothing of either kind is imported (#4720)", async () => {
	const source = machine("a");
	const sessionId = await recordSession(source, ["hello"]);
	await seedRuns(source, [[RUN_A, "completed", 1_000]]);
	await storage(source, ["export", exports]);
	const file = join(exports, "sessions", `${sessionId}.jsonl`);
	const original = readFileSync(file, "utf8");
	const lines = original.trimEnd().split("\n");
	const header = JSON.parse(lines[0]!);
	const cases: readonly (readonly [string, RegExp])[] = [
		[`${lines[0]}\n{"type":"message",\n`, /\.jsonl:2: is not valid JSON/],
		[
			`${JSON.stringify({ ...header, version: 5 })}\n${lines.slice(1).join("\n")}\n`,
			/:1: has unsupported session format version 5; this Atomic reads version 4/,
		],
		[`${JSON.stringify({ ...header, type: "atomic.workflow-run" })}\n`, /:1: is not an Atomic session export/],
		[`${lines[0]}\n["not", "an", "object"]\n`, /:2: is not a JSON object/],
		[
			`${lines[0]}\n${lines
				.slice(1)
				.join("\n")
				.replace(/"base64":"[^"]+"/, '"base64":"AAAA"')}\n`,
			/does not match its hash/,
		],
	];
	// A file at the top level of the export directory is not read.
	writeFileSync(join(exports, `${RUN_A}.jsonl`), "not an export\n");
	const target = machine("b");
	for (const [content, message] of cases) {
		writeFileSync(file, content);
		const result = await storage(target, ["import", exports]);
		assert.equal(result.code, 1);
		assert.match(result.err, message);
		assert.ok(result.err.includes(file), result.err);
		assert.match(result.err, /Nothing was imported\./);
		assert.ok(!existsSync(defaultJournalStoreDirectory(target)), "the good workflow run was not imported either");
	}
	writeFileSync(file, original);
	const imported = await storage(target, ["import", exports]);
	assert.equal(imported.code, 0, imported.err);
	assert.match(imported.out, /1 session .*1 added[\s\S]*1 workflow run .*1 added/);
});

test("a lease another process takes after the import compared the runs fails the import before anything is written (#4720)", async () => {
	const source = machine("a");
	const sessionId = await recordSession(source, ["hello"]);
	await seedRuns(source, [
		[RUN_A, "paused", 1_000],
		[RUN_B, "paused", 2_000],
	]);
	await storage(source, ["export", exports, "--workflows"]);
	const target = machine("b");
	assert.equal((await storage(target, ["import", exports])).code, 0);
	const sourceJournal = await openStore(source);
	for (const runId of [RUN_A, RUN_B]) await record(sourceJournal, runId, "completed", 0, 2, 4);
	await storage(source, ["export", exports]);
	const targetJournal = await openStore(target);
	const before = { a: await runEntries(targetJournal, RUN_A), b: await runEntries(targetJournal, RUN_B) };

	// Between the comparison and the first write, a resume on this machine takes run B's lease.
	const shard = await shardPathOf(target, RUN_B);
	let taken: Awaited<ReturnType<RunJournal["acquire"]>> | undefined;
	sqlite.onWritableOpen = async (path) => {
		if (path !== shard) return;
		sqlite.onWritableOpen = undefined;
		taken = await targetJournal.acquire(RUN_B, "resume-on-machine-b");
	};
	const raced = await storage(target, ["import", exports]);
	assert.equal(taken?.status, "acquired", "the lease was taken during the import");
	assert.equal(raced.code, 1);
	assert.match(raced.err, new RegExp(`run ${RUN_B} changed in .* after the import compared it`));
	assert.match(raced.err, /Nothing was imported\./);
	assert.deepEqual(await runEntries(targetJournal, RUN_A), before.a, "run A was not written");
	assert.deepEqual(await runEntries(targetJournal, RUN_B), before.b, "run B was not written");
	assert.equal(await (await sessionStore(target)).readHeader(sessionId), undefined, "the session was not written");

	// Once the resume lets go of the run, the same import finishes the job.
	if (taken?.status === "acquired") await targetJournal.release(taken.lease);
	const finished = await storage(target, ["import", exports]);
	assert.equal(finished.code, 0, finished.err);
	assert.match(finished.out, /1 session .*1 added[\s\S]*2 workflow runs .*0 added, 2 updated/);
	for (const runId of [RUN_A, RUN_B])
		assert.deepEqual(await runEntries(targetJournal, runId), await runEntries(sourceJournal, runId));
});

test("an import that fails after writing part of it names exactly what it wrote, and a rerun finishes without duplicates (#4720)", async () => {
	const source = machine("a");
	const first = await recordSession(source, ["first"]);
	const second = await recordSession(source, ["second"]);
	await seedRuns(source, [[RUN_A, "completed", 1_000]]);
	await storage(source, ["export", exports]);
	const target = machine("b");
	const targetSessions = await sessionStore(target);
	// While the import writes the workflow run, another process imports one of the sessions on its own.
	const [early, late] = [first, second].sort();
	sqlite.onWritableOpen = async (path) => {
		if (!path.startsWith(resolve(defaultJournalStoreDirectory(target))) || path.endsWith("catalog.sqlite")) return;
		sqlite.onWritableOpen = undefined;
		await SessionManager.importFromJsonl(join(exports, "sessions", `${late}.jsonl`), project, targetSessions);
	};
	const partial = await storage(target, ["import", exports]);
	assert.equal(partial.code, 1);
	assert.match(partial.err, new RegExp(`session ${late} changed in .* after the import compared it`));
	assert.ok(
		partial.err.includes(`Imported before the failure: session ${early}; workflow run ${RUN_A}.`),
		partial.err,
	);
	assert.ok(partial.err.includes(`Not imported: session ${late}.`), partial.err);
	assert.match(partial.err, /Run the same import again to finish/);
	const counts = { early: await sessionEntries(target, early), late: await sessionEntries(target, late) };

	const rerun = await storage(target, ["import", exports]);
	assert.equal(rerun.code, 0, rerun.err);
	assert.match(rerun.out, /2 sessions .*\(0 added, 0 updated, 2 already up to date\)/);
	assert.match(rerun.out, /1 workflow run .*1 already up to date/);
	assert.deepEqual({ early: await sessionEntries(target, early), late: await sessionEntries(target, late) }, counts);
	assert.equal((await runEntries(await openStore(target), RUN_A)).length, 3);
});

test("a run that consolidate moves into a new shard while an export reads is exported, not reported as old-format (#4720)", async () => {
	const source = machine("a");
	const legacy = await openSqlRunJournal(join(root, "a", "workflows", "journal.sqlite"));
	await record(legacy, RUN_A, "completed", 1_000);
	await legacy.close();
	const store = defaultJournalStoreDirectory(source);
	const readRuns = JournalCatalog.prototype.runs;
	let moved: number | undefined;
	vi.spyOn(JournalCatalog.prototype, "runs").mockImplementation(async function (
		this: JournalCatalog,
		filter?: { readonly shard?: number },
	) {
		const listed = await readRuns.call(this, filter);
		// Between the export's catalog read and its read of the journal files, consolidate moves the finished run out
		// of the adopted journal into a shard it creates.
		if (moved === undefined) {
			moved = 0;
			moved = (await consolidateJournalStore(store)).moved;
		}
		return listed;
	});
	const exported = await storage(source, ["export", exports, "--workflows"]);
	assert.equal(moved, 1, "the run moved during the export");
	assert.equal(exported.code, 0, exported.err);
	assert.equal(exported.err, "", "nothing was skipped");
	assert.deepEqual(Object.keys(files(join(exports, "workflows"))), [`${RUN_A}.jsonl`]);
	const catalog = await JournalCatalog.open(store);
	closing.push(() => catalog.close());
	assert.equal((await catalog.locate(RUN_A))?.shard.kind, "native");
});

test("a session and an interrupted workflow exported from one agent directory continue in a fresh one (#4720)", async () => {
	const runId = testRunId("state-interrupted");
	const executions = { first: 0, second: 0 };
	let interrupt = true;
	let release = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const definition = workflow({
		name: "state-e2e",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("first", {}, async () => {
				executions.first++;
				return "one";
			});
			await ctx.tool("second", {}, async () => {
				executions.second++;
				if (interrupt) await blocked;
				return "two";
			});
			return {};
		},
	});
	const snapshots = { enabled: false, autoCollect: false };

	const machineA = machine("a");
	const sessionId = await recordSession(machineA, ["plan the release"]);
	const backendA = await JournalDurableBackend.open(await openStore(machineA), { ownsJournal: false });
	closing.push(() => backendA.close());
	const running = run(
		definition,
		{},
		{ runId, durableBackend: backendA, store: createStore(), cwd: project, snapshots },
	);
	for (let waited = 0; executions.second === 0; waited += 10) {
		assert.ok(waited < 20_000, "the second step started");
		await sleep(10);
	}
	const exported = await storage(machineA, ["export", exports, "--unfinished"]);
	assert.equal(exported.code, 0, exported.err);

	const machineB = machine("b");
	const imported = await storage(machineB, ["import", exports]);
	assert.equal(imported.code, 0, imported.err);

	// `--session <id>` opens the imported session in the fresh agent directory and continues it there.
	vi.stubEnv(ENV_AGENT_DIR, machineB);
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`process.exit(${code})`);
	});
	const manager = await createSessionManager(
		parseArgs(["--session", sessionId]),
		project,
		undefined,
		SettingsManager.create(project, machineB),
	);
	closing.push(() => manager.getSessionStore().close());
	assert.equal(manager.getSessionId(), sessionId);
	const entries = manager.getEntries().length;
	await manager.appendMessage({ role: "user", content: "continue on machine b", timestamp: 3_000 });
	const listed: string[] = [];
	for await (const summary of (await sessionStore(machineB)).list({ cwd: project })) listed.push(summary.id);
	assert.deepEqual(listed, [sessionId], "/resume and history://sessions list it");
	assert.equal(await sessionEntries(machineB, sessionId), entries + 1);

	const backendB = await JournalDurableBackend.open(await openStore(machineB), { ownsJournal: false });
	closing.push(() => backendB.close());
	assert.equal(await backendB.workflowOwnership(runId), "available");
	assert.deepEqual(
		(await prepareTargetedDurableResumable(backendB, [runId])).map((entry) => entry.workflowId),
		[runId],
	);
	interrupt = false;
	const jobs = createJobTracker();
	const resumed = await resumeDurableWorkflow(runId, {
		registry: createRegistry().register(definition),
		durableBackend: backendB,
		jobs,
		baseRunOpts: { store: createStore(), cwd: project, snapshots },
	});
	assert.ok(resumed.ok, resumed.message);
	await jobs.get(runId)?.promise;
	assert.equal(backendB.getWorkflow(runId)?.status, "completed");
	assert.deepEqual(executions, { first: 1, second: 2 }, "the first step replayed from the imported journal");

	release();
	await running;
});
