/**
 * A subagent's own session is always kept in the session store its parent uses, whatever that store is (the parent's
 * SQLite store by default, its memory store when the parent saves nothing, or its JSONL directory), whatever directory
 * or worktree the child runs in, and whether it starts fresh or forked. Real parent and child sessions with the
 * bundled subagents extension, on a local model.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonObject } from "@bastani/atomic-ai";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import type { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	type AgentSession,
	AuthStorage,
	type CreateAgentSessionOptions,
	createAgentSession,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	type SessionStore,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

/** Structural cost: a real parent session runs a real subagent session through the subagent tool. */
const REAL_SUBAGENT_TIMEOUT_MS = 120_000;
const PROVIDER = "faux-child-store";
const MAIN_MODEL = "main-child-store";
const CHILD_MODEL = "child-child-store";
const CHILD_ANSWER = "child answer 7d1f";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	clearSubagentControls();
	vi.unstubAllEnvs();
});

/** The parent delegates once, with `launch` as the subagent call's arguments; the child answers. */
function scriptedModel(launch: JsonObject): FauxResponseFactory {
	return (context) => {
		const parent = context.messages.some(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("Delegate the answer"),
		);
		if (!parent) return fauxAssistantMessage(CHILD_ANSWER);
		const last = context.messages.at(-1);
		const resume = last?.role === "user" ? /RESUME ([\w-]+:\d+)/.exec(JSON.stringify(last.content)) : null;
		if (resume)
			return fauxAssistantMessage(
				[
					fauxToolCall("subagent", {
						action: "resume",
						id: resume[1],
						message: "Answer again.",
						wait: { kind: "background" },
					}),
				],
				{ stopReason: "toolUse" },
			);
		if (last?.role !== "user" || !JSON.stringify(last.content).includes("Delegate the answer"))
			return fauxAssistantMessage("done");
		const fork: JsonObject = JSON.stringify(last.content).includes("with a fork") ? { context: "fork" } : {};
		const call = launch.tasks
			? { ...launch, ...fork }
			: { agent: "helper-store", task: "Answer.", ...launch, ...fork };
		return fauxAssistantMessage([fauxToolCall("subagent", call)], { stopReason: "toolUse" });
	};
}

/** The project agent the parent launches, defined in `dir`. */
function writeHelperAgent(dir: string): void {
	mkdirSync(join(dir, ".atomic", "agents"), { recursive: true });
	writeFileSync(
		join(dir, ".atomic", "agents", "helper-store.md"),
		`---\nname: helper-store\ndescription: Answers\ntools: read\nmodel: ${PROVIDER}/${CHILD_MODEL}\n---\n\nAnswer the task.\n`,
	);
}

async function parentSession(
	cwd: string,
	launch: JsonObject,
	storage: Pick<CreateAgentSessionOptions, "sessionManager" | "sessionStore"> = {},
): Promise<AgentSession> {
	// Under NODE_ENV=test a child runs a scripted stand-in session instead of its model.
	vi.stubEnv("NODE_ENV", "production");
	const faux = registerFauxProvider({ provider: PROVIDER, models: [{ id: MAIN_MODEL }, { id: CHILD_MODEL }] });
	cleanups.push(() => faux.unregister());
	faux.setResponses(Array.from({ length: 20 }, () => scriptedModel(launch)));
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(PROVIDER, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	modelRuntime.registerProvider(PROVIDER, {
		baseUrl: faux.getModel().baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			cost: registered.cost,
		})),
	});
	writeHelperAgent(cwd);
	const { session } = await createAgentSession({
		cwd,
		modelRuntime,
		model: faux.getModel(MAIN_MODEL),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			sessionSummary: { enabled: false },
		}),
		builtins: { mcp: false, intercom: false, "web-access": false },
		...storage,
	});
	cleanups.push(() => session.dispose());
	return session;
}

/** What the parent's session recorded about the child it launched. */
interface ChildRecord {
	readonly childId?: string;
	readonly state?: string;
	readonly terminalStatus?: string;
	readonly childSessionId?: string;
	readonly childSessionFile?: string;
}

function childRecords(session: AgentSession): ChildRecord[] {
	return session.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === "subagent-child" ? [entry.data as ChildRecord] : [],
		);
}

/**
 * The parent sends `prompt` (it launches a child, which runs in the background, or resumes one); resolves with the
 * record of the child that finished since, once it did.
 */
