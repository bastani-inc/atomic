import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { parseArgs } from "../../packages/coding-agent/src/cli/args.js";
import { parseStorageCommand, runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import { ENV_AGENT_DIR } from "../../packages/coding-agent/src/config.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { createSessionManager } from "../../packages/coding-agent/src/main-session.js";
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
	root = makeTempDirectory("storage-transfer-");
	project = join(root, "project");
	exports = join(root, "drive", "state");
	mkdirSync(project, { recursive: true });
});
afterEach(async () => {
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

/** Every session file of an export directory, by its path relative to it. */
function tree(directory: string): Record<string, string> {
	const sessions = join(directory, "sessions");
	if (!existsSync(sessions)) return {};
	return Object.fromEntries(
		readdirSync(sessions)
			.sort()
			.map((name) => [`sessions/${name}`, readFileSync(join(sessions, name), "utf8")]),
	);
}

test("storage export and import parse --sessions, --limit and --since (#4720)", () => {
	const parsed = parseStorageCommand(["export", "out", "--sessions", "--since", "2026-11-01", "--limit", "2"]);
	assert.equal(parsed.kind, "export");
	assert.equal(parsed.kind === "export" ? parsed.directory : undefined, "out");
	assert.equal(parsed.kind === "export" ? parsed.limit : undefined, 2);
	assert.equal(parsed.kind === "export" ? parsed.since : undefined, Date.parse("2026-11-01"));
	const imported = parseStorageCommand(["import", "in", "--sessions"]);
	assert.equal(imported.kind === "import" ? imported.directory : undefined, "in");
	for (const args of [
		["export", "out", "--since", "yesterday"],
		["export", "out", "--limit", "0"],
		["import", "in", "--limit", "1"],
		["import", "in", "extra", "args"],
	])
		assert.throws(() => parseStorageCommand(args));
});

test("sessions export to sessions/, import into a fresh agent directory and re-export byte for byte (#4720)", async () => {
	const source = machine("a");
	const sessionId = await recordSession(source, ["hello", `my token is ${SECRET}`]);
	const exported = await storage(source, ["export", exports]);
	assert.equal(exported.code, 0, exported.err);
	assert.match(exported.out, /Exported 1 session to .*sessions \(1 written, 0 unchanged\)/);
	const before = tree(exports);
	assert.deepEqual(Object.keys(before), [`sessions/${sessionId}.jsonl`]);
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
	const again = join(root, "re-export");
	assert.equal((await storage(target, ["export", again])).code, 0);
	assert.deepEqual(tree(again), before, "the imported sessions export to the same bytes");
});

test("export selects sessions with --limit and --since (#4720)", async () => {
	const source = machine("a");
	const older = await recordSession(source, ["older"]);
	await sleep(20);
	const cutoff = new Date().toISOString();
	await sleep(20);
	const newer = await recordSession(source, ["newer"]);
	const select = async (name: string, args: string[]) => {
		const directory = join(root, name);
		const result = await storage(source, ["export", directory, ...args]);
		assert.equal(result.code, 0, result.err);
		return Object.keys(tree(directory)).map((file) => file.replace(".jsonl", ""));
	};
	assert.deepEqual(await select("sessions", ["--sessions"]), [`sessions/${newer}`, `sessions/${older}`].sort());
	assert.deepEqual(await select("limit", ["--limit", "1"]), [`sessions/${newer}`]);
	assert.deepEqual(await select("since", ["--sessions", "--since", cutoff]), [`sessions/${newer}`]);
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

test("importing again stores the tool outputs of a session an interrupted import added without them (#4720)", async () => {
	const source = machine("a");
	const sessionId = await recordSession(source, ["hello"]);
	await storage(source, ["export", exports, "--sessions"]);
	const file = join(exports, "sessions", `${sessionId}.jsonl`);
	const content = readFileSync(file, "utf8");
	const hash = JSON.parse(content.trimEnd().split("\n").at(-1)!).data.hash as string;
	// What an import stopped between writing the session's entries and its tool output leaves behind.
	const interrupted = join(root, "interrupted", `${sessionId}.jsonl`);
	mkdirSync(join(root, "interrupted"), { recursive: true });
	writeFileSync(interrupted, content.replace(/,"base64":"[^"]+"/, ""));
	const target = machine("b");
	const targetSessions = await sessionStore(target);
	await SessionManager.importFromJsonl(interrupted, project, targetSessions);
	assert.equal(await targetSessions.getBlob!(sessionId, hash), undefined);

	const rerun = await storage(target, ["import", exports]);
	assert.equal(rerun.code, 0, rerun.err);
	assert.match(rerun.out, /1 session .*1 already up to date/);
	assert.deepEqual(Buffer.from((await targetSessions.getBlob!(sessionId, hash))!).toString(), "tool output for hello");
});

test("a tool output that cannot be restored is reported, and a rerun restores it (#4720)", async () => {
	const source = machine("a");
	const sessionId = await recordSession(source, ["hello"]);
	await storage(source, ["export", exports]);
	const file = join(exports, "sessions", `${sessionId}.jsonl`);
	const hash = JSON.parse(readFileSync(file, "utf8").trimEnd().split("\n").at(-1)!).data.hash as string;
	const interrupted = join(root, "interrupted", `${sessionId}.jsonl`);
	mkdirSync(join(root, "interrupted"), { recursive: true });
	writeFileSync(interrupted, readFileSync(file, "utf8").replace(/,"base64":"[^"]+"/, ""));
	const target = machine("b");
	const store = await resolveSessionStore(project, { agentDir: target });
	await SessionManager.importFromJsonl(interrupted, project, store);
	await store.close();

	vi.spyOn(SqlSessionStore.prototype, "putBlob").mockRejectedValueOnce(new Error("disk full"));
	const failed = await storage(target, ["import", exports]);
	assert.equal(failed.code, 1);
	assert.match(failed.err, /disk full/);

	const rerun = await storage(target, ["import", exports]);
	assert.equal(rerun.code, 0, rerun.err);
	assert.match(rerun.out, /1 session .*1 already up to date/);
	const restored = await (await sessionStore(target)).getBlob!(sessionId, hash);
	assert.equal(Buffer.from(restored!).toString(), "tool output for hello");
});

test("session files whose strings a tool redacted import as what they came from (#4720)", async () => {
	const source = machine("a");
	const sessionId = await recordSession(source, [`my token is ${SECRET}`]);
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
	// The source still holds the unredacted session: the redacted file is the same one, so up to date.
	const back = await storage(source, ["import", exports]);
	assert.match(back.out, /1 session .*1 already up to date/);
	const again = join(root, "again");
	await storage(target, ["export", again]);
	assert.deepEqual(tree(again), redacted);
});

test("a malformed or unknown-version session file fails the import with its file and line, and nothing is imported (#4720)", async () => {
	const source = machine("a");
	const sessionId = await recordSession(source, ["hello"]);
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
	writeFileSync(join(exports, "stray.jsonl"), "not an export\n");
	const target = machine("b");
	for (const [content, message] of cases) {
		writeFileSync(file, content);
		const result = await storage(target, ["import", exports]);
		assert.equal(result.code, 1);
		assert.match(result.err, message);
		assert.ok(result.err.includes(file), result.err);
		assert.match(result.err, /Nothing was imported\./);
	}
	writeFileSync(file, original);
	const imported = await storage(target, ["import", exports]);
	assert.equal(imported.code, 0, imported.err);
	assert.match(imported.out, /1 session .*1 added/);
});

test("an import that fails after writing part of it names exactly what it wrote, and a rerun finishes without duplicates (#4720)", async () => {
	const source = machine("a");
	const first = await recordSession(source, ["first"]);
	const second = await recordSession(source, ["second"]);
	await storage(source, ["export", exports]);
	const target = machine("b");
	const targetSessions = await sessionStore(target);
	// While the import writes its first session, another process imports the other one on its own.
	const [early, late] = [first, second].sort();
	const create = SqlSessionStore.prototype.create;
	let raced = false;
	vi.spyOn(SqlSessionStore.prototype, "create").mockImplementation(async function (this: SqlSessionStore, ...args) {
		if (!raced) {
			raced = true;
			await SessionManager.importFromJsonl(join(exports, "sessions", `${late}.jsonl`), project, targetSessions);
		}
		return create.apply(this, args);
	});
	const partial = await storage(target, ["import", exports]);
	assert.equal(partial.code, 1);
	assert.match(partial.err, new RegExp(`session ${late} changed in .* after the import compared it`));
	assert.ok(partial.err.includes(`Imported before the failure: session ${early}.`), partial.err);
	assert.ok(partial.err.includes(`Not imported: session ${late}.`), partial.err);
	assert.match(partial.err, /Run the same import again to finish/);
	vi.restoreAllMocks();
	const counts = { early: await sessionEntries(target, early), late: await sessionEntries(target, late) };

	const rerun = await storage(target, ["import", exports]);
	assert.equal(rerun.code, 0, rerun.err);
	assert.match(rerun.out, /2 sessions .*\(0 added, 0 updated, 2 already up to date\)/);
	assert.deepEqual({ early: await sessionEntries(target, early), late: await sessionEntries(target, late) }, counts);
});

test("a session exported from one agent directory continues in a fresh one (#4720)", async () => {
	const machineA = machine("a");
	const sessionId = await recordSession(machineA, ["plan the release"]);
	const exported = await storage(machineA, ["export", exports]);
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
});

test("an exported session keeps the branch a /tree move without a summary selected, through import and --import (#3325)", async () => {
	const source = machine("a");
	const sourceStore = await resolveSessionStore(project, { agentDir: source });
	let sessionId: string;
	let selectedId: string;
	try {
		const manager = await SessionManager.create(sourceStore, project);
		await manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
		selectedId = manager.getLeafId()!;
		await manager.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
		await manager.recordBranch(selectedId);
		sessionId = manager.getSessionId();
	} finally {
		await sourceStore.close();
	}
	assert.equal((await storage(source, ["export", exports, "--sessions"])).code, 0);

	const target = machine("b");
	assert.equal((await storage(target, ["import", exports, "--sessions"])).code, 0);
	const imported = await SessionManager.open(await sessionStore(target), sessionId);
	assert.equal(imported.getLeafId(), selectedId);

	const viaImportFlag = await SessionManager.importFromJsonl(
		join(exports, "sessions", `${sessionId}.jsonl`),
		project,
		await sessionStore(machine("flag")),
	);
	assert.equal(viaImportFlag.getLeafId(), selectedId);
});

test("a session whose messages contain U+2028 and U+2029 exports and imports between SQLite and JSONL storage, and through --import (#4957)", async () => {
	const text = "a\u2028b\u2029c";
	const useJsonl = (agentDir: string) =>
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ sessions: { storage: { dir: "jsonl-sessions" } } }),
		);
	const userTexts = async (store: SessionStore, sessionId: string) =>
		(await store.load(sessionId)).entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
		);
	for (const from of ["sqlite", "jsonl"] as const) {
		const source = machine(`${from}-source`);
		if (from === "jsonl") useJsonl(source);
		const sourceStore = await sessionStore(source);
		const manager = await SessionManager.create(sourceStore, project);
		for (const content of [text, `${text}\u2028`])
			await manager.appendMessage({ role: "user", content, timestamp: Date.now() });
		const sessionId = manager.getSessionId();
		await sourceStore.close();
		const directory = join(root, `${from}-export`);
		const exported = await storage(source, ["export", directory, "--sessions"]);
		assert.equal(exported.code, 0, exported.err);
		const file = join(directory, "sessions", `${sessionId}.jsonl`);
		for (const to of ["sqlite", "jsonl"] as const) {
			const target = machine(`${from}-to-${to}`);
			if (to === "jsonl") useJsonl(target);
			const imported = await storage(target, ["import", directory, "--sessions"]);
			assert.equal(imported.code, 0, imported.err);
			assert.deepEqual(await userTexts(await sessionStore(target), sessionId), [text, `${text}\u2028`]);
			const again = join(root, `${from}-to-${to}-export`);
			assert.equal((await storage(target, ["export", again, "--sessions"])).code, 0);
			assert.equal(readFileSync(join(again, "sessions", `${sessionId}.jsonl`), "utf8"), readFileSync(file, "utf8"));

			const flagTarget = machine(`${from}-flag-${to}`);
			if (to === "jsonl") useJsonl(flagTarget);
			const flagStore = await sessionStore(flagTarget);
			const viaImportFlag = await SessionManager.importFromJsonl(file, project, flagStore);
			assert.deepEqual(await userTexts(flagStore, viaImportFlag.getSessionId()), [text, `${text}\u2028`]);
		}
	}
});
