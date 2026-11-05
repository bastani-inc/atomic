import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { JournalAdoptError, JournalCatalog, JournalShardUnavailableError } from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	formatStorageStatus,
	parseStorageCommand,
	runStorageCommand,
	StorageCommandError,
} from "../../packages/coding-agent/src/cli/storage-command.js";
import { collectStorageStatus } from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const STORAGE_VARIABLES = [
	"ATOMIC_STORAGE",
	"ATOMIC_SESSIONS_STORAGE",
	"ATOMIC_WORKFLOWS_JOURNAL",
	"ATOMIC_CODING_AGENT_SESSION_DIR",
	"ATOMIC_WORKFLOW_JOURNAL_PATH",
];

let root: string;
let agentDir: string;
let project: string;
let store: string;

beforeEach(() => {
	for (const name of STORAGE_VARIABLES) vi.stubEnv(name, "");
	root = makeTempDirectory("journal-store-cli-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	store = join(root, "workflows", "journal");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
});
afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

async function storage(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
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

/** A journal file with one root per entry, each in `status`, written by the durable backend. */
async function journalFile(
	path: string,
	runs: readonly { readonly id: string; readonly status: "failed" | "running" }[],
) {
	mkdirSync(join(path, ".."), { recursive: true });
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
	try {
		for (const run of runs)
			await backend.commitWorkflowRegistration({
				workflowId: run.id,
				name: "legacy",
				inputs: {},
				createdAt: 1,
				status: run.status,
			});
	} finally {
		await backend.close();
	}
}

test("atomic storage parses adopt and consolidate (#4325)", () => {
	assert.deepEqual(parseStorageCommand(["adopt", "a.sqlite", "dir"]), {
		kind: "adopt",
		paths: ["a.sqlite", "dir"],
		discover: true,
	});
	assert.deepEqual(parseStorageCommand(["adopt", "--no-discover", "a.sqlite"]), {
		kind: "adopt",
		paths: ["a.sqlite"],
		discover: false,
	});
	assert.deepEqual(parseStorageCommand(["consolidate"]), { kind: "consolidate" });
	assert.deepEqual(parseStorageCommand(["adopt", "--help"]), { kind: "help" });
	for (const [args, message] of [
		[["adopt"], "Usage: atomic storage adopt <path>... [--no-discover]"],
		[["consolidate", "extra"], "Usage: atomic storage consolidate"],
		[["consolidate", "--no-discover"], 'Unknown option --no-discover for "storage consolidate".'],
		[["status", "--no-discover"], 'Unknown option --no-discover for "storage status".'],
	] as const)
		assert.throws(
			() => parseStorageCommand([...args]),
			(error: Error) => error instanceof StorageCommandError && error.message.startsWith(message),
		);
});

test("atomic storage --help documents adopt and consolidate (#4325)", async () => {
	const { code, out } = await storage(["--help"]);
	assert.equal(code, 0);
	const help = out.join("\n");
	assert.ok(help.includes("storage adopt <path>... [--no-discover]"));
	assert.ok(help.includes("storage consolidate"));
	assert.ok(help.includes("--no-discover         adopt: register only the given paths"));
});

test("atomic storage adopt registers journals in place, reports discoveries, and is idempotent (#4325)", async () => {
	const first = join(root, "campaign-journal-1", "journal.sqlite");
	const missing = join(root, "campaign-journal-9", "journal.sqlite");
	await journalFile(first, [
		{ id: "11111111-1111-4111-8111-111111111111", status: "failed" },
		{ id: "22222222-2222-4222-8222-222222222222", status: "running" },
	]);
	const sql = await openSqlRunJournal(first);
	await sql.createRun({
		runId: "33333333-3333-4333-8333-333333333333",
		name: "moved",
		cwd: "/p",
		createdAt: 1,
		status: "failed",
		storage: { adapter: "node-sqlite", location: missing },
	});
	await sql.close();
	const adopted = await storage(["adopt", "../campaign-journal-1"]);
	assert.deepEqual(adopted, {
		code: 0,
		out: [
			`Adopted ${first} in place (shard 1, 3 runs).`,
			`Skipped ${missing}, referenced by runs in ${first} (path-not-found).`,
		],
		err: [],
	});
	const again = await storage(["adopt", "--no-discover", first]);
	assert.deepEqual(again.out, [`Already registered: ${first} (shard 1).`]);
});

test("atomic storage adopt and consolidate note a journal selection other than the store (#4325)", async () => {
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", join(root, "isolated.sqlite"));
	const file = join(root, "old", "journal.sqlite");
	await journalFile(file, [{ id: "44444444-4444-4444-8444-444444444444", status: "failed" }]);
	const note = `Note: workflow runs here use SQLite ${join(root, "isolated.sqlite")}, so they see the journal store ${store} only once that selection is removed.`;
	assert.equal((await storage(["adopt", file])).out.at(-1), note);
	assert.equal((await storage(["consolidate"])).out.at(-1), note);
});

test("a failed adoption prints the typed error's message and hint once and exits 1 (#4325)", async () => {
	const result = await storage(["adopt", join(root, "absent.sqlite")]);
	const expected = new JournalAdoptError({ code: "path-not-found", path: join(root, "absent.sqlite") });
	assert.deepEqual(result, { code: 1, out: [], err: [expected.message, expected.hint] });
});

test("atomic storage consolidate moves finished runs and says why others stay (#4325)", async () => {
	const file = join(root, "old", "journal.sqlite");
	await journalFile(file, [
		{ id: "55555555-5555-4555-8555-555555555555", status: "failed" },
		{ id: "66666666-6666-4666-8666-666666666666", status: "running" },
	]);
	assert.equal((await storage(["adopt", file])).code, 0);
	const moved = await storage(["consolidate"]);
	assert.deepEqual(moved, {
		code: 0,
		out: ["Moved 1 finished run into the journal store's shards.", "Left 1 run in place: unfinished."],
		err: [],
	});
	const again = await storage(["consolidate"]);
	assert.deepEqual(again.out, [
		"Moved 0 finished runs into the journal store's shards.",
		"Left 1 run in place: unfinished.",
	]);
	rmSync(join(root, "old"), { recursive: true, force: true });
	const gone = await storage(["consolidate"]);
	assert.equal(gone.code, 1, "a run skipped with a typed failure fails the command");
	assert.deepEqual(gone.out.slice(0, 2), [
		"Moved 0 finished runs into the journal store's shards.",
		"Left 1 run in place: shard-unavailable.",
	]);
	assert.ok(gone.out[2]?.startsWith(`Journal shard unavailable: ${file} (shard-missing). Restore the file`));
});

test("atomic storage status shows the journal store, its adopted and missing journals and skipped ones (#4325)", async () => {
	const before = await collectStorageStatus({ cwd: project, agentDir, probe: true });
	const journal = before.domains.find((entry) => entry.domain === "journal")!;
	assert.equal(journal.selection, `journal store ${store}`);
	assert.equal(journal.source, "default");
	assert.deepEqual(journal.probe?.connection, {
		status: "skipped",
		detail: "journal store not created yet; Atomic creates it on first use",
	});
	assert.equal("journalStore" in journal, false, "a store not created yet has no catalog to show");

	const kept = join(root, "kept", "journal.sqlite");
	const lost = join(root, "lost", "journal.sqlite");
	await journalFile(kept, [{ id: "77777777-7777-4777-8777-777777777777", status: "failed" }]);
	await journalFile(lost, [{ id: "88888888-8888-4888-8888-888888888888", status: "failed" }]);
	writeFileSync(join(root, "notes.sqlite"), "not a database");
	await storage(["adopt", kept, lost]);
	assert.equal((await storage(["adopt", join(root, "notes.sqlite")])).code, 1);
	rmSync(join(root, "lost"), { recursive: true, force: true });
	mkdirSync(join(root, "workflows"), { recursive: true });
	writeFileSync(join(root, "workflows", "journal.sqlite"), "");
	const { DatabaseSync } = await import("node:sqlite");
	const catalog = new DatabaseSync(join(store, "catalog.sqlite"));
	catalog
		.prepare("INSERT INTO catalog_discovery VALUES (?, 'skipped', 'not-a-journal', NULL, 0)")
		.run(join(root, "workflows", "journal.sqlite"));
	catalog.close();

	const after = await collectStorageStatus({ cwd: project, agentDir, probe: true });
	const status = after.domains.find((entry) => entry.domain === "journal")!;
	assert.equal(status.probe?.connection.status, "ok");
	const { unavailable, ...counts } = status.journalStore!;
	assert.deepEqual(counts, {
		catalog: join(store, "catalog.sqlite"),
		shards: 0,
		adopted: 2,
		runs: 2,
		skipped: [{ path: join(root, "workflows", "journal.sqlite"), reason: "not-a-journal" }],
	});
	assert.equal(unavailable.length, 1);
	assert.deepEqual(
		[unavailable[0]?.path, unavailable[0]?.kind, unavailable[0]?.code],
		[lost, "adopted", "shard-missing"],
	);
	assert.ok(unavailable[0]?.message.includes(lost) && unavailable[0].hint.length > 0);
	const lines = formatStorageStatus(after);
	const at = lines.indexOf(`Workflow runs: journal store ${store}`);
	assert.ok(at >= 0, lines.join("\n"));
	assert.deepEqual(lines.slice(at + 3, at + 6), [
		"  journals:    0 shards, 2 adopted journals, 2 runs",
		`  unavailable: ${lost} (adopted, no longer exists: shard-missing)`,
		`  skipped:     ${join(root, "workflows", "journal.sqlite")} (not-a-journal)`,
	]);
});

test("the journal store line counts shards, adopted journals and runs in the singular and plural (#4325)", () => {
	const status = (counts: { shards: number; adopted: number; runs: number }) =>
		formatStorageStatus({
			agentDir,
			cwd: project,
			projectTrusted: true,
			notes: [],
			domains: [
				{
					domain: "journal",
					selection: `journal store ${store}`,
					source: "default",
					overridden: [],
					journalStore: { catalog: join(store, "catalog.sqlite"), ...counts, unavailable: [], skipped: [] },
				},
			],
		}).find((line) => line.startsWith("  journals:"));
	assert.equal(status({ shards: 1, adopted: 1, runs: 1 }), "  journals:    1 shard, 1 adopted journal, 1 run");
	assert.equal(status({ shards: 2, adopted: 0, runs: 3 }), "  journals:    2 shards, 0 adopted journals, 3 runs");
});

test("a failure that is not the journal store's is printed as an error line, by default on stderr (#4325)", async () => {
	writeFileSync(join(agentDir, "settings.json"), "{ not json");
	const failed = await storage(["status"]);
	assert.equal(failed.code, 1);
	assert.ok(failed.err[0]?.startsWith("Error: Cannot load settings"), failed.err.join("\n"));
	const printed: string[] = [];
	const spy = vi.spyOn(console, "error").mockImplementation((line: string) => {
		printed.push(line);
	});
	try {
		assert.equal(
			await runStorageCommand(["adopt", join(root, "absent")], { cwd: project, agentDir, log: () => {} }),
			1,
		);
	} finally {
		spy.mockRestore();
	}
	assert.equal(printed[0], `Cannot adopt journal: ${join(root, "absent")} does not exist (path-not-found).`);
	assert.equal(printed.length, 2);
});

test("adopt notes only a journal selection this project applies: an untrusted project's settings do not count (#4325)", async () => {
	const file = join(root, "old", "journal.sqlite");
	await journalFile(file, [{ id: "99999999-9999-4999-8999-999999999999", status: "failed" }]);
	mkdirSync(join(project, ".atomic"), { recursive: true });
	writeFileSync(
		join(project, ".atomic", "settings.json"),
		JSON.stringify({ workflows: { journal: { path: join(root, "project.sqlite") } } }),
	);
	writeFileSync(join(project, "package.json"), "{}");
	const { out } = await storage(["adopt", file]);
	assert.deepEqual(out, [`Adopted ${file} in place (shard 1, 1 run).`]);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ workflows: { journal: {} } }));
	assert.equal(
		(await collectStorageStatus({ cwd: project, agentDir, probe: false })).domains.find(
			(entry) => entry.domain === "journal",
		)?.selection,
		`journal store ${store}`,
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ storage: { path: "shared.sqlite" } }));
	assert.equal(
		(await collectStorageStatus({ cwd: project, agentDir, probe: false })).domains.find(
			(entry) => entry.domain === "journal",
		)?.selection,
		`SQLite ${join(root, "shared.sqlite")}`,
	);
});

