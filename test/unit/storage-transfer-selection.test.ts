import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";
import { parseStorageCommand, runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { LIBSQL_ADAPTER_PACKAGE } from "../../packages/coding-agent/src/core/storage/selection.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

/** Loading the libSQL package adapter through jiti and opening a `file:` database, several times. */
const LIBSQL_SCENARIO_TIMEOUT_MS = 60_000;

const libsqlPackage = resolve(moduleDir(import.meta.url), "../../packages/storage-libsql");
const STORAGE_VARIABLES = [
	"ATOMIC_STORAGE",
	"ATOMIC_SESSIONS_STORAGE",
	"ATOMIC_WORKFLOWS_JOURNAL",
	"ATOMIC_CODING_AGENT_SESSION_DIR",
	"ATOMIC_WORKFLOW_JOURNAL_PATH",
	"ATOMIC_PROFILE",
];

let root: string;
let project: string;
let libsqlDirectory: string;

beforeEach(() => {
	for (const name of STORAGE_VARIABLES) vi.stubEnv(name, "");
	root = makeTempDirectory("storage-transfer-selection-");
	project = join(root, "project");
	mkdirSync(project, { recursive: true });
	libsqlDirectory = makeLibsqlDirectory();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await removeLibsqlDirectory(libsqlDirectory);
	removeTempDirectory(root);
});

function machine(name: string, settings: object = {}): string {
	const agentDir = join(root, name, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
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

async function seed(agentDir: string): Promise<string> {
	const store = await resolveSessionStore(project, { agentDir });
	let sessionId: string;
	try {
		const manager = await SessionManager.create(store, project);
		await manager.appendMessage({ role: "user", content: "carried between stores", timestamp: Date.now() });
		sessionId = manager.getSessionId();
	} finally {
		await store.close();
	}
	return sessionId;
}

function tree(directory: string): Record<string, string> {
	const result: Record<string, string> = {};
	const path = join(directory, "sessions");
	if (!existsSync(path)) return result;
	for (const name of readdirSync(path).sort()) result[`sessions/${name}`] = readFileSync(join(path, name), "utf8");
	return result;
}

test("export and import parse --storage and --storage-file (#4793)", () => {
	const exported = parseStorageCommand(["export", "out", "--storage", '{"path":"old.sqlite"}']);
	assert.equal(exported.kind, "export");
	assert.deepEqual(exported.kind === "export" ? exported.storage : undefined, { path: "old.sqlite" });
	const imported = parseStorageCommand(["import", "in", "--sessions", "--storage-file", "new.json"]);
	assert.equal(imported.kind, "import");
	assert.equal(imported.kind === "import" ? imported.storageFile : undefined, "new.json");
	assert.throws(
		() => parseStorageCommand(["export", "out", "--storage", "{}", "--storage-file", "x.json"]),
		/Pass only one of --storage and --storage-file/,
	);
	assert.throws(() => parseStorageCommand(["import", "in", "--storage", "path=x"]), /--storage needs a JSON object/);
	assert.throws(() => parseStorageCommand(["import", "in", "--storage", "[]"]), /--storage needs a JSON object/);
	assert.throws(() => parseStorageCommand(["import", "in", "--storage", "null"]), /--storage needs a JSON object/);
	assert.throws(() => parseStorageCommand(["import", "in", "--storage", '"x"']), /--storage needs a JSON object/);
	assert.throws(() => parseStorageCommand(["status", "--storage", "{}"]), /Unknown option --storage/);
});

test(
	"a named shared selection is exported from and imported into, though the plain commands refuse it (#4793)",
	async () => {
		const shared = {
			adapter: LIBSQL_ADAPTER_PACKAGE,
			options: { url: pathToFileURL(join(libsqlDirectory, "shared.sqlite")).href },
			prefix: "team_",
		};
		const source = machine("a");
		const sessionId = await seed(source);
		const exported = join(root, "exported");
		assert.equal((await storage(source, ["export", exported])).code, 0);
		const before = tree(exported);
		assert.deepEqual(Object.keys(before), [`sessions/${sessionId}.jsonl`]);

		// This machine joined the shared database: the plain commands refuse it, a named selection is used.
		const target = machine("b", { packages: [libsqlPackage], storage: shared });
		const refused = await storage(target, ["import", exported]);
		assert.equal(refused.code, 1);
		assert.match(refused.err, /atomic storage import works with .*A shared database already holds/);
		const selectionFile = join(root, "shared.json");
		writeFileSync(selectionFile, JSON.stringify(shared));
		const imported = await storage(target, ["import", exported, "--storage-file", selectionFile]);
		assert.equal(imported.code, 0, imported.err);
		assert.match(imported.out, /Imported 1 session .*\(1 added/);
		const again = await storage(target, ["import", exported, "--storage", JSON.stringify(shared)]);
		assert.match(again.out, /1 session .*\(0 added, 0 updated, 1 already up to date\)/);

		const reexported = join(root, "reexported");
		const back = await storage(target, ["export", reexported, "--storage", JSON.stringify(shared)]);
		assert.equal(back.code, 0, back.err);
		assert.deepEqual(tree(reexported), before, "the session reads back byte for byte");
		const database = await openNodeSqliteDatabase(join(libsqlDirectory, "shared.sqlite"), { readOnly: true });
		try {
			const tables = await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
			assert.ok(
				tables.length > 0 && tables.every(({ name }) => name.startsWith("team_") || name.startsWith("sqlite_")),
				JSON.stringify(tables),
			);
		} finally {
			await database.close();
		}
	},
	LIBSQL_SCENARIO_TIMEOUT_MS,
);

test("a named SQLite file selection is created by an import and read by an export; memory is refused (#4793)", async () => {
	const source = machine("a");
	await seed(source);
	const exported = join(root, "exported");
	assert.equal((await storage(source, ["export", exported])).code, 0);
	const target = machine("b");
	// A relative path names a file in the working directory.
	const file = { path: "moved.sqlite" };
	const empty = await storage(target, ["export", join(root, "none"), "--storage", JSON.stringify(file)]);
	assert.equal(empty.code, 0, empty.err);
	assert.equal(existsSync(join(project, file.path)), false, "an export creates no database");
	const imported = await storage(target, ["import", exported, "--storage", JSON.stringify(file)]);
	assert.equal(imported.code, 0, imported.err);
	assert.match(imported.out, /Imported 1 session .*\(1 added/);
	assert.ok(existsSync(join(project, file.path)));
	const reexported = join(root, "reexported");
	assert.equal((await storage(target, ["export", reexported, "--storage", JSON.stringify(file)])).code, 0);
	assert.deepEqual(tree(reexported), tree(exported));
	const memory = await storage(target, ["import", exported, "--storage", '{"memory":true}']);
	assert.equal(memory.code, 1);
	assert.match(memory.err, /keeps nothing/);
	const invalid = await storage(target, ["import", exported, "--storage", '{"adapter":""}']);
	assert.equal(invalid.code, 1);
	assert.match(invalid.err, /--storage \(invalid-adapter\)/);
	const noStore = await storage(target, ["import", exported, "--storage", "{}"]);
	assert.equal(noStore.code, 1);
	assert.match(noStore.err, /--storage names no storage/);
	const selectionFile = join(root, "invalid.json");
	writeFileSync(selectionFile, '{"adapter":""}');
	const invalidFile = await storage(target, ["import", exported, "--storage-file", selectionFile]);
	assert.match(invalidFile.err, /--storage-file \(invalid-adapter\)/);
	writeFileSync(selectionFile, "not json");
	const notJson = await storage(target, ["import", exported, "--storage-file", selectionFile]);
	assert.match(
		notJson.err,
		new RegExp(`--storage-file ${selectionFile.replaceAll("\\", "\\\\")} needs a JSON object`),
	);
	const unreadable = await storage(target, ["import", exported, "--storage-file", join(root, "absent.json")]);
	assert.equal(unreadable.code, 1);
	assert.match(unreadable.err, /--storage-file .*absent\.json cannot be read: .*ENOENT/);
});
