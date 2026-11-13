import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultJournalStoreDirectory } from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";
import { parseStorageCommand, runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
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
	root = makeTempDirectory("workflow-run-transfer-");
	project = join(root, "project");
	exports = join(root, "drive", "runs");
	mkdirSync(project, { recursive: true });
});
afterEach(async () => {
	for (const close of closing.splice(0).reverse()) await close().catch(() => {});
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

/** A fresh agent directory, as on another machine, with its own journal store. */
function machine(name: string): string {
	const agentDir = join(root, name, "agent");
	mkdirSync(agentDir, { recursive: true });
	return agentDir;
}

async function storage(agentDir: string, args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
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
	return { code, out, err };
}

async function openStore(agentDir: string): Promise<ShardedRunJournal> {
	const journal = await ShardedRunJournal.open({
		directory: defaultJournalStoreDirectory(agentDir),
		openShard: (path) => openSqlRunJournal(path),
	});
	closing.push(() => journal.close());
	return journal;
}

interface SeedRun {
	readonly id: string;
	readonly status: "running" | "paused" | "completed" | "failed";
	readonly createdAt: number;
	readonly checkpoints?: number;
}

/** Runs recorded through the journal API, each with checkpoints whose strings carry a secret. */
async function seed(agentDir: string, runs: readonly SeedRun[]): Promise<void> {
	const journal = await ShardedRunJournal.open({
		directory: defaultJournalStoreDirectory(agentDir),
		openShard: (path) => openSqlRunJournal(path),
	});
	try {
		for (const run of runs) await record(journal, run);
	} finally {
		await journal.close();
	}
}

async function record(journal: RunJournal, run: SeedRun, from = 0): Promise<void> {
	if (from === 0)
		await journal.createRun({
			runId: run.id,
			name: "transfer",
			cwd: "/project",
			createdAt: run.createdAt,
			status: "running",
			inputs: { token: SECRET, unicode: "ünïcödé ✓" },
		});
	const outcome = await journal.acquire(run.id, "holder-on-machine-a");
	assert.equal(outcome.status, "acquired");
	if (outcome.status !== "acquired") return;
	for (let index = from; index < (run.checkpoints ?? 2); index++)
		await journal.append(
			outcome.lease,
			{
				type: "CheckpointRecorded",
				payload: { kind: "tool", checkpointId: `step-${index}`, output: `used ${SECRET} at step ${index}` },
			},
			{ key: JSON.stringify(["CheckpointRecorded", "tool", `step-${index}`]) },
		);
	await journal.append(outcome.lease, { type: "StatusChanged", payload: { status: run.status } });
	if (run.status !== "running") await journal.release(outcome.lease);
}

async function entries(journal: RunJournal, runId: string): Promise<JournalEntry[]> {
	const read: JournalEntry[] = [];
	for await (const entry of journal.read(runId)) read.push(entry);
	return read;
}

function files(directory: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(directory)
			.sort()
			.map((name) => [name, readFileSync(join(directory, name), "utf8")]),
	);
}

const RUN_A = testRunId("transfer-a");
const RUN_B = testRunId("transfer-b");
const RUN_C = testRunId("transfer-c");

test("atomic storage export and import parse their options (#4716)", () => {
	assert.deepEqual(
		parseStorageCommand(["export", "out", "--run", "a", "--run", "b", "--unfinished", "--limit", "3"]),
		{
			kind: "export",
			directory: "out",
			unfinished: true,
			runs: ["a", "b"],
			limit: 3,
		},
	);
	assert.deepEqual(parseStorageCommand(["import", "in"]), { kind: "import", directory: "in" });
	for (const args of [["export"], ["export", "out", "--limit", "0"], ["export", "out", "--limit", "x"], ["import"]])
		assert.throws(() => parseStorageCommand(args));
});

test("an exported run imports into a fresh agent directory losslessly and re-exports byte for byte (#4716)", async () => {
	const source = machine("a");
	await seed(source, [
		{ id: RUN_A, status: "completed", createdAt: 1_000 },
		{ id: RUN_B, status: "paused", createdAt: 2_000, checkpoints: 3 },
	]);
	const exported = await storage(source, ["export", exports]);
	assert.equal(exported.code, 0, exported.err.join("\n"));
	assert.deepEqual(Object.keys(files(exports)), [`${RUN_A}.jsonl`, `${RUN_B}.jsonl`].sort());
	const lines = files(exports)
		[`${RUN_B}.jsonl`]!.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		{ ...lines[0], header: undefined },
		{
			type: "atomic.workflow-run",
			version: 1,
			runId: RUN_B,
			name: "transfer",
			cwd: "/project",
			createdAt: 2_000,
			status: "paused",
			events: 4,
			header: undefined,
		},
	);
	assert.deepEqual(
		lines.slice(1).map((line) => [line.type, line.seq]),
		[
			["CheckpointRecorded", 1],
			["CheckpointRecorded", 2],
			["CheckpointRecorded", 3],
			["StatusChanged", 4],
		],
	);
	const before = files(exports);
	assert.equal(
		(await storage(source, ["export", exports])).out[0],
		`Exported 2 workflow runs to ${exports} (0 written, 2 unchanged).`,
	);

	const target = machine("b");
	const imported = await storage(target, ["import", exports]);
	assert.equal(imported.code, 0, imported.err.join("\n"));
	assert.match(imported.out[0]!, /Imported 2 workflow runs .* \(2 added, 0 updated, 0 already up to date\)/);
	const sourceJournal = await openStore(source);
	const targetJournal = await openStore(target);
	for (const runId of [RUN_A, RUN_B]) {
		assert.deepEqual(await targetJournal.getRun(runId), await sourceJournal.getRun(runId));
		assert.deepEqual(await entries(targetJournal, runId), await entries(sourceJournal, runId));
	}
	const again = join(root, "re-export");
	assert.equal((await storage(target, ["export", again])).code, 0);
	assert.deepEqual(files(again), before, "the imported runs export to the same bytes");
});

