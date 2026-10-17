import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.js";
import { SessionManager } from "../src/core/session-manager.js";
import { getDefaultSessionDirPath } from "../src/core/session-manager-paths.js";
import { resolveSessionStore, type SessionStorageOptions } from "../src/core/session-storage.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { createSessionManager } from "../src/main-session.js";
import { migrateLegacySessionsToDefaultStore } from "../src/migrations-sessions.js";
import { runCliProcess } from "./cli-test-helpers.js";

type JsonRecord = Record<string, string | number | boolean | null | object>;

interface Fixture {
	readonly id: string;
	readonly createdAt: string;
	lines(cwd: string, parentPath: string | undefined): JsonRecord[];
}

const ids = {
	v1: "0191f0a1-0000-7000-8000-000000000001",
	v2: "0191f0a1-0000-7000-8000-000000000002",
	v3: "0191f0a1-0000-7000-8000-000000000003",
	early4: "0191f0a1-0000-7000-8000-000000000004",
	v4: "0191f0a1-0000-7000-8000-000000000005",
	stage: "0191f0a1-0000-7000-8000-000000000006",
};

const userRecord = (
	text: string,
	createdAt: string,
	offsetSeconds: number,
	link?: { id: string; parentId: string | null },
): JsonRecord => ({
	type: "message",
	...link,
	timestamp: new Date(Date.parse(createdAt) + offsetSeconds * 1000).toISOString(),
	message: { role: "user", content: text, timestamp: Date.parse(createdAt) + offsetSeconds * 1000 },
});

const assistantRecord = (
	text: string,
	createdAt: string,
	offsetSeconds: number,
	link?: { id: string; parentId: string | null },
): JsonRecord => ({
	type: "message",
	...link,
	timestamp: new Date(Date.parse(createdAt) + offsetSeconds * 1000).toISOString(),
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "anthropic",
		model: "claude",
		timestamp: Date.parse(createdAt) + offsetSeconds * 1000,
	},
});

const fixtures = {
	v1: {
		id: ids.v1,
		createdAt: "2025-03-01T10:00:00.000Z",
		lines: (cwd) => [
			{ type: "session", id: ids.v1, timestamp: "2025-03-01T10:00:00.000Z", cwd },
			userRecord("Explain the v1 parser", "2025-03-01T10:00:00.000Z", 1),
			assistantRecord("It reads JSONL.", "2025-03-01T10:00:00.000Z", 2),
			{
				type: "compaction",
				timestamp: "2025-03-01T10:00:03.000Z",
				summary: "Discussed the parser",
				firstKeptEntryIndex: 2,
				tokensBefore: 120,
			},
		],
	},
	v2: {
		id: ids.v2,
		createdAt: "2025-05-01T10:00:00.000Z",
		lines: (cwd) => [
			{ type: "session", version: 2, id: ids.v2, timestamp: "2025-05-01T10:00:00.000Z", cwd },
			userRecord("Review the v2 hooks", "2025-05-01T10:00:00.000Z", 1, { id: "a0000001", parentId: null }),
			{
				type: "message",
				id: "a0000002",
				parentId: "a0000001",
				timestamp: "2025-05-01T10:00:02.000Z",
				message: {
					role: "hookMessage",
					customType: "reminder",
					content: "Hook note",
					display: true,
					timestamp: Date.parse("2025-05-01T10:00:02.000Z"),
				},
			},
		],
	},
	v3: {
		id: ids.v3,
		createdAt: "2025-08-01T10:00:00.000Z",
		lines: (cwd, parentPath) => [
			{
				type: "session",
				version: 3,
				id: ids.v3,
				timestamp: "2025-08-01T10:00:00.000Z",
				cwd,
				...(parentPath === undefined ? {} : { parentSession: parentPath }),
			},
			userRecord("Refactor the v3 auth module", "2025-08-01T10:00:00.000Z", 1, { id: "b0000001", parentId: null }),
			{
				type: "session_info",
				id: "b0000002",
				parentId: "b0000001",
				timestamp: "2025-08-01T10:00:02.000Z",
				name: "Legacy auth refactor",
			},
		],
	},
	early4: {
		id: ids.early4,
		createdAt: "2026-10-15T10:00:00.000Z",
		lines: (cwd, parentPath) => [
			{
				type: "session",
				version: 4,
				id: ids.early4,
				timestamp: "2026-10-15T10:00:00.000Z",
				cwd,
				...(parentPath === undefined ? {} : { parentSession: parentPath }),
			},
			userRecord("Continue the alpha.4 session", "2026-10-15T10:00:00.000Z", 1, { id: "c0000001", parentId: null }),
			assistantRecord("Continuing.", "2026-10-15T10:00:00.000Z", 2, { id: "c0000002", parentId: "c0000001" }),
		],
	},
	v4: {
		id: ids.v4,
		createdAt: "2026-10-16T10:00:00.000Z",
		lines: (cwd) => [
			{ type: "session", version: 4, id: ids.v4, createdAt: "2026-10-16T10:00:00.000Z", cwd },
			userRecord("Resume the alpha.6 session", "2026-10-16T10:00:00.000Z", 1, { id: "d0000001", parentId: null }),
			assistantRecord("Resumed.", "2026-10-16T10:00:00.000Z", 2, { id: "d0000002", parentId: "d0000001" }),
		],
	},
	stage: {
		id: ids.stage,
		createdAt: "2026-10-16T12:00:00.000Z",
		lines: (cwd, parentPath) => [
			{
				type: "session",
				version: 3,
				id: ids.stage,
				timestamp: "2026-10-16T12:00:00.000Z",
				cwd,
				...(parentPath === undefined ? {} : { parentSession: parentPath }),
				internal: true,
				workflow: { runId: "run-1", stageId: "stage-1", stageName: "review" },
			},
			userRecord("Review the diff", "2026-10-16T12:00:00.000Z", 1, { id: "e0000001", parentId: null }),
			assistantRecord("Looks fine.", "2026-10-16T12:00:00.000Z", 2, { id: "e0000002", parentId: "e0000001" }),
		],
	},
} satisfies Record<string, Fixture>;

