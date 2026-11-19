import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { LegacySessionStore } from "../../packages/coding-agent/src/core/storage/session/legacy-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	JsonlSessionStore,
	resolveSessionStore,
	SessionManager,
	type SessionStore,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createScenarioRepository } from "../fixtures/worktree-large-diff-scenario.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { appendProseTurn, mockSession, run, workflow } from "./executor-shared.js";
import type { AgentSessionAdapter } from "./stage-runner-helpers.js";

useTemporaryAgentDir();
afterEach(closeMemoryTestBackends);

test.each(["archived directory", "legacy SQLite import"])(
	"a cached parallel fork leaves session storage untouched (%s, #5630)",
	async (selection) => {
		const cwd = makeTempDirectory("cached-fork-");
		const directory = join(cwd, "sessions");
		const archive = join(cwd, "archive");
		const sessions = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const path = join(cwd, "sessions.db");
		const db = await openNodeSqliteDatabase(path);
		const sql = await SqlSessionStore.open(db);
		const legacy = new LegacySessionStore(sql, { legacyDirectory: archive, databasePath: path });
		const runId = randomUUID();
		const backend = await createMemoryTestBackend();
		let calls = 0;
		let sessionDir: string | undefined = directory;
		const agentSession: AgentSessionAdapter = {
			async create({ sessionManager }) {
				calls++;
				const session = mockSession(sessionManager);
				session.prompt = async () => appendProseTurn(session.messages);
				return session;
			},
		};
		try {
			const source = await SessionManager.create(sessions, cwd);
			await source.appendMessage({ role: "user", timestamp: 1, content: "original" });
			const definition = workflow({
				name: "cached-fork",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					const [answer] = await ctx.parallel([{ name: "worker", prompt: "hello" }], {
						context: "fork",
						forkFromSessionId: source.getSessionId(),
						sessionDir,
					});
					assert.equal(answer?.text, "ok");
					return {};
				},
			});
			const execute = async (sessionStore?: SessionStore) => {
				const result = await run(
					definition,
					{},
					{ cwd, runId, store: createStore(), durableBackend: backend, adapters: { agentSession, sessionStore } },
				);
				assert.equal(result.status, "completed", result.error);
			};
			await execute();
			await rename(directory, archive);
			if (selection === "legacy SQLite import") sessionDir = undefined;
			const ranges = vi.spyOn(legacy, "readRange");
			const loads = vi.spyOn(legacy, "load");
			await execute(sessionDir === undefined ? legacy : undefined);
			assert.equal(existsSync(directory), false, "replay must leave the archived directory absent");
			await Promise.all(ranges.mock.results.map((r) => r.value));
			assert.equal(await sql.readHeader(source.getSessionId()), undefined);
			assert.equal(loads.mock.calls.length, 0);
			assert.equal(calls, 1);
		} finally {
			await legacy.close();
			await db.close();
			await sessions.close();
			removeTempDirectory(cwd);
		}
	},
);

test("fail-fast fan-out from one SQLite source does not read it once per task cwd (#5631)", async () => {
	const cwd = makeTempDirectory("fanout-fork-");
	const db = await openNodeSqliteDatabase(join(cwd, "sessions.db"));
	const store = await SqlSessionStore.open(db);
	try {
		const source = await SessionManager.create(store, cwd);
		await source.appendMessage({ role: "user", timestamp: 1, content: "original" });
		const ranges = vi.spyOn(store, "readRange");
		const loads = vi.spyOn(store, "load");
		const steps = Array.from({ length: 4000 }, (_, i) => ({
			name: `worker-${i}`,
			prompt: "hello",
			cwd: join(cwd, `project-${i}`),
		}));
		let opens = 0;
		const definition = workflow({
			name: "fanout-fork",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await assert.rejects(
					ctx.parallel(steps, {
						concurrency: 1,
						context: "fork",
						forkFromSessionId: source.getSessionId(),
						sessionStore: store,
					}),
					/stop the first worker/,
				);
				return {};
			},
		});
		const agentSession: AgentSessionAdapter = {
			async create() {
				opens++;
				throw new Error("stop the first worker");
			},
		};
		const result = await run(
			definition,
			{},
			{ cwd, store: createStore(), durableBackend: await createMemoryTestBackend(), adapters: { agentSession } },
		);
		assert.equal(result.status, "completed", result.error);
		assert.equal(opens, 1);
		const sourceReads = [...ranges.mock.calls, ...loads.mock.calls].filter(
			([id]) => id === source.getSessionId(),
		).length;
		assert.ok(sourceReads <= 1, `one source required ${sourceReads} prefix reads`);
	} finally {
		await store.close();
		await db.close();
		removeTempDirectory(cwd);
	}
});