test("importing again adds nothing, and a newer export of a run adds its later events (#4716)", async () => {
	const source = machine("a");
	await seed(source, [{ id: RUN_A, status: "running", createdAt: 1_000 }]);
	await storage(source, ["export", exports]);
	const target = machine("b");
	assert.match((await storage(target, ["import", exports])).out[0]!, /1 added/);
	assert.match((await storage(target, ["import", exports])).out[0]!, /1 already up to date/);
	const targetJournal = await openStore(target);
	const firstImport = await entries(targetJournal, RUN_A);

	const sourceJournal = await openStore(source);
	await record(sourceJournal, { id: RUN_A, status: "completed", createdAt: 1_000, checkpoints: 4 }, 2);
	await storage(source, ["export", exports]);
	const updated = await storage(target, ["import", exports]);
	assert.match(updated.out[0]!, /0 added, 1 updated, 0 already up to date/);
	const after = await entries(targetJournal, RUN_A);
	assert.deepEqual(after, await entries(sourceJournal, RUN_A));
	assert.deepEqual(after.slice(0, firstImport.length), firstImport);
	assert.equal((await targetJournal.getRun(RUN_A))?.status, "completed");
	assert.match((await storage(target, ["import", exports])).out[0]!, /1 already up to date/);
	assert.equal((await entries(targetJournal, RUN_A)).length, after.length, "no duplicate events");
});

test("files whose string values a tool redacted import as the run they came from (#4716)", async () => {
	const source = machine("a");
	await seed(source, [{ id: RUN_A, status: "paused", createdAt: 1_000 }]);
	await storage(source, ["export", exports]);
	const file = join(exports, `${RUN_A}.jsonl`);
	// What gh-aw's redaction does: replace each secret substring, line by line, keeping every line a JSON object.
	const redacted = readFileSync(file, "utf8")
		.split("\n")
		.map((line) => line.replaceAll(SECRET, "***"))
		.join("\n");
	writeFileSync(file, redacted);
	assert.ok(!redacted.includes(SECRET));

	const target = machine("b");
	const imported = await storage(target, ["import", exports]);
	assert.equal(imported.code, 0, imported.err.join("\n"));
	const targetJournal = await openStore(target);
	const restored = await entries(targetJournal, RUN_A);
	assert.equal(restored.length, 3);
	assert.deepEqual(restored[0]!.event.payload, { kind: "tool", checkpointId: "step-0", output: "used *** at step 0" });
	assert.deepEqual((await targetJournal.getRun(RUN_A))?.inputs, { token: "***", unicode: "ünïcödé ✓" });

	// The source machine still holds the unredacted run: the redacted file is the same run, so it is up to date.
	assert.match((await storage(source, ["import", exports])).out[0]!, /1 already up to date/);
	const again = join(root, "again");
	await storage(target, ["export", again]);
	assert.equal(readFileSync(join(again, `${RUN_A}.jsonl`), "utf8"), redacted);
});

