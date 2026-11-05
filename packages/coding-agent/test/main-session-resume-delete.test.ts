/**
 * Deleting a session from the `--resume` picker also deletes what a released workflow stage left for it (#4309): the
 * oversized tool results kept in the agent directory. A session kept in a JSONL session directory has no such delete
 * action, because its directory is removed with the session.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SessionNotFoundError } from "../src/core/storage/session/errors.ts";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { getReleasedStageBlobDir } from "../src/core/tools/tool-output-blobs.ts";

type DeleteAction = ((sessionId: string) => Promise<void>) | undefined;
type SessionsLoader = () => Promise<SessionInfo[]>;

const picker = vi.hoisted(() => ({
	choose: undefined as undefined | ((current: unknown, deleteSession: unknown) => Promise<unknown>),
}));

vi.mock("../src/cli/session-picker.ts", () => ({
	selectSession: (current: unknown, _all: unknown, _settings: unknown, deleteSession: unknown) => {
		if (picker.choose === undefined) throw new Error("no picker behaviour was set");
		return picker.choose(current, deleteSession);
	},
}));

describe("the --resume picker's delete action (#4309)", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	const closers: (() => Promise<void>)[] = [];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-resume-delete-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		picker.choose = undefined;
		while (closers.length > 0) await closers.pop()?.();
		rmSync(root, { recursive: true, force: true });
	});

	/** What the picker was given, and the session it picks. */
	async function resumeWith(
		store: JsonlSessionStore | SqlSessionStore,
		keep: SessionManager,
	): Promise<{ readonly deleteAction: DeleteAction }> {
		let deleteAction: DeleteAction;
		picker.choose = async (current, deleteSession) => {
			deleteAction = deleteSession as DeleteAction;
			return (await (current as SessionsLoader)()).find((session) => session.id === keep.getSessionId());
		};
		const { createSessionManager } = await import("../src/main-session.ts");
		const resumed = await createSessionManager(
			parseArgs(["--resume"]),
			cwd,
			undefined,
			SettingsManager.inMemory(),
			store,
		);
		assert.equal(resumed.getSessionId(), keep.getSessionId());
		return { deleteAction };
	}

	test("deletes the session and the oversized results its released stage kept in the agent directory (#4309)", async () => {
		const database = await openNodeSqliteDatabase(join(root, "sessions.sqlite"));
		const store = await SqlSessionStore.open(database);
		closers.push(async () => {
			await store.close();
			await database.close();
		});
		const kept = await SessionManager.create(store, cwd);
		await kept.appendMessage({ role: "user", content: "keep me", timestamp: Date.now() });
		const doomed = await SessionManager.create(store, cwd);
		await doomed.appendMessage({ role: "user", content: "delete me", timestamp: Date.now() });
		const doomedBlobs = getReleasedStageBlobDir(agentDir, doomed.getSessionId());
		const keptBlobs = getReleasedStageBlobDir(agentDir, kept.getSessionId());
		for (const directory of [doomedBlobs, keptBlobs]) {
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "result.txt"), "spilled");
		}

		const { deleteAction } = await resumeWith(store, kept);
		assert.equal(typeof deleteAction, "function");
		await deleteAction?.(doomed.getSessionId());

		await assert.rejects(store.load(doomed.getSessionId()), SessionNotFoundError);
		assert.equal(existsSync(doomedBlobs), false);
		assert.equal(existsSync(keptBlobs), true);
	});

	test("gives a session directory's sessions no delete action (#4309)", async () => {
		const store = await JsonlSessionStore.open(join(root, "sessions"), { exactDirectory: true });
		const kept = await SessionManager.create(store, cwd);
		await kept.appendMessage({ role: "user", content: "keep me", timestamp: Date.now() });

		const { deleteAction } = await resumeWith(store, kept);

		assert.equal(deleteAction, undefined);
		await store.close();
	});
});
