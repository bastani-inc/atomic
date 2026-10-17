import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.js";
import { SessionManager } from "../src/core/session-manager.js";
import { getDefaultSessionDirPath } from "../src/core/session-manager-paths.js";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { LegacySessionStore } from "../src/core/storage/session/legacy-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { createSessionManager } from "../src/main-session.js";
import { TestSqliteDatabase } from "./helpers/sqlite.js";

const prompt = vi.hoisted(() => ({ answer: "n", questions: [] as string[] }));

vi.mock("node:readline", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:readline")>();
	return {
		...actual,
		createInterface: (options: Parameters<typeof actual.createInterface>[0]) => {
			if (options.output === undefined) return actual.createInterface(options);
			return {
				question: (question: string, answered: (answer: string) => void) => {
					prompt.questions.push(question);
					answered(prompt.answer);
				},
				close: () => {},
			};
		},
	};
});

class ExitError extends Error {
	constructor(readonly code: number | string | null | undefined) {
		super(`process.exit(${code})`);
	}
}

const BULK_LEGACY_SESSIONS = 200;
const bulkId = (index: number): string => `bbbbbbbb-0000-7000-8000-${String(index).padStart(12, "0")}`;

describe("resolving --session and --fork against a large legacy session directory", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	let otherCwd: string;
	let legacyDirectory: string;
	let defaultDatabase: string;
	let errors: string[];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-exact-session-id-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		otherCwd = join(root, "other-project");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(otherCwd, { recursive: true });
		legacyDirectory = getDefaultSessionDirPath(cwd, agentDir);
		defaultDatabase = join(root, "workflows", "journal.sqlite");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv(ENV_SESSION_DIR, "");
		prompt.answer = "n";
		prompt.questions = [];
		errors = [];
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation((message: string) => {
			errors.push(message);
		});
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new ExitError(code);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	function writeLegacy(id: string, text: string, sessionCwd = cwd): string {
		const createdAt = "2026-10-16T10:00:00.000Z";
		mkdirSync(legacyDirectory, { recursive: true });
		const path = join(legacyDirectory, `${createdAt.replace(/[:.]/g, "-")}_${id}.jsonl`);
		const user = { role: "user", content: text, timestamp: Date.parse(createdAt) + 1000 };
		writeFileSync(
			path,
			`${[
				{ type: "session", version: 4, id, createdAt, cwd: sessionCwd },
				{ type: "message", id: "u0000001", parentId: null, timestamp: createdAt, message: user },
			]
				.map((line) => JSON.stringify(line))
				.join("\n")}\n`,
		);
		return path;
	}

	function writeBulkLegacy(): void {
		for (let index = 0; index < BULK_LEGACY_SESSIONS; index++) writeLegacy(bulkId(index), `bulk session ${index}`);
	}

	async function withStore<T>(body: (store: SessionStore) => Promise<T>): Promise<T> {
		const store = await resolveSessionStore(cwd, { agentDir, settings: {} });
		try {
			return await body(store);
		} finally {
			await store.close();
		}
	}

	async function createStored(id: string, text: string, sessionCwd = cwd): Promise<void> {
		await withStore(async (store) => {
			const session = await SessionManager.create(store, sessionCwd, { id });
			await session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		});
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

	function watchLegacyAccess() {
		const bodyReads: string[] = [];
		const listings = [
			vi.spyOn(SessionManager, "list"),
			vi.spyOn(SessionManager, "listAll"),
			vi.spyOn(LegacySessionStore.prototype, "list"),
			vi.spyOn(LegacySessionStore.prototype, "findMostRecent"),
		];
		const opened = vi.spyOn(JsonlSessionStore, "open");
		const scanFiles = JsonlSessionStore.prototype.scanFiles;
		const scanned = vi.spyOn(JsonlSessionStore.prototype, "scanFiles").mockImplementation(function (
			this: JsonlSessionStore,
		) {
			const files = scanFiles.call(this);
			return (async function* () {
				for await (const file of files) {
					yield {
						...file,
						read: () => {
							bodyReads.push(file.location);
							return file.read();
						},
					};
				}
			})();
		});
		return {
			bodyReads,
			listingCalls: () => listings.reduce((total, spy) => total + spy.mock.calls.length, 0),
			legacyDirectoryOpens: () => opened.mock.calls.length,
			legacyScans: () => scanned.mock.calls.length,
		};
	}

	async function resolve(args: string[]): Promise<SessionManager> {
		return createSessionManager(parseArgs(args), cwd, undefined, SettingsManager.inMemory());
	}

	async function resolveAndClose<T>(args: string[], inspect: (manager: SessionManager) => T): Promise<T> {
		const manager = await resolve(args);
		try {
			return inspect(manager);
		} finally {
			await manager.getSessionStore().close();
		}
	}

	async function exitCodeOf(args: string[]): Promise<number | string | null | undefined> {
		try {
			await resolveAndClose(args, () => undefined);
		} catch (error) {
			if (error instanceof ExitError) return error.code;
			throw error;
		}
		throw new Error("expected process.exit");
	}

	describe("an exact session id", () => {
		it("opens a session already in the database without listing sessions or touching the legacy directory", async () => {
			const id = "0191f0a1-0000-7000-8000-0000000000d0";
			writeBulkLegacy();
			await createStored(id, "stored in the database");
			const access = watchLegacyAccess();

			const opened = await resolveAndClose(["--session", id], (manager) => ({
				id: manager.getSessionId(),
				entries: manager.getEntries().length,
			}));

			assert.deepEqual(opened, { id, entries: 1 });
			assert.equal(access.listingCalls(), 0);
			assert.equal(access.legacyDirectoryOpens(), 0);
			assert.equal(access.legacyScans(), 0);
			assert.deepEqual(access.bodyReads, []);
			assert.deepEqual(convertedIds(), [id]);
		});

		it("opens an exact legacy session by reading only that session", async () => {
			writeBulkLegacy();
			const target = bulkId(137);
			const access = watchLegacyAccess();

			const openedId = await resolveAndClose(["--session", target], (manager) => manager.getSessionId());

			assert.equal(openedId, target);
			assert.equal(access.listingCalls(), 0);
			assert.equal(access.bodyReads.length, 1);
			assert.match(access.bodyReads[0]!, new RegExp(`${target}\\.jsonl$`));
			assert.deepEqual(convertedIds(), [target]);
		});

		it("forks a session already in the database without listing sessions or touching the legacy directory", async () => {
			writeBulkLegacy();
			await createStored("exact-source", "fork me");
			const access = watchLegacyAccess();

			const forked = await resolveAndClose(["--fork", "exact-source"], (manager) => ({
				parent: manager.getHeader()?.parentSessionId,
				cwd: manager.getCwd(),
			}));

			assert.deepEqual(forked, { parent: "exact-source", cwd });
			assert.equal(access.listingCalls(), 0);
			assert.equal(access.legacyDirectoryOpens(), 0);
			assert.deepEqual(access.bodyReads, []);
		});

		it("forks an exact legacy session by reading only that session", async () => {
			writeBulkLegacy();
			const source = bulkId(42);
			const access = watchLegacyAccess();

			const parent = await resolveAndClose(["--fork", source], (manager) => manager.getHeader()?.parentSessionId);

			assert.equal(parent, source);
			assert.equal(access.listingCalls(), 0);
			assert.equal(access.bodyReads.length, 1);
			assert.match(access.bodyReads[0]!, new RegExp(`${source}\\.jsonl$`));
		});

		it("still asks to fork a session that belongs to another project", async () => {
			const id = "5a5a5a5a-0000-7000-8000-000000000001";
			await createStored(id, "elsewhere", otherCwd);
			prompt.answer = "y";

			const forked = await resolveAndClose(["--session", id], (manager) => ({
				parent: manager.getHeader()?.parentSessionId,
				cwd: manager.getCwd(),
			}));

			assert.deepEqual(forked, { parent: id, cwd });
			assert.equal(prompt.questions.length, 1);
		});
	});

	describe("a session id prefix", () => {
		it("resolves an 8-character prefix of a session in the database", async () => {
			const id = "0191f0a1-0000-7000-8000-0000000000d0";
			writeBulkLegacy();
			await createStored(id, "stored in the database");

			assert.equal(await resolveAndClose(["--session", "0191f0a1"], (manager) => manager.getSessionId()), id);
		});

		it("resolves an 8-character prefix of an unconverted legacy session and converts only that one", async () => {
			const target = "0191f0a1-0000-7000-8000-0000000000f0";
			writeBulkLegacy();
			writeLegacy(target, "legacy target");

			assert.equal(await resolveAndClose(["--session", "0191f0a1"], (manager) => manager.getSessionId()), target);
			assert.deepEqual(convertedIds(), [target]);
		});

		it("resolves an 8-character prefix of a session in another project after confirmation", async () => {
			const id = "5a5a5a5a-0000-7000-8000-000000000001";
			await createStored(id, "elsewhere", otherCwd);
			prompt.answer = "y";

			const parent = await resolveAndClose(
				["--session", "5a5a5a5a"],
				(manager) => manager.getHeader()?.parentSessionId,
			);

			assert.equal(parent, id);
			assert.equal(prompt.questions.length, 1);
		});

		it("declines to open a session from another project when the fork is refused", async () => {
			await createStored("5a5a5a5a-0000-7000-8000-000000000001", "elsewhere", otherCwd);

			assert.equal(await exitCodeOf(["--session", "5a5a5a5a"]), 0);
			assert.equal(prompt.questions.length, 1);
		});

		it("rejects a prefix shared by several sessions as ambiguous", async () => {
			writeBulkLegacy();

			assert.equal(await exitCodeOf(["--session", "bbbbbbbb"]), 1);
			assert.match(
				errors.join("\n"),
				/Session ID prefix "bbbbbbbb" is ambiguous; matches: bbbbbbbb-0000-7000-8000-/,
			);
			assert.deepEqual(convertedIds(), []);
		});

		it("rejects a UUID-like fragment that is not an 8-character prefix", async () => {
			await createStored("0191f0a1-0000-7000-8000-0000000000d0", "stored in the database");

			assert.equal(await exitCodeOf(["--session", "0191f0a1-0000"]), 1);
			assert.match(errors.join("\n"), /Session selector must be an exact custom session ID/);
		});

		it("reports an unknown session id", async () => {
			writeBulkLegacy();

			assert.equal(await exitCodeOf(["--session", "no-such-session"]), 1);
			assert.match(errors.join("\n"), /No session found matching 'no-such-session'/);
			assert.deepEqual(convertedIds(), []);
		});

		it("reports an unknown session id for --fork", async () => {
			assert.equal(await exitCodeOf(["--fork", "no-such-session"]), 1);
			assert.match(errors.join("\n"), /No session found matching 'no-such-session'/);
		});
	});
});