test("a malformed, unknown-version or inconsistent file fails the import with its file and line, and nothing is imported (#4716)", async () => {
	const source = machine("a");
	await seed(source, [
		{ id: RUN_A, status: "completed", createdAt: 1_000 },
		{ id: RUN_B, status: "completed", createdAt: 2_000 },
	]);
	await storage(source, ["export", exports]);
	const good = readFileSync(join(exports, `${RUN_A}.jsonl`), "utf8");
	const broken = join(exports, `${RUN_B}.jsonl`);
	const original = readFileSync(broken, "utf8");
	const lines = original.trimEnd().split("\n");
	const edit = (line: number, change: (value: Record<string, unknown>) => void) => {
		const copy = [...lines];
		const value = JSON.parse(copy[line - 1]!);
		change(value);
		copy[line - 1] = JSON.stringify(value);
		return `${copy.join("\n")}\n`;
	};
	const cases: readonly (readonly [string, RegExp])[] = [
		[
			`${lines[0]}\n${lines[1]}\n{"type":"CheckpointRecorded",\n`,
			new RegExp(`${RUN_B}\\.jsonl:3: is not valid JSON`),
		],
		[edit(1, (header) => (header.version = 2)), /:1: has unsupported export version 2; this Atomic reads version 1/],
		[edit(1, (header) => (header.type = "session")), /:1: is not an Atomic workflow run export/],
		[edit(3, (event) => (event.seq = 7)), /:3: has seq 7; expected 2/],
		[edit(2, (event) => (event.type = "Unknown")), /:2: has unknown event type "Unknown"/],
		[edit(2, (event) => delete event.epoch), /:2: has no "epoch" field/],
		[`${lines.slice(0, 2).join("\n")}\n`, /:1: says the run has 3 events, but the file has 1 event lines/],
		[`${lines[0]}\n["not", "an", "object"]\n${lines.slice(2).join("\n")}\n`, /:2: is not a JSON object/],
	];
	const target = machine("b");
	for (const [content, message] of cases) {
		writeFileSync(broken, content);
		const result = await storage(target, ["import", exports]);
		assert.equal(result.code, 1);
		assert.match(result.err.join("\n"), message);
		assert.ok(result.err.join("\n").includes(broken));
		assert.ok(!existsSync(defaultJournalStoreDirectory(target)), "nothing was written, not even the good file");
	}
	// A run that continued differently here is refused the same way, before anything is written.
	writeFileSync(broken, original);
	await seed(target, [{ id: RUN_B, status: "failed", createdAt: 2_000, checkpoints: 1 }]);
	const conflict = await storage(target, ["import", exports]);
	assert.equal(conflict.code, 1);
	assert.match(
		conflict.err.join("\n"),
		/:2: event 1 differs from event 1 of run .* the run continued differently there/,
	);
	assert.equal(await (await openStore(target)).getRun(RUN_A), undefined, "the good run was not imported either");
	assert.equal(good.length > 0, true);
});

test("export selects runs with --run, --unfinished and --limit, newest first (#4716)", async () => {
	const source = machine("a");
	await seed(source, [
		{ id: RUN_A, status: "completed", createdAt: 1_000 },
		{ id: RUN_B, status: "paused", createdAt: 2_000 },
		{ id: RUN_C, status: "running", createdAt: 3_000 },
	]);
	const select = async (name: string, args: string[]) => {
		const directory = join(root, name);
		const result = await storage(source, ["export", directory, ...args]);
		assert.equal(result.code, 0, result.err.join("\n"));
		return Object.keys(files(directory)).map((file) => file.replace(".jsonl", ""));
	};
	assert.deepEqual(await select("one", ["--run", RUN_A]), [RUN_A]);
	assert.deepEqual((await select("two", ["--run", RUN_A, "--run", RUN_C])).sort(), [RUN_A, RUN_C].sort());
	assert.deepEqual((await select("unfinished", ["--unfinished"])).sort(), [RUN_B, RUN_C].sort());
	assert.deepEqual(await select("newest", ["--limit", "1"]), [RUN_C]);
	assert.deepEqual(await select("newest-finished", ["--limit", "1", "--run", RUN_A, "--run", RUN_B]), [RUN_B]);
	const missing = await storage(source, ["export", join(root, "missing"), "--run", RUN_A, "--run", "not-a-run"]);
	assert.equal(missing.code, 1);
	assert.match(missing.err.join("\n"), /run not-a-run is not in this workflow journal/);
	assert.ok(!existsSync(join(root, "missing")), "an unknown run writes no file");
});