async function delegate(session: AgentSession, prompt = "Delegate the answer."): Promise<ChildRecord> {
	const finished = () => childRecords(session).filter((record) => record.state === "terminal");
	const before = finished().length;
	await session.prompt(prompt, { streamingBehavior: "followUp" });
	await vi.waitFor(
		() => {
			assert.ok(finished().length > before, JSON.stringify(childRecords(session)));
			assert.equal(session.isStreaming, false);
		},
		{ timeout: REAL_SUBAGENT_TIMEOUT_MS, interval: 20 },
	);
	const record = finished().findLast((candidate) => candidate.childSessionId !== undefined);
	assert.ok(record, `the parent recorded its child's session: ${JSON.stringify(childRecords(session))}`);
	return record;
}

/** The child's session read back from `store`, its parent's: it is there, and internal like every subagent session. */
async function childSessionIn(store: SessionStore, record: ChildRecord, cwd: string): Promise<SessionManager> {
	assert.ok(record.childSessionId);
	const reopened = await SessionManager.open(store, record.childSessionId, cwd);
	assert.equal(reopened.getHeader()?.internal, true, "the child's session is internal");
	const listed: string[] = [];
	for await (const summary of store.list({})) listed.push(summary.id);
	assert.ok(!listed.includes(record.childSessionId), "/resume and history:// do not list the child");
	return reopened;
}

/** A parent kept in a JSONL directory of its own, outside `cwd`. */
async function jsonlParent(cwd: string): Promise<{ manager: SessionManager; sessions: string }> {
	const sessions = makeTempDirectory("atomic-child-store-parent-sessions-");
	cleanups.push(() => removeTempDirectory(sessions));
	return { manager: await SessionManager.create(cwd, sessions), sessions };
}