const encode = (lines: readonly object[]): string => `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

function snapshotFiles(directory: string): Record<string, { content: string; mtimeMs: number }> {
	const files: Record<string, { content: string; mtimeMs: number }> = {};
	const visit = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				files[`${relative(directory, path)}/`] = { content: "", mtimeMs: 0 };
				visit(path);
			} else
				files[relative(directory, path)] = { content: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
		}
	};
	visit(directory);
	return files;
}

describe("legacy JSONL session import into the default store", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	let legacyDirectory: string;
	let defaultDatabase: string;
	let importMarker: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-legacy-import-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		legacyDirectory = getDefaultSessionDirPath(cwd, agentDir);
		defaultDatabase = join(root, "workflows", "journal.sqlite");
		importMarker = `${defaultDatabase}.legacy-session-import.json`;
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv(ENV_SESSION_DIR, "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	function writeLegacy(fixture: Fixture, parentPath?: string, directory = legacyDirectory): string {
		mkdirSync(directory, { recursive: true });
		const path = join(directory, `${fixture.createdAt.replace(/[:.]/g, "-")}_${fixture.id}.jsonl`);
		writeFileSync(path, encode(fixture.lines(cwd, parentPath)));
		return path;
	}

	function writeAllFormats(): { paths: Record<"v1" | "v2" | "v3" | "early4" | "v4", string> } {
		const v1 = writeLegacy(fixtures.v1);
		const v2 = writeLegacy(fixtures.v2);
		const v3 = writeLegacy(fixtures.v3, v2);
		const early4 = writeLegacy(fixtures.early4, v3);
		const v4 = writeLegacy(fixtures.v4);
		return { paths: { v1, v2, v3, early4, v4 } };
	}

	const migrate = (options: SessionStorageOptions = {}) =>
		migrateLegacySessionsToDefaultStore(cwd, { agentDir, settings: {}, ...options });

	async function withDefaultStore<T>(body: (store: SessionStore) => Promise<T>): Promise<T> {
		const store = await resolveSessionStore(cwd, { agentDir, settings: {} });
		try {
			return await body(store);
		} finally {
			await store.close();
		}
	}

	it("lists sessions of every legacy format for /resume, newest first", async () => {
		writeAllFormats();

		await migrate();

		await withDefaultStore(async (store) => {
			const listed = await SessionManager.list(cwd, store);
			assert.deepEqual(
				listed.map((session) => session.id),
				[ids.v4, ids.early4, ids.v3, ids.v2, ids.v1],
			);
			const byId = new Map(listed.map((session) => [session.id, session]));
			assert.equal(byId.get(ids.v1)?.firstMessage, "Explain the v1 parser");
			assert.equal(byId.get(ids.v2)?.firstMessage, "Review the v2 hooks");
			assert.equal(byId.get(ids.v3)?.name, "Legacy auth refactor");
			assert.equal(byId.get(ids.early4)?.firstMessage, "Continue the alpha.4 session");
			assert.equal(byId.get(ids.early4)?.created.toISOString(), fixtures.early4.createdAt);
			assert.equal(byId.get(ids.v4)?.created.toISOString(), fixtures.v4.createdAt);
			for (const session of listed) assert.equal(session.internal, undefined);
		});
	});

	it("opens each imported session with upgraded entries and parent links", async () => {
		writeAllFormats();

		await migrate();

		await withDefaultStore(async (store) => {
			const v1 = await SessionManager.open(store, ids.v1);
			const v1Entries = v1.getEntries();
			assert.equal(v1.getHeader()?.version, 4);
			assert.equal(v1.getHeader()?.createdAt, fixtures.v1.createdAt);
			assert.deepEqual(
				v1Entries.map((entry) => entry.parentId),
				[null, v1Entries[0]!.id, v1Entries[1]!.id],
			);
			const compaction = v1Entries[2]!;
			assert.equal(compaction.type === "compaction" ? compaction.firstKeptEntryId : undefined, v1Entries[1]!.id);

			const v2 = await SessionManager.open(store, ids.v2);
			const hook = v2.getEntries()[1]!;
			assert.equal(hook.type === "message" ? hook.message.role : undefined, "custom");

			const v3 = await SessionManager.open(store, ids.v3);
			assert.equal(v3.getHeader()?.parentSessionId, ids.v2);
			assert.equal(v3.getSessionName(), "Legacy auth refactor");

			const early4 = await SessionManager.open(store, ids.early4);
			assert.equal(early4.getHeader()?.createdAt, fixtures.early4.createdAt);
			assert.equal(early4.getHeader()?.parentSessionId, ids.v3);
			assert.deepEqual(
				early4.getEntries().map((entry) => entry.id),
				["c0000001", "c0000002"],
			);
			assert.deepEqual(
				early4.buildSessionContext().messages.map((message) => message.role),
				["user", "assistant"],
			);

			const v4 = await SessionManager.open(store, ids.v4);
			assert.deepEqual(
				v4.getEntries().map((entry) => entry.id),
				["d0000001", "d0000002"],
			);
			assert.equal(v4.getHeader()?.parentSessionId, undefined);
		});
	});

	it("resumes an imported session and keeps its new messages across later startups", async () => {
		writeAllFormats();
		await migrate();
		await withDefaultStore(async (store) => {
			const resumed = await SessionManager.open(store, ids.v3);
			await resumed.appendMessage({ role: "user", content: "follow-up after import", timestamp: Date.now() });
		});

		await migrate();

		await withDefaultStore(async (store) => {
			const reopened = await SessionManager.open(store, ids.v3);
			const last = reopened.buildSessionContext().messages.at(-1);
			assert.equal(last?.role === "user" ? last.content : undefined, "follow-up after import");
			assert.equal(reopened.getEntries().length, 3);
			assert.equal((await SessionManager.list(cwd, store)).length, 5);
		});
	});

	it("keeps imported sessions unchanged when run again", async () => {
		writeAllFormats();
		await migrate();
		const before = await withDefaultStore(async (store) =>
			JSON.stringify(await Promise.all(Object.values(ids).map((id) => store.load(id).catch(() => null)))),
		);

		await migrate();
		await migrate();

		await withDefaultStore(async (store) => {
			assert.equal((await SessionManager.listAll(store)).length, 5);
			const after = JSON.stringify(
				await Promise.all(Object.values(ids).map((id) => store.load(id).catch(() => null))),
			);
			assert.equal(after, before);
		});
	});

	it("does not bring back a session deleted after the import", async () => {
		writeAllFormats();
		await migrate();
		await withDefaultStore((store) => store.delete(ids.v2));

		await migrate();

		await withDefaultStore(async (store) => {
			assert.equal(await store.readHeader(ids.v2), undefined);
			assert.deepEqual(
				(await SessionManager.listAll(store)).map((session) => session.id).sort(),
				[ids.v1, ids.v3, ids.early4, ids.v4].sort(),
			);
		});
	});

	it("imports only once, so legacy files added after the first import are ignored", async () => {
		writeAllFormats();
		await migrate();

		writeLegacy(fixtures.stage);
		await migrate();

		await withDefaultStore(async (store) => {
			assert.equal(await store.readHeader(ids.stage), undefined);
			assert.equal((await SessionManager.listAll(store, undefined, { includeInternal: true })).length, 5);
		});
		assert.equal(existsSync(importMarker), true);
	});

	it("records completion outside the legacy session directory", async () => {
		writeAllFormats();
		const before = snapshotFiles(join(agentDir, "sessions"));

		await migrate();

		assert.equal(existsSync(importMarker), true);
		assert.deepEqual(snapshotFiles(join(agentDir, "sessions")), before);
	});

	it("does not record completion when the default store cannot be opened, and imports on the next run", async () => {
		writeAllFormats();
		mkdirSync(defaultDatabase, { recursive: true });

		await assert.doesNotReject(migrate());

		assert.equal(existsSync(importMarker), false);
		rmSync(defaultDatabase, { recursive: true, force: true });

		await migrate();

		assert.equal(existsSync(importMarker), true);
		await withDefaultStore(async (store) => {
			assert.equal((await SessionManager.listAll(store)).length, 5);
		});
	});

	it("records completion after skipping unreadable files so they are not rescanned", async () => {
		writeAllFormats();
		writeFileSync(join(legacyDirectory, "garbage.jsonl"), "this is not a session\n");

		await migrate();

		assert.equal(existsSync(importMarker), true);
	});

	it("imports again when the completion record is unreadable", async () => {
		writeAllFormats();
		mkdirSync(dirname(importMarker), { recursive: true });
		writeFileSync(importMarker, "{not json");

		await migrate();

		await withDefaultStore(async (store) => {
			assert.equal((await SessionManager.listAll(store)).length, 5);
		});
		assert.equal(JSON.parse(readFileSync(importMarker, "utf8")).version, 1);
	});

	it("still imports when the completion record cannot be written", async () => {
		writeAllFormats();
		mkdirSync(importMarker, { recursive: true });

		await assert.doesNotReject(migrate());

		await withDefaultStore(async (store) => {
			assert.equal((await SessionManager.listAll(store)).length, 5);
		});
		assert.deepEqual(
			readdirSync(dirname(importMarker)).filter((name) => name.endsWith(".tmp")),
			[],
		);
	});

	it("leaves the original session files and directories untouched", async () => {
		writeAllFormats();
		writeLegacy(fixtures.stage);
		const before = snapshotFiles(join(agentDir, "sessions"));

		await migrate();
		await migrate();

		assert.deepEqual(snapshotFiles(join(agentDir, "sessions")), before);
	});

	it("does nothing when there is no legacy session directory", async () => {
		await migrate();

		assert.equal(existsSync(defaultDatabase), false);
		assert.equal(existsSync(importMarker), false);
		assert.equal(existsSync(join(agentDir, "sessions")), false);
	});

	const explicitSelections: ReadonlyArray<readonly [string, () => SessionStorageOptions, () => string]> = [
		[
			"settings sessions.storage.dir",
			() => ({ settings: { sessions: { storage: { dir: join(root, "explicit-jsonl") } } } }),
			() => join(root, "explicit-jsonl"),
		],
		[
			"settings sessions.storage path",
			() => ({ settings: { sessions: { storage: { path: join(root, "settings.sqlite") } } } }),
			() => join(root, "settings.sqlite"),
		],
		[
			"settings shared storage path",
			() => ({ settings: { storage: { path: join(root, "shared.sqlite") } } }),
			() => join(root, "shared.sqlite"),
		],
		["--session-dir", () => ({ sessionDir: join(root, "cli-jsonl") }), () => join(root, "cli-jsonl")],
		["--session-store", () => ({ sessionStorePath: join(root, "cli.sqlite") }), () => join(root, "cli.sqlite")],
		[
			"an SDK sessionStore selection",
			() => ({ sessionStore: { kind: "sqlite", path: join(root, "sdk.sqlite") } }),
			() => join(root, "sdk.sqlite"),
		],
	];

	for (const [name, options, selectedLocation] of explicitSelections) {
		it(`does not import when ${name} selects the store`, async () => {
			writeAllFormats();

			await migrate(options());

			assert.equal(existsSync(defaultDatabase), false);
			assert.equal(existsSync(importMarker), false);
			assert.equal(existsSync(selectedLocation()), false);
		});
	}

	it("does not import when ATOMIC_CODING_AGENT_SESSION_DIR selects the store", async () => {
		writeAllFormats();
		vi.stubEnv(ENV_SESSION_DIR, join(root, "env-jsonl"));

		await migrate();

		assert.equal(existsSync(defaultDatabase), false);
		assert.equal(existsSync(importMarker), false);
		assert.equal(existsSync(join(root, "env-jsonl")), false);
	});

	it("does not import into a caller-supplied session store", async () => {
		writeAllFormats();
		const supplied = new MemorySessionStore();

		await migrate({ sessionStore: supplied });

		assert.equal(existsSync(defaultDatabase), false);
		assert.equal(existsSync(importMarker), false);
		assert.deepEqual(await SessionManager.listAll(supplied), []);
	});

	it("skips unreadable and unsupported files while importing the valid ones", async () => {
		writeAllFormats();
		mkdirSync(legacyDirectory, { recursive: true });
		const header = { type: "session", id: "broken", createdAt: "2026-10-16T09:00:00.000Z", cwd };
		const broken: Record<string, string> = {
			"garbage.jsonl": "this is not a session\n",
			"empty.jsonl": "",
			"torn.jsonl": `${JSON.stringify({ ...header, version: 4, id: "torn" })}\n{"type":"message","id":"x`,
			"future.jsonl": encode([{ ...header, version: 5, id: "future" }]),
			"bad-entry.jsonl": encode([
				{ type: "session", version: 3, id: "bad-entry", timestamp: header.createdAt, cwd },
				{ type: "message", id: "m1", parentId: null, timestamp: header.createdAt, message: null },
			]),
		};
		for (const [name, content] of Object.entries(broken)) writeFileSync(join(legacyDirectory, name), content);
		const before = snapshotFiles(join(agentDir, "sessions"));

		await assert.doesNotReject(migrate());

		await withDefaultStore(async (store) => {
			assert.deepEqual(
				(await SessionManager.listAll(store)).map((session) => session.id).sort(),
				[ids.v1, ids.v2, ids.v3, ids.early4, ids.v4].sort(),
			);
		});
		assert.deepEqual(snapshotFiles(join(agentDir, "sessions")), before);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"imports readable projects when another legacy project directory cannot be read",
		async () => {
			writeAllFormats();
			const locked = join(agentDir, "sessions", "--locked-project--");
			mkdirSync(locked, { recursive: true });
			chmodSync(locked, 0o000);
			try {
				await migrate();
			} finally {
				chmodSync(locked, 0o755);
			}

			await withDefaultStore(async (store) => {
				assert.equal((await SessionManager.listAll(store)).length, 5);
			});
			assert.equal(existsSync(importMarker), true);
		},
	);

	it("skips a transcript with a damaged content block and imports the sessions after it", async () => {
		writeAllFormats();
		const damagedId = "0191f0a1-0000-7000-8000-0000000000aa";
		const createdAt = "2024-01-01T00:00:00.000Z";
		writeLegacy({
			id: damagedId,
			createdAt,
			lines: (projectCwd) => [
				{ type: "session", version: 3, id: damagedId, timestamp: createdAt, cwd: projectCwd },
				{
					type: "message",
					id: "d0000001",
					parentId: null,
					timestamp: createdAt,
					message: { role: "user", content: [null], timestamp: Date.parse(createdAt) },
				},
			],
		});

		await migrate();

		await withDefaultStore(async (store) => {
			assert.equal(await store.readHeader(damagedId), undefined);
			assert.equal((await SessionManager.listAll(store)).length, 5);
		});
		assert.equal(existsSync(importMarker), true);
	});

	it("waits for a concurrent import and does not repeat it once that import has finished", async () => {
		writeAllFormats();
		mkdirSync(dirname(importMarker), { recursive: true });
		const release = await lockfile.lock(importMarker, { realpath: false });

		const waiting = migrate();
		writeFileSync(importMarker, `${JSON.stringify({ version: 1, completedAt: new Date().toISOString() })}\n`);
		await release();
		await waiting;

		await withDefaultStore(async (store) => {
			assert.deepEqual(await SessionManager.listAll(store), []);
		});
	});

	it("imports sessions from other projects and a repeated id without aborting the batch", async () => {
		const otherCwd = join(root, "other-project");
		mkdirSync(otherCwd);
		writeLegacy(fixtures.v4);
		writeLegacy(fixtures.v4, undefined, join(agentDir, "sessions", "--copy-of-project--"));
		writeLegacy(
			{ ...fixtures.v3, lines: (_cwd, parentPath) => fixtures.v3.lines(otherCwd, parentPath) },
			undefined,
			getDefaultSessionDirPath(otherCwd, agentDir),
		);

		await migrate();

		await withDefaultStore(async (store) => {
			assert.deepEqual(
				(await SessionManager.listAll(store)).map((session) => session.id).sort(),
				[ids.v3, ids.v4].sort(),
			);
			assert.deepEqual(
				(await SessionManager.list(cwd, store)).map((session) => session.id),
				[ids.v4],
			);
			assert.deepEqual(
				(await SessionManager.list(otherCwd, store)).map((session) => session.id),
				[ids.v3],
			);
		});
	});

	it("keeps workflow stage sessions hidden from /resume but loadable with their parent link", async () => {
		const { paths } = writeAllFormats();
		writeLegacy(fixtures.stage, paths.v4);

		await migrate();

		await withDefaultStore(async (store) => {
			assert.ok(!(await SessionManager.list(cwd, store)).some((session) => session.id === ids.stage));
			assert.equal((await store.findMostRecent({ cwd }))?.id, ids.v4);
			const hidden = await SessionManager.list(cwd, store, undefined, { includeInternal: true });
			const stage = hidden.find((session) => session.id === ids.stage);
			assert.equal(stage?.internal, true);
			assert.deepEqual(stage?.workflow, { runId: "run-1", stageId: "stage-1", stageName: "review" });
			const header = (await store.load(ids.stage)).header;
			assert.equal(header.internal, true);
			assert.deepEqual(header.workflow, { runId: "run-1", stageId: "stage-1", stageName: "review" });
			assert.equal(header.parentSessionId, ids.v4);
			const opened = await SessionManager.open(store, ids.stage);
			assert.deepEqual(
				opened.buildSessionContext().messages.map((message) => message.role),
				["user", "assistant"],
			);
		});
		assert.equal(await SessionManager.findById(cwd, ids.stage), undefined);
	});

	it("lets --session and --continue reach imported sessions", async () => {
		const { paths } = writeAllFormats();
		writeLegacy(fixtures.stage, paths.v4);
		await migrate();
		const settings = SettingsManager.inMemory();
		const open = async (args: string[]) => {
			const manager = await createSessionManager(parseArgs(args), cwd, undefined, settings);
			try {
				return manager.getSessionId();
			} finally {
				await manager.getSessionStore().close();
			}
		};

		assert.equal(await open(["--session", ids.v1]), ids.v1);
		assert.equal(await open(["--session", ids.early4]), ids.early4);
		assert.equal(await open(["--session", ids.stage]), ids.stage);
		assert.equal(await open(["--continue"]), ids.v4);
	});

	describe("at CLI startup", () => {
		const REAL_CLI_STARTUP_TEST_TIMEOUT_MS = 60_000;

		function runCli(args: string[]) {
			return runCliProcess(args, {
				cwd,
				env: { ...process.env, [ENV_AGENT_DIR]: agentDir, [ENV_SESSION_DIR]: "", ATOMIC_OFFLINE: "1" },
			});
		}

		it(
			"imports legacy sessions before --session resolves them",
			async () => {
				writeLegacy(fixtures.v3);

				const result = await runCli([
					"--session",
					ids.v3,
					"--name",
					"Resumed legacy",
					"--model",
					"missing-model",
					"-p",
					"hi",
				]);

				assert.equal(result.code, 1);
				assert.doesNotMatch(result.stderr, /No session found/);
				await withDefaultStore(async (store) => {
					const resumed = await SessionManager.open(store, ids.v3);
					assert.equal(resumed.getSessionName(), "Resumed legacy");
					assert.equal(resumed.getHeader()?.version, 4);
				});
			},
			REAL_CLI_STARTUP_TEST_TIMEOUT_MS,
		);

		it(
			"leaves legacy sessions alone when --session-dir selects another store",
			async () => {
				writeLegacy(fixtures.v3);

				const result = await runCli([
					"--session-dir",
					join(root, "explicit-jsonl"),
					"--session",
					ids.v3,
					"--model",
					"missing-model",
					"-p",
					"hi",
				]);

				assert.equal(result.code, 1);
				assert.match(result.stderr, /No session found/);
				assert.equal(existsSync(defaultDatabase), false);
			},
			REAL_CLI_STARTUP_TEST_TIMEOUT_MS,
		);
	});
});