test("export replaces each file whole through a temporary file and leaves no partial file behind (#4716)", async () => {
	const source = machine("a");
	await seed(source, [
		{ id: RUN_A, status: "completed", createdAt: 1_000 },
		{ id: RUN_B, status: "completed", createdAt: 2_000 },
	]);
	mkdirSync(exports, { recursive: true });
	writeFileSync(join(exports, `${RUN_A}.jsonl`), "previous export\n");
	// RUN_B's file cannot be replaced: a non-empty directory holds its name. The newer run is written first.
	mkdirSync(join(exports, `${RUN_B}.jsonl`, "blocker"), { recursive: true });
	const failed = await storage(source, ["export", exports]);
	assert.equal(failed.code, 1);
	assert.match(failed.err.join("\n"), /cannot write the export file/);
	assert.equal(readFileSync(join(exports, `${RUN_A}.jsonl`), "utf8"), "previous export\n");
	assert.deepEqual(
		readdirSync(exports).sort(),
		[`${RUN_A}.jsonl`, `${RUN_B}.jsonl`].sort(),
		"no temporary file is left",
	);

	// A temporary file a crashed export left behind is not an export: import ignores it.
	removeTempDirectory(join(exports, `${RUN_B}.jsonl`));
	writeFileSync(join(exports, ".interrupted.tmp"), '{"type":"atomic.workflow-run","ver');
	assert.equal((await storage(source, ["export", exports])).code, 0);
	for (const content of Object.values(files(exports)).slice(1))
		for (const line of content.trimEnd().split("\n")) assert.equal(typeof JSON.parse(line).type, "string");
	const imported = await storage(machine("b"), ["import", exports]);
	assert.equal(imported.code, 0, imported.err.join("\n"));
	assert.match(imported.out[0]!, /2 added/);
});

test("export and import refuse a shared database selection with a clear message (#4716)", async () => {
	vi.stubEnv(
		"ATOMIC_WORKFLOWS_JOURNAL",
		JSON.stringify({ adapter: "@bastani/atomic-storage-libsql", options: { url: "libsql://team.example" } }),
	);
	for (const command of ["export", "import"]) {
		const result = await storage(machine("a"), [command, exports]);
		assert.equal(result.code, 1);
		assert.match(result.err.join("\n"), new RegExp(`storage ${command} works with a local workflow journal`));
		assert.match(result.err.join("\n"), /shared database already holds the runs of every machine/);
	}
});

test("the default journal of Atomic before the journal store is exported and compared like the store's runs (#4716)", async () => {
	const source = machine("a");
	const legacy = await openSqlRunJournal(join(root, "a", "workflows", "journal.sqlite"));
	await record(legacy, { id: RUN_A, status: "completed", createdAt: 1_000 });
	await legacy.close();
	assert.equal((await storage(source, ["export", exports])).code, 0);
	assert.deepEqual(Object.keys(files(exports)), [`${RUN_A}.jsonl`]);

	// A machine whose earlier default journal holds a different run with the same ID refuses the file.
	const target = machine("b");
	const other = await openSqlRunJournal(join(root, "b", "workflows", "journal.sqlite"));
	await record(other, { id: RUN_A, status: "failed", createdAt: 1_000, checkpoints: 1 });
	await other.close();
	const conflict = await storage(target, ["import", exports]);
	assert.equal(conflict.code, 1);
	assert.match(conflict.err.join("\n"), /the run continued differently there/);
});

test("export and import use a configured SQLite journal file (#4716)", async () => {
	const source = machine("a");
	const path = join(root, "a", "custom.sqlite");
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", path);
	const journal = await openSqlRunJournal(path);
	await record(journal, { id: RUN_A, status: "completed", createdAt: 1_000 });
	await journal.close();
	assert.equal((await storage(source, ["export", exports])).code, 0);
	const targetPath = join(root, "b", "custom.sqlite");
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", targetPath);
	assert.match((await storage(machine("b"), ["import", exports])).out[0]!, /1 added/);
	const restored = await openSqlRunJournal(targetPath);
	closing.push(() => restored.close());
	assert.equal((await restored.getRun(RUN_A))?.status, "completed");
	assert.equal((await entries(restored, RUN_A)).length, 3);
});

test("an interrupted run exported from one machine resumes to completion on another (#4716)", async () => {
	const runId = testRunId("transfer-interrupted");
	const executions = { first: 0, second: 0 };
	let interrupt = true;
	let release = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const definition = workflow({
		name: "transfer-e2e",
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

	// Machine A runs the workflow; it is cut off inside its second step, still holding the run's lease.
	const machineA = machine("a");
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
	assert.equal((await storage(machineA, ["export", exports, "--unfinished"])).code, 0);
	const exported = readFileSync(join(exports, `${runId}.jsonl`), "utf8");
	assert.equal(JSON.parse(exported.split("\n")[0]!).status, "running");
	assert.ok(!exported.includes("holder"), "no lease is exported");

	// Machine B starts fresh, imports, and finds the run resumable and owned by nobody.
	const machineB = machine("b");
	const imported = await storage(machineB, ["import", exports]);
	assert.equal(imported.code, 0, imported.err.join("\n"));
	const backendB = await JournalDurableBackend.open(await openStore(machineB), { ownsJournal: false });
	closing.push(() => backendB.close());
	assert.equal(await backendB.workflowOwnership(runId), "available");
	assert.deepEqual(
		(await prepareTargetedDurableResumable(backendB, [runId])).map((entry) => entry.workflowId),
		[runId],
	);
	assert.equal(backendB.getWorkflow(runId)?.status, "running");

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