test.each(["settings change", "worktree base branch"])(
	"queued forks copy history from the store each child actually selects (%s, #5631)",
	async (selection) => {
		const cwd = makeTempDirectory("queued-fork-stores-");
		const stores = new Set<SessionStore>();
		const settings = (name: string) => ({ sessions: { storage: { dir: join(cwd, name) } } });
		const settingsManager = SettingsManager.inMemory(settings("first"));
		const id = randomUUID();
		try {
			for (const [name, messages] of [
				["first", ["a"]],
				["second", ["b1", "b2", "b3"]],
			] as const) {
				const store = await resolveSessionStore(cwd, { agentDir: cwd, settings: settings(name) });
				stores.add(store);
				await store.create({ id, cwd, version: 4, createdAt: new Date(0).toISOString() }, []);
				const source = await SessionManager.open(store, id, cwd);
				for (const content of messages) await source.appendMessage({ role: "user", timestamp: 1, content });
			}
			const repo = selection === "worktree base branch" ? createScenarioRepository(cwd) : undefined;
			if (repo !== undefined) {
				const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
				mkdirSync(join(repo, ".atomic"), { recursive: true });
				for (const name of ["first", "second"]) {
					if (name === "second") git("switch", "-c", "fork-base");
					writeFileSync(join(repo, ".atomic", "settings.json"), JSON.stringify(settings(name)));
					git("add", "--force", ".atomic/settings.json");
					git("commit", "--no-gpg-sign", "-m", `select ${name}`);
				}
				git("switch", "main");
			}
			const prefixes: unknown[][] = [];
			const agentSession: AgentSessionAdapter = {
				async create({ sessionManager }, meta) {
					assert.ok(sessionManager);
					stores.add(sessionManager.getSessionStore());
					prefixes.push(sessionManager.buildSessionContext().messages.map((m) => "content" in m && m.content));
					if (meta?.stageName === "left") settingsManager.applyOverrides(settings("second"));
					const session = mockSession(sessionManager);
					session.prompt = async () => appendProseTurn(session.messages);
					return session;
				},
			};
			const definition = workflow({
				name: "queued-store-selection",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					const steps = repo
						? [{ name: "right", prompt: "right", worktree: true, baseBranch: "fork-base" }]
						: [
								{ name: "left", prompt: "left" },
								{ name: "right", prompt: "right" },
							];
					await ctx.parallel(steps, {
						context: "fork",
						forkFromSessionId: id,
						concurrency: 1,
						agentDir: cwd,
						...(repo ? {} : { cwd, settingsManager }),
					});
					return {};
				},
			});
			const result = await run(
				definition,
				{},
				{
					cwd: repo ?? cwd,
					durableBackend: await createMemoryTestBackend(),
					store: createStore(),
					adapters: { agentSession },
				},
			);
			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(prefixes, repo ? [["b1", "b2", "b3"]] : [["a"], ["b1", "b2", "b3"]]);
		} finally {
			for (const store of stores) await store.close();
			removeTempDirectory(cwd);
		}
	},
);
