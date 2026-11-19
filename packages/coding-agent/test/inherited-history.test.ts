import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import type { CreateAgentSessionOptions } from "../src/core/sdk-types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createTestResourceLoader } from "./utilities.ts";

const BUILTINS_OFF = { subagents: false, mcp: false, "web-access": false, intercom: false } as const;
const STARTED_AT = Date.parse("2026-10-01T00:00:00.000Z");

const sessions: AgentSession[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function projectDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "atomic-inherited-history-"));
	directories.push(directory);
	return directory;
}

async function openSession(cwd: string, options: CreateAgentSessionOptions = {}): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		builtins: BUILTINS_OFF,
		...options,
	});
	sessions.push(session);
	return session;
}

async function readHistory(session: AgentSession, url: string): Promise<string> {
	return String(await session.extensionRunner.createContext().internalResourceRouter?.read?.(url));
}

describe("history:// in a session started by another (#4648)", () => {
	test("reads the launching session's sessions, also after a reload (#4648)", async () => {
		const cwd = projectDirectory();
		const project = new MemorySessionStore();
		await project.create(
			{ id: "earlier-session", version: SESSION_FORMAT_VERSION, createdAt: new Date(STARTED_AT).toISOString(), cwd },
			[],
		);
		const child = await openSession(cwd, {
			inheritedHistory: { sessionStore: () => project },
		});

		for (const reloaded of [false, true]) {
			if (reloaded) await child.reload();
			assert.ok((await readHistory(child, "history://sessions")).includes("history://sessions/earlier-session"));
		}
	});

	test("reads only its own history without a launching session (#4648)", async () => {
		const session = await openSession(projectDirectory());
		const history = session.extensionRunner.getProjectHistory();

		assert.equal(history.sessionStore(), session.sessionManager.getSessionStore());
	});

	test("passes its session store to the sessions it starts, and they pass them on (#4648)", async () => {
		const cwd = projectDirectory();
		const parent = await openSession(cwd);
		const childOptions = parent.extensionRunner.createContext().getChildSessionOptions?.({});
		assert.equal(childOptions?.inheritedHistory?.sessionStore(), parent.sessionManager.getSessionStore());

		const child = await openSession(cwd, { ...childOptions, sessionManager: SessionManager.inMemory(cwd) });
		const grandchildOptions = child.extensionRunner.createContext().getChildSessionOptions?.({});
		assert.equal(grandchildOptions?.inheritedHistory?.sessionStore(), parent.sessionManager.getSessionStore());
	});
});
