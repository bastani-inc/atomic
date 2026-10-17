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
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.js";
import { SessionManager } from "../src/core/session-manager.js";
import { getDefaultSessionDirPath } from "../src/core/session-manager-paths.js";
import { resolveSessionStore, type SessionStorageOptions } from "../src/core/session-storage.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { createSessionManager } from "../src/main-session.js";
import { runCliProcess } from "./cli-test-helpers.js";
import { TestSqliteDatabase } from "./helpers/sqlite.js";

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

const LARGE_FILLER_MESSAGES = 600;
const LARGE_FIRST_TEXT = "Plan the large migration";

interface LargeSessionOptions {
	readonly id: string;
	readonly cwd: string;
	readonly lastAt: string;
	readonly firstText?: string;
	readonly name?: string;
	readonly damagedMiddle?: boolean;
	readonly tornTail?: boolean;
}

/** A well over 32 KiB session whose summary lives in its first user message and its last entries. */
function largeLegacyContent(options: LargeSessionOptions): string {
	const createdAt = "2026-10-01T00:00:00.000Z";
	let previous: string | null = null;
	let sequence = 0;
	const link = (): { id: string; parentId: string | null } => {
		const id = `e${String(sequence++).padStart(7, "0")}`;
		const linked = { id, parentId: previous };
		previous = id;
		return linked;
	};
	const lines = [
		JSON.stringify({ type: "session", version: 4, id: options.id, createdAt, cwd: options.cwd }),
		JSON.stringify(userRecord(options.firstText ?? LARGE_FIRST_TEXT, createdAt, 1, link())),
	];
	for (let index = 0; index < LARGE_FILLER_MESSAGES; index++) {
		lines.push(
			JSON.stringify(assistantRecord(`middle-only ${index} ${"x".repeat(1_000)}`, createdAt, 10 + index, link())),
		);
		if (options.damagedMiddle && index === LARGE_FILLER_MESSAGES / 2) lines.push("this middle line is not json");
	}
	if (options.name !== undefined) {
		lines.push(JSON.stringify({ type: "session_info", ...link(), timestamp: options.lastAt, name: options.name }));
	}
	lines.push(JSON.stringify(userRecord("Final question", options.lastAt, 0, link())));
	const answer = link();
	lines.push(JSON.stringify(assistantRecord("Final answer", options.lastAt, 1, answer)));
	lines.push(
		JSON.stringify({
			type: "session_summary",
			...link(),
			timestamp: options.lastAt,
			summary: "Large migration plan",
			summarizedThroughId: answer.id,
		}),
	);
	return `${lines.join("\n")}\n${options.tornTail ? '{"type":"message","id":"x' : ""}`;
}