function git(cwd: string, args: readonly string[]): void {
	const result = spawnSyncCollect(["git", ...args], { cwd });
	assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr.toString()}`);
}

/** A Git checkout at `cwd` with the parent's agent committed, so a worktree of it has the agent too. */
function gitCheckout(cwd: string): void {
	writeHelperAgent(cwd);
	git(cwd, ["init", "--quiet", "-b", "main"]);
	git(cwd, ["-c", "user.name=t", "-c", "user.email=t@example.com", "add", "."]);
	git(cwd, [
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@example.com",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--quiet",
		"-m",
		"agent",
	]);
}

/** Every session file under `directory`, at any depth; a run's artifacts (its `run-history.jsonl`) are not sessions. */
function sessionFilesUnder(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, encoding: "utf8" }).filter(
		(name) => name.endsWith(".jsonl") && !name.split(/[\\/]/).includes("artifacts"),
	);
}

test(
	"a subagent of a session kept in the default SQLite store keeps its session in that store, hidden from session lists",
	async () => {
		const cwd = makeTempDirectory("atomic-child-store-sqlite-");
		cleanups.push(() => removeTempDirectory(cwd));
		const session = await parentSession(cwd, {});
		const store = session.sessionManager.getSessionStore();
		assert.notEqual(store.descriptor.adapter, "jsonl", "the parent uses the default database store");

		const child = await delegate(session);
		assert.equal(child.childSessionFile, undefined, "the child has no session file of its own");
		assert.ok(child.childSessionId);
		const reopened = await SessionManager.open(store, child.childSessionId, cwd);
		assert.equal(reopened.getHeader()?.internal, true, "the child's session is internal");
		assert.equal(reopened.getHeader()?.parentSessionId, undefined, "a fresh child is not a fork of its parent");
		assert.ok(
			JSON.stringify(reopened.getEntries()).includes(CHILD_ANSWER),
			`its answer is in its session: ${JSON.stringify(child)} ${JSON.stringify(reopened.getEntries()).slice(0, 3000)}`,
		);

		const listed: string[] = [];
		for await (const summary of store.list({ cwd })) listed.push(summary.id);
		assert.ok(!listed.includes(child.childSessionId), "/resume and history:// do not list the child");
		assert.equal(
			(await store.findMostRecent({ cwd }))?.id,
			session.sessionManager.getSessionId(),
			"-c continues the parent",
		);
		const agentDir = getAgentDir();
		assert.ok(!existsSync(join(agentDir, "subagent-sessions")), "no directory is made for the child's session");
		assert.deepEqual(sessionFilesUnder(agentDir), [], "no session file is written for the child");
	},
	REAL_SUBAGENT_TIMEOUT_MS,
);

test(
	"a subagent of a session that saves nothing keeps its session in the parent's memory store, out of process memory once it finishes, and on no disk after the parent ends",
	async () => {
		const cwd = makeTempDirectory("atomic-child-store-memory-");
		cleanups.push(() => removeTempDirectory(cwd));
		const session = await parentSession(cwd, {}, { sessionStore: { kind: "memory" } });
		const store = session.sessionManager.getSessionStore() as MemorySessionStore;
		assert.equal(store.descriptor.adapter, "memory");

		const child = await delegate(session);
		assert.equal(child.childSessionFile, undefined);
		assert.ok(child.childSessionId);
		// Its history is released to the store's files once its session closes, which follows its last record.
		await vi.waitFor(() => assert.ok(store.historyBytes().onDisk > 0, JSON.stringify(store.historyBytes())), {
			timeout: REAL_SUBAGENT_TIMEOUT_MS,
			interval: 20,
		});
		const reopened = await SessionManager.open(store, child.childSessionId, cwd);
		assert.ok(JSON.stringify(reopened.getEntries()).includes(CHILD_ANSWER), "its history reads back from the store");

		// Resumed, it appends to its session; once it finishes again, what it appended leaves process memory too.
		const spilled = store.historyBytes().onDisk;
		const terminalBefore = childRecords(session).filter((record) => record.state === "terminal").length;
		await session.prompt(`RESUME ${child.childId}`, { streamingBehavior: "followUp" });
		await vi.waitFor(
			() => {
				assert.ok(
					childRecords(session).filter((record) => record.state === "terminal").length > terminalBefore,
					JSON.stringify(childRecords(session).at(-1)),
				);
				assert.ok(store.historyBytes().onDisk > spilled, JSON.stringify(store.historyBytes()));
			},
			{ timeout: REAL_SUBAGENT_TIMEOUT_MS, interval: 20 },
		);
		const resumed = await SessionManager.open(store, child.childSessionId, cwd);
		assert.ok(
			JSON.stringify(resumed.getEntries()).includes("Answer again."),
			"the resume's message is in its session",
		);
		const agentDir = getAgentDir();
		assert.ok(!existsSync(join(agentDir, "subagent-sessions")));
		assert.deepEqual(sessionFilesUnder(agentDir), [], "no session file is written for the child");

		await session.dispose();
		await store.close();
		const released = join(agentDir, "released-history");
		const leftFiles = existsSync(released)
			? readdirSync(released, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
			: [];
		assert.deepEqual(
			leftFiles.map((entry) => entry.name),
			[],
			"none of its history is left on disk",
		);
	},
	REAL_SUBAGENT_TIMEOUT_MS,
);

test(
	"a subagent of a session kept in files keeps its session in its parent's JSONL store",
	async () => {
		const cwd = makeTempDirectory("atomic-child-store-jsonl-");
		cleanups.push(() => removeTempDirectory(cwd));
		const { manager: parent, sessions } = await jsonlParent(cwd);
		const session = await parentSession(cwd, {}, { sessionManager: parent });

		const child = await delegate(session);
		const reopened = await childSessionIn(parent.getSessionStore(), child, cwd);
		assert.ok(JSON.stringify(reopened.getEntries()).includes(CHILD_ANSWER), "its answer is in its session");
		assert.ok(child.childSessionFile, "a JSONL store keeps the child's session in a file");
		assert.equal(dirname(child.childSessionFile), sessions, "beside its parent's, not in a directory of its own");
	},
	REAL_SUBAGENT_TIMEOUT_MS,
);

test.each(["default SQLite", "JSONL"] as const)(
	"a subagent launched with a session directory still keeps its session in its parent's %s store",
	async (kind) => {
		const cwd = makeTempDirectory("atomic-child-store-dir-");
		cleanups.push(() => removeTempDirectory(cwd));
		const chosen = join(cwd, "chosen-sessions");
		const parent = kind === "JSONL" ? (await jsonlParent(cwd)).manager : undefined;
		const session = await parentSession(cwd, { sessionDir: chosen }, parent ? { sessionManager: parent } : {});

		const child = await delegate(session);
		const reopened = await childSessionIn(session.sessionManager.getSessionStore(), child, cwd);
		assert.ok(JSON.stringify(reopened.getEntries()).includes(CHILD_ANSWER), "its answer is in its session");
		assert.deepEqual(sessionFilesUnder(chosen), [], "nothing is written to the directory the launch named");
	},
	REAL_SUBAGENT_TIMEOUT_MS,
);

test.each(["default SQLite", "JSONL"] as const)(
	"a subagent launched in another directory with storage settings of its own keeps its session in its parent's %s store",
	async (kind) => {
		const cwd = makeTempDirectory("atomic-child-store-cwd-");
		cleanups.push(() => removeTempDirectory(cwd));
		const elsewhere = makeTempDirectory("atomic-child-store-elsewhere-");
		cleanups.push(() => removeTempDirectory(elsewhere));
		const own = join(elsewhere, "own-sessions");
		writeHelperAgent(elsewhere);
		writeFileSync(
			join(elsewhere, ".atomic", "settings.json"),
			JSON.stringify({ sessions: { storage: { dir: own } }, storage: { path: join(elsewhere, "own.sqlite") } }),
		);
		const parent = kind === "JSONL" ? (await jsonlParent(cwd)).manager : undefined;
		const session = await parentSession(cwd, { cwd: elsewhere }, parent ? { sessionManager: parent } : {});

		const child = await delegate(session);
		const reopened = await childSessionIn(session.sessionManager.getSessionStore(), child, elsewhere);
		assert.equal(reopened.getHeader()?.cwd, elsewhere, "the child ran in the other directory");
		assert.ok(JSON.stringify(reopened.getEntries()).includes(CHILD_ANSWER), "its answer is in its session");
		assert.ok(!existsSync(own), "the other directory's JSONL store is never opened");
		assert.ok(!existsSync(join(elsewhere, "own.sqlite")), "the other directory's database is never opened");
	},
	REAL_SUBAGENT_TIMEOUT_MS,
);

test.each([
	["a named worktree", { worktree: { branch: "child-store-wt" } }],
	["a worktree: true task", { tasks: [{ agent: "helper-store", task: "Answer." }], worktree: true }],
] as const)(
	"a subagent in %s keeps its session in its parent's JSONL store",
	async (_name, launch) => {
		const cwd = makeTempDirectory("atomic-child-store-worktree-");
		cleanups.push(() => removeTempDirectory(cwd));
		gitCheckout(cwd);
		const { manager: parent, sessions } = await jsonlParent(cwd);
		const session = await parentSession(cwd, launch, { sessionManager: parent });

		const child = await delegate(session);
		const reopened = await childSessionIn(parent.getSessionStore(), child, cwd);
		assert.notEqual(reopened.getHeader()?.cwd, cwd, "the child ran in a worktree");
		assert.ok(JSON.stringify(reopened.getEntries()).includes(CHILD_ANSWER), "its answer is in its session");
		assert.ok(child.childSessionFile?.startsWith(sessions), `${child.childSessionFile} is in ${sessions}`);
	},
	REAL_SUBAGENT_TIMEOUT_MS,
);

test(
	"a subagent resumed after its parent restarts reads and writes its session in the parent's store",
	async () => {
		const cwd = makeTempDirectory("atomic-child-store-restart-");
		cleanups.push(() => removeTempDirectory(cwd));
		const { manager: parent } = await jsonlParent(cwd);
		const first = await parentSession(cwd, {}, { sessionManager: parent });
		const child = await delegate(first);
		const parentFile = parent.getSessionFile();
		assert.ok(parentFile);
		await first.dispose();
		clearSubagentControls();

		// The restarted parent opens its session from its file, as `atomic --session` does, and resumes its child.
		const restarted = await SessionManager.open(parentFile);
		const second = await parentSession(cwd, {}, { sessionManager: restarted });
		const resumed = await delegate(second, `RESUME ${child.childId}`);
		assert.equal(resumed.childSessionId, child.childSessionId, "the same child was resumed");
		const reopened = await childSessionIn(restarted.getSessionStore(), resumed, cwd);
		const entries = JSON.stringify(reopened.getEntries());
		assert.ok(entries.includes(CHILD_ANSWER), "its earlier answer is read from the parent's store");
		assert.ok(entries.includes("Answer again."), "the resume's message is written to the parent's store");
	},
	REAL_SUBAGENT_TIMEOUT_MS,
);

test.each(["default SQLite", "JSONL"] as const)(
	"a fresh and a forked subagent of one parent both keep internal sessions in its %s store",
	async (kind) => {
		const cwd = makeTempDirectory("atomic-child-store-fork-");
		cleanups.push(() => removeTempDirectory(cwd));
		const parent = kind === "JSONL" ? (await jsonlParent(cwd)).manager : undefined;
		const session = await parentSession(cwd, {}, parent ? { sessionManager: parent } : {});
		const store = session.sessionManager.getSessionStore();

		const fresh = await delegate(session);
		const forked = await delegate(session, "Delegate the answer with a fork.");
		assert.notEqual(forked.childSessionId, fresh.childSessionId);
		const freshSession = await childSessionIn(store, fresh, cwd);
		const forkSession = await childSessionIn(store, forked, cwd);
		assert.equal(freshSession.getHeader()?.parentSessionId, undefined, "the fresh child starts on no context");
		assert.equal(
			forkSession.getHeader()?.parentSessionId,
			session.sessionManager.getSessionId(),
			"the forked child starts on its parent's context",
		);
		assert.ok(
			JSON.stringify(forkSession.getEntries()).includes("Delegate the answer."),
			"the forked child's session holds its parent's conversation",
		);
	},
	REAL_SUBAGENT_TIMEOUT_MS,
);