test("status counts the store's own shards apart from adopted journals (#4325)", async () => {
	const file = join(root, "old", "journal.sqlite");
	await journalFile(file, [{ id: "12121212-1212-4121-8121-121212121212", status: "failed" }]);
	await storage(["adopt", file]);
	const catalog = await JournalCatalog.open(store);
	await catalog.place({ runId: "native", status: "running" });
	await catalog.close();
	const status = await collectStorageStatus({ cwd: project, agentDir, probe: true });
	const journal = status.domains.find((entry) => entry.domain === "journal")!;
	assert.deepEqual(
		[journal.journalStore?.shards, journal.journalStore?.adopted, journal.journalStore?.runs],
		[1, 1, 2],
	);
});

test("adopt names the journals it adopted through references; consolidate counts each reason and shows the first failure (#4325)", async () => {
	const referenced = join(root, "referenced", "journal.sqlite");
	await journalFile(referenced, [{ id: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1", status: "failed" }]);
	const start = join(root, "start", "journal.sqlite");
	await journalFile(start, [
		{ id: "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2", status: "running" },
		{ id: "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3", status: "running" },
	]);
	const sql = await openSqlRunJournal(start);
	await sql.createRun({
		runId: "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4",
		name: "moved",
		cwd: "/p",
		createdAt: 1,
		status: "failed",
		storage: { adapter: "node-sqlite", location: referenced },
	});
	await sql.close();
	const gone = join(root, "gone", "journal.sqlite");
	await journalFile(gone, [{ id: "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5", status: "failed" }]);
	assert.deepEqual((await storage(["adopt", start, gone])).out, [
		`Adopted ${start} in place (shard 1, 3 runs).`,
		`Adopted ${gone} in place (shard 2, 1 run).`,
		`Adopted ${referenced}, referenced by runs in ${start}.`,
	]);
	rmSync(join(root, "gone"), { recursive: true, force: true });
	const missing = new JournalShardUnavailableError({ code: "shard-missing", shardId: 2, shardPath: gone });
	assert.deepEqual(await storage(["consolidate"]), {
		code: 1,
		out: [
			"Moved 2 finished runs into the journal store's shards.",
			"Left 2 runs in place: unfinished.",
			"Left 1 run in place: shard-unavailable.",
			`${missing.message} ${missing.hint}`,
		],
		err: [],
	});
});

test("atomic storage status lists a native shard whose file was deleted or cannot be opened, and exits 1 (#4325)", async () => {
	const catalog = await JournalCatalog.open(store);
	const first = (await catalog.place({ runId: "99999999-9999-4999-8999-999999999999", status: "running" })).shard.path;
	const second = (await catalog.place({ runId: "88888888-8888-4888-8888-888888888888", status: "running" })).shard
		.path;
	await catalog.close();
	assert.notEqual(first, second);
	rmSync(first);
	writeFileSync(second, "not a database, but long enough to be read as a file header of some kind");
	const status = await collectStorageStatus({ cwd: project, agentDir, probe: true });
	const journal = status.domains.find((entry) => entry.domain === "journal")!;
	const unavailable = journal.journalStore?.unavailable ?? [];
	assert.deepEqual(
		unavailable.map((shard) => [shard.path, shard.kind, shard.code]),
		[
			[first, "native", "shard-missing"],
			[second, "native", "shard-open-failed"],
		],
	);
	assert.ok(unavailable.every((shard) => shard.message.includes(shard.path) && shard.hint.length > 0));
	assert.equal("detail" in unavailable[0]!, false, "a missing file has no driver reason");
	assert.equal(typeof unavailable[1]?.detail, "string", "a file that cannot be opened carries the driver's reason");
	const lines = formatStorageStatus(status);
	assert.ok(lines.includes(`  unavailable: ${first} (native, no longer exists: shard-missing)`));
	assert.ok(
		lines.some((line) => line.startsWith(`  unavailable: ${second} (native, cannot be opened: shard-open-failed, `)),
	);
	assert.equal((await storage(["status"])).code, 1);
});

test("atomic storage status opens shard files read-only and closes every one (#4325)", async () => {
	const catalog = await JournalCatalog.open(store);
	const shard = (await catalog.place({ runId: "77777777-7777-4777-8777-777777777777", status: "running" })).shard.path;
	await catalog.close();
	await (await openSqlRunJournal(shard)).close();
	if (process.platform !== "win32") chmodSync(shard, 0o444);
	const status = await collectStorageStatus({ cwd: project, agentDir, probe: true });
	const journal = status.domains.find((entry) => entry.domain === "journal")!;
	if (process.platform !== "win32" && process.getuid?.() !== 0)
		assert.deepEqual(journal.journalStore?.unavailable, [], "a shard file that is read-only is still usable to read");
	if (process.platform === "linux")
		for (const name of readdirSync("/proc/self/fd")) {
			const target = (() => {
				try {
					return readlinkSync(join("/proc/self/fd", name));
				} catch {
					return "";
				}
			})();
			assert.equal(target.startsWith(shard), false, `status left ${target} open`);
		}
	if (process.platform !== "win32") chmodSync(shard, 0o644);
});

test("atomic storage consolidate reports each distinct failure once and exits 1, while policy skips exit 0 (#4325)", async () => {
	const first = join(root, "a", "journal.sqlite");
	const second = join(root, "b", "journal.sqlite");
	await journalFile(first, [{ id: "11111111-1111-4111-8111-111111111111", status: "failed" }]);
	await journalFile(second, [{ id: "22222222-2222-4222-8222-222222222222", status: "failed" }]);
	await storage(["adopt", first, second]);
	rmSync(join(root, "a"), { recursive: true, force: true });
	rmSync(join(root, "b"), { recursive: true, force: true });
	const failed = await storage(["consolidate"]);
	assert.equal(failed.code, 1);
	assert.equal(
		failed.out.filter((line) => line.startsWith("Journal shard unavailable: ")).length,
		2,
		"one line per file",
	);
	const again = await storage(["consolidate"]);
	assert.equal(again.out.filter((line) => line.startsWith("Journal shard unavailable: ")).length, 2);
});

test("atomic storage status leaves an adopted journal in rollback-journal mode byte for byte as it was (#4325)", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const file = join(root, "rollback", "journal.sqlite");
	await journalFile(file, [{ id: "44444444-4444-4444-8444-444444444444", status: "failed" }]);
	const converted = new DatabaseSync(file);
	converted.exec("PRAGMA journal_mode=DELETE");
	converted.close();
	assert.equal((await storage(["adopt", file])).code, 0);
	const listing = () => readdirSync(join(root, "rollback")).sort();
	const before = { bytes: readFileSync(file), modified: statSync(file).mtimeMs, files: listing() };
	const status = await collectStorageStatus({ cwd: project, agentDir, probe: true });
	assert.deepEqual(status.domains.find((entry) => entry.domain === "journal")?.journalStore?.unavailable, []);
	assert.deepEqual(readFileSync(file), before.bytes, "the file's bytes are unchanged");
	assert.equal(statSync(file).mtimeMs, before.modified);
	assert.deepEqual(listing(), before.files, "no write-ahead log or journal file appeared");
	const reread = new DatabaseSync(file, { readOnly: true });
	assert.equal(reread.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
	reread.close();
});