describe("legacy JSONL sessions in the default store", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	let legacyDirectory: string;
	let defaultDatabase: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-legacy-import-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		legacyDirectory = getDefaultSessionDirPath(cwd, agentDir);
		defaultDatabase = join(root, "workflows", "journal.sqlite");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv(ENV_SESSION_DIR, "");
	});

	afterEach(() => {
		vi.restoreAllMocks();
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

	function convertedIds(): string[] {
		if (!existsSync(defaultDatabase)) return [];
		const database = new TestSqliteDatabase(defaultDatabase);
		try {
			return database
				.query("SELECT id FROM session_sessions ORDER BY id")
				.all()
				.map((row) => String(row.id));
		} finally {
			database.close();
		}
	}

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
			assert.equal(byId.get(ids.v4)?.messageCount, 2);
			for (const session of listed) assert.equal(session.internal, undefined);
		});
	});

	it("opens each imported session with upgraded entries and parent links", async () => {
		writeAllFormats();

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
		await withDefaultStore(async (store) => {
			const resumed = await SessionManager.open(store, ids.v3);
			await resumed.appendMessage({ role: "user", content: "follow-up after import", timestamp: Date.now() });
		});

		await withDefaultStore(async (store) => {
			const reopened = await SessionManager.open(store, ids.v3);
			const last = reopened.buildSessionContext().messages.at(-1);
			assert.equal(last?.role === "user" ? last.content : undefined, "follow-up after import");
			assert.equal(reopened.getEntries().length, 3);
			assert.equal((await SessionManager.list(cwd, store)).length, 5);
		});
	});

	it("lists legacy sessions without converting them, and converts only the one that is opened", async () => {
		writeAllFormats();

		await withDefaultStore(async (store) => {
			assert.equal((await SessionManager.list(cwd, store)).length, 5);
			assert.equal((await store.findMostRecent({ cwd }))?.id, ids.v4);
		});
		assert.deepEqual(convertedIds(), []);

		await withDefaultStore((store) => SessionManager.open(store, ids.v2));

		assert.deepEqual(convertedIds(), [ids.v2]);
		await withDefaultStore(async (store) => {
			assert.equal((await SessionManager.list(cwd, store)).length, 5);
		});
	});

	it("refreshes a listed legacy session when its file changes on disk", async () => {
		const { paths } = writeAllFormats();
		await withDefaultStore(async (store) => {
			const before = await SessionManager.list(cwd, store);
			assert.equal(before.find((session) => session.id === ids.v3)?.name, "Legacy auth refactor");

			const lines = fixtures.v3.lines(cwd, paths.v2);
			lines.push({
				type: "session_info",
				id: "b0000003",
				parentId: "b0000002",
				timestamp: "2025-08-01T10:00:03.000Z",
				name: "Renamed elsewhere",
			});
			writeFileSync(paths.v3, encode(lines));

			const after = await SessionManager.list(cwd, store);
			assert.equal(after.find((session) => session.id === ids.v3)?.name, "Renamed elsewhere");
		});
	});

	it("converts a legacy session once and reads it from the database afterwards", async () => {
		writeAllFormats();
		const first = await withDefaultStore(async (store) => (await store.load(ids.v1)).entries);

		const again = await withDefaultStore(async (store) => (await store.load(ids.v1)).entries);

		assert.deepEqual(again, first);
		assert.deepEqual(convertedIds(), [ids.v1]);
	});

	it("does not list a legacy session again after it is deleted", async () => {
		writeAllFormats();
		await withDefaultStore((store) => SessionManager.open(store, ids.v2));
		await withDefaultStore(async (store) => {
			await store.delete(ids.v2);
			await store.delete(ids.v1);
		});

		await withDefaultStore(async (store) => {
			assert.equal(await store.readHeader(ids.v1), undefined);
			assert.equal(await store.readHeader(ids.v2), undefined);
			await assert.rejects(store.load(ids.v1));
			assert.deepEqual(
				(await SessionManager.listAll(store)).map((session) => session.id).sort(),
				[ids.v3, ids.early4, ids.v4].sort(),
			);
		});
	});

	it("leaves the original session files and directories untouched", async () => {
		writeAllFormats();
		writeLegacy(fixtures.stage);
		const before = snapshotFiles(join(agentDir, "sessions"));

		await withDefaultStore(async (store) => {
			await SessionManager.listAll(store, undefined, { includeInternal: true });
			for (const id of Object.values(ids)) await SessionManager.open(store, id);
			await store.delete(ids.v1);
		});

		assert.deepEqual(snapshotFiles(join(agentDir, "sessions")), before);
	});

	it("does not create the legacy directory or extra tables when there is none", async () => {
		await withDefaultStore(async (store) => {
			assert.deepEqual(await SessionManager.listAll(store), []);
			assert.equal(await store.readHeader(ids.v1), undefined);
		});

		assert.equal(existsSync(join(agentDir, "sessions")), false);
		const database = new TestSqliteDatabase(defaultDatabase);
		try {
			assert.equal(
				database.query("SELECT name FROM sqlite_master WHERE name = 'session_legacy_deleted'").get(),
				undefined,
			);
		} finally {
			database.close();
		}
	});

	const explicitSelections: ReadonlyArray<readonly [string, () => SessionStorageOptions]> = [
		[
			"settings sessions.storage.dir",
			() => ({ settings: { sessions: { storage: { dir: join(root, "explicit-jsonl") } } } }),
		],
		[
			"settings sessions.storage path",
			() => ({ settings: { sessions: { storage: { path: join(root, "settings.sqlite") } } } }),
		],
		["settings shared storage path", () => ({ settings: { storage: { path: join(root, "shared.sqlite") } } })],
		["--session-dir", () => ({ settings: {}, sessionDir: join(root, "cli-jsonl") })],
		["--session-store", () => ({ settings: {}, sessionStorePath: join(root, "cli.sqlite") })],
		[
			"an SDK sessionStore selection",
			() => ({ settings: {}, sessionStore: { kind: "sqlite", path: join(root, "sdk.sqlite") } }),
		],
		["a caller-supplied session store", () => ({ settings: {}, sessionStore: new MemorySessionStore() })],
	];

	for (const [name, options] of explicitSelections) {
		it(`does not show legacy sessions when ${name} selects the store`, async () => {
			writeAllFormats();
			const store = await resolveSessionStore(cwd, { agentDir, ...options() });
			try {
				assert.deepEqual(await SessionManager.listAll(store), []);
				assert.equal(await store.readHeader(ids.v1), undefined);
			} finally {
				await store.close();
			}
			assert.equal(existsSync(defaultDatabase), false);
		});
	}

	it("does not show legacy sessions when ATOMIC_CODING_AGENT_SESSION_DIR selects the store", async () => {
		writeAllFormats();
		vi.stubEnv(ENV_SESSION_DIR, join(root, "env-jsonl"));
		const store = await resolveSessionStore(cwd, { agentDir, settings: {} });
		try {
			assert.deepEqual(await SessionManager.listAll(store), []);
		} finally {
			await store.close();
		}
		assert.equal(existsSync(defaultDatabase), false);
	});

	it("shows legacy sessions in the engine child, which receives the default database explicitly", async () => {
		writeAllFormats();
		const store = await resolveSessionStore(cwd, {
			agentDir,
			settings: {},
			sessionStore: { kind: "sqlite", path: defaultDatabase },
		});
		try {
			assert.equal((await SessionManager.list(cwd, store)).length, 5);
		} finally {
			await store.close();
		}
	});

	it("skips unreadable, unsupported and damaged files while listing the valid ones", async () => {
		writeAllFormats();
		mkdirSync(legacyDirectory, { recursive: true });
		const header = { type: "session", id: "broken", createdAt: "2026-10-16T09:00:00.000Z", cwd };
		const damagedAt = "2024-01-01T00:00:00.000Z";
		const broken: Record<string, string> = {
			"garbage.jsonl": "this is not a session\n",
			"empty.jsonl": "",
			"torn.jsonl": `${JSON.stringify({ ...header, version: 4, id: "torn" })}\n{"type":"message","id":"x`,
			"future.jsonl": encode([{ ...header, version: 5, id: "future" }]),
			"bad-entry.jsonl": encode([
				{ type: "session", version: 3, id: "bad-entry", timestamp: header.createdAt, cwd },
				{ type: "message", id: "m1", parentId: null, timestamp: header.createdAt, message: null },
			]),
			"null-block.jsonl": encode([
				{ type: "session", version: 3, id: "null-block", timestamp: damagedAt, cwd },
				{
					type: "message",
					id: "d0000001",
					parentId: null,
					timestamp: damagedAt,
					message: { role: "user", content: [null], timestamp: Date.parse(damagedAt) },
				},
			]),
		};
		for (const [name, content] of Object.entries(broken)) writeFileSync(join(legacyDirectory, name), content);

		await withDefaultStore(async (store) => {
			assert.deepEqual(
				(await SessionManager.listAll(store)).map((session) => session.id).sort(),
				[ids.v1, ids.v2, ids.v3, ids.early4, ids.v4].sort(),
			);
		});
	});

	it("uses a readable copy when an earlier copy of the same session is damaged", async () => {
		const damagedCopy = join(agentDir, "sessions", "--a-damaged-copy--");
		mkdirSync(damagedCopy, { recursive: true });
		writeFileSync(
			join(damagedCopy, `copy_${ids.v3}.jsonl`),
			encode([
				{ type: "session", version: 3, id: ids.v3, timestamp: fixtures.v3.createdAt, cwd },
				{
					type: "message",
					id: "e0000001",
					parentId: null,
					timestamp: fixtures.v3.createdAt,
					message: { role: "user", content: [null], timestamp: Date.parse(fixtures.v3.createdAt) },
				},
			]),
		);
		writeLegacy(fixtures.v3);

		await withDefaultStore(async (store) => {
			assert.deepEqual(
				(await SessionManager.list(cwd, store)).map((session) => session.name),
				["Legacy auth refactor"],
			);
			assert.equal((await SessionManager.open(store, ids.v3)).getSessionName(), "Legacy auth refactor");
		});
	});

	describe("sessions too large to read in full for a listing", () => {
		const lastAt = "2026-10-20T09:00:00.000Z";

		function writeLarge(options: Omit<LargeSessionOptions, "cwd">, directory = legacyDirectory): string {
			mkdirSync(directory, { recursive: true });
			const path = join(directory, `2026-10-01T00-00-00-000Z_${options.id}.jsonl`);
			writeFileSync(path, largeLegacyContent({ ...options, cwd }));
			return path;
		}

		function watchBodyReads(): string[] {
			const reads: string[] = [];
			const scanFiles = JsonlSessionStore.prototype.scanFiles;
			vi.spyOn(JsonlSessionStore.prototype, "scanFiles").mockImplementation(function (this: JsonlSessionStore) {
				const files = scanFiles.call(this);
				return (async function* () {
					for await (const file of files) {
						yield {
							...file,
							read: () => {
								reads.push(file.location);
								return file.read();
							},
						};
					}
				})();
			});
			return reads;
		}

		it("lists one from its first message and its last entries without reading the whole file", async () => {
			writeAllFormats();
			const path = writeLarge({ id: "large-1", lastAt, name: "Late rename", damagedMiddle: true });
			const before = readFileSync(path, "utf8");
			const reads = watchBodyReads();

			await withDefaultStore(async (store) => {
				const listed = await SessionManager.list(cwd, store);
				const large = listed.find((session) => session.id === "large-1");
				assert.ok(large);
				assert.equal(large.firstMessage, LARGE_FIRST_TEXT);
				assert.equal(large.name, "Late rename");
				assert.equal(large.summary, "Large migration plan");
				assert.equal(large.created.toISOString(), "2026-10-01T00:00:00.000Z");
				assert.equal(large.modified.toISOString(), "2026-10-20T09:00:01.000Z");
				assert.match(large.allMessagesText, /Plan the large migration/);
				assert.match(large.allMessagesText, /Final answer/);
				assert.doesNotMatch(large.allMessagesText, /middle-only 300 /);
				assert.ok(large.messageCount >= 1 && large.messageCount < LARGE_FILLER_MESSAGES);
				assert.equal(listed[0]?.id, "large-1");
				assert.equal((await store.findMostRecent({ cwd }))?.id, "large-1");
			});

			assert.ok(!reads.includes(path));
			assert.equal(readFileSync(path, "utf8"), before);
			assert.deepEqual(convertedIds(), []);
		});

		it("lists one saved in the oldest format from its two ends and still upgrades it when opened", async () => {
			const createdAt = "2025-03-01T10:00:00.000Z";
			const lines = [
				{ type: "session", id: "large-v1", timestamp: createdAt, cwd },
				userRecord("Explain the v1 parser", createdAt, 1),
				...Array.from({ length: LARGE_FILLER_MESSAGES }, (_, index) =>
					assistantRecord(`middle-only ${index} ${"x".repeat(1_000)}`, createdAt, 2 + index),
				),
				assistantRecord("Closing remarks", createdAt, 1_000),
			];
			mkdirSync(legacyDirectory, { recursive: true });
			const path = join(legacyDirectory, `${createdAt.replace(/[:.]/g, "-")}_large-v1.jsonl`);
			writeFileSync(path, encode(lines));
			const reads = watchBodyReads();

			await withDefaultStore(async (store) => {
				const listed = (await SessionManager.list(cwd, store)).find((session) => session.id === "large-v1");
				assert.equal(listed?.firstMessage, "Explain the v1 parser");
				assert.equal(listed?.created.toISOString(), createdAt);
				assert.equal(listed?.modified.toISOString(), "2025-03-01T10:16:40.000Z");
				assert.match(listed?.allMessagesText ?? "", /Closing remarks/);
			});
			assert.ok(!reads.includes(path));

			await withDefaultStore(async (store) => {
				const entries = (await SessionManager.open(store, "large-v1")).getEntries();
				assert.equal(entries.length, LARGE_FILLER_MESSAGES + 2);
				assert.equal(entries[1]?.parentId, entries[0]?.id);
			});
		});

		it("orders them by their last message rather than file modification time", async () => {
			const older = writeLarge({ id: "large-older", lastAt: "2026-10-12T09:00:00.000Z" });
			const newer = writeLarge({ id: "large-newer", lastAt: "2026-10-14T09:00:00.000Z" });
			utimesSync(older, new Date("2026-12-01T00:00:00Z"), new Date("2026-12-01T00:00:00Z"));
			utimesSync(newer, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

			await withDefaultStore(async (store) => {
				assert.deepEqual(
					(await SessionManager.list(cwd, store)).map((session) => session.id),
					["large-newer", "large-older"],
				);
				assert.equal((await store.findMostRecent({ cwd }))?.id, "large-newer");
			});
		});

		it("converts the whole session when it is opened, then lists its full message count from the database", async () => {
			writeLarge({ id: "large-open", lastAt });

			await withDefaultStore(async (store) => {
				const listed = (await SessionManager.list(cwd, store)).find((session) => session.id === "large-open");
				assert.ok(listed && listed.messageCount < LARGE_FILLER_MESSAGES);
				assert.deepEqual(convertedIds(), []);
				await SessionManager.open(store, "large-open");
			});

			assert.deepEqual(convertedIds(), ["large-open"]);
			await withDefaultStore(async (store) => {
				const converted = (await SessionManager.list(cwd, store)).find((session) => session.id === "large-open");
				assert.equal(converted?.messageCount, LARGE_FILLER_MESSAGES + 3);
				assert.equal(converted?.summary, "Large migration plan");
			});
		});

		it("uses a readable copy when an earlier large copy has a torn tail", async () => {
			writeLarge(
				{ id: "large-copy", lastAt, name: "Damaged", tornTail: true },
				join(agentDir, "sessions", "--a-damaged-copy--"),
			);
			writeLarge({ id: "large-copy", lastAt, name: "Readable" });

			await withDefaultStore(async (store) => {
				assert.deepEqual(
					(await SessionManager.list(cwd, store)).map((session) => session.name),
					["Readable"],
				);
				assert.equal((await store.findMostRecent({ cwd }))?.name, "Readable");
				assert.equal((await SessionManager.open(store, "large-copy")).getSessionName(), "Readable");
			});
		});

		it("does not list one whose tail is torn, because it cannot be opened either", async () => {
			writeAllFormats();
			writeLarge({ id: "large-torn", lastAt, tornTail: true });

			await withDefaultStore(async (store) => {
				assert.ok(!(await SessionManager.listAll(store)).some((session) => session.id === "large-torn"));
				assert.equal((await store.findMostRecent({ cwd }))?.id, ids.v4);
				await assert.rejects(SessionManager.open(store, "large-torn"));
			});
		});

		it("lists one whose first message is larger than the head window with that message", async () => {
			const firstText = `${"z".repeat(300_000)} end`;
			writeLarge({ id: "large-first", lastAt, firstText });

			await withDefaultStore(async (store) => {
				const listed = (await SessionManager.list(cwd, store)).find((session) => session.id === "large-first");
				assert.equal(listed?.firstMessage, firstText);
			});
		});
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"lists readable projects when another legacy project directory cannot be read",
		async () => {
			writeAllFormats();
			const locked = join(agentDir, "sessions", "--locked-project--");
			mkdirSync(locked, { recursive: true });
			chmodSync(locked, 0o000);
			try {
				await withDefaultStore(async (store) => {
					assert.equal((await SessionManager.listAll(store)).length, 5);
				});
			} finally {
				chmodSync(locked, 0o755);
			}
		},
	);

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
