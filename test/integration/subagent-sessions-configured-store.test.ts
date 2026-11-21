/**
 * A subagent's own session is kept in the session storage its parent uses: the parent's SQLite store by default, its
 * memory store when the parent saves nothing, and files only when the parent's sessions are files or the launch names
 * a directory for them. Real parent and child sessions with the bundled subagents extension, on a local model.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

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
function scriptedModel(launch: Record<string, unknown>): FauxResponseFactory {
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
		return fauxAssistantMessage([fauxToolCall("subagent", { agent: "helper-store", task: "Answer.", ...launch })], {
			stopReason: "toolUse",
		});
	};
}

async function parentSession(
	cwd: string,
	launch: Record<string, unknown>,
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
	mkdirSync(join(cwd, ".atomic", "agents"), { recursive: true });
	writeFileSync(
		join(cwd, ".atomic", "agents", "helper-store.md"),
		`---\nname: helper-store\ndescription: Answers\ntools: read\nmodel: ${PROVIDER}/${CHILD_MODEL}\n---\n\nAnswer the task.\n`,
	);
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

/** The parent launches its child, which runs in the background; resolves with the child's record once it finished. */
async function delegate(session: AgentSession): Promise<ChildRecord> {
	await session.prompt("Delegate the answer.", { streamingBehavior: "followUp" });
	await vi.waitFor(
		() => {
			assert.ok(
				childRecords(session).some((record) => record.state === "terminal"),
				JSON.stringify(childRecords(session)),
			);
			assert.equal(session.isStreaming, false);
		},
		{ timeout: REAL_SUBAGENT_TIMEOUT_MS, interval: 20 },
	);
	const record = childRecords(session).findLast((candidate) => candidate.childSessionId !== undefined);
	assert.ok(record, `the parent recorded its child's session: ${JSON.stringify(childRecords(session))}`);
	return record;
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
	"a subagent of a session kept in files keeps its own session file beside its parent's",
	async () => {
		const cwd = makeTempDirectory("atomic-child-store-jsonl-");
		cleanups.push(() => removeTempDirectory(cwd));
		const sessions = join(cwd, "parent-sessions");
		const parent = await SessionManager.create(cwd, sessions);
		const session = await parentSession(cwd, {}, { sessionManager: parent });

		const child = await delegate(session);
		const parentFile = parent.getSessionFile();
		assert.ok(parentFile);
		assert.ok(child.childSessionFile, "the child has a session file of its own");
		assert.ok(readFileSync(child.childSessionFile, "utf8").includes(CHILD_ANSWER), "its answer is in its file");
		assert.ok(
			child.childSessionFile.startsWith(join(sessions, parentFile.slice(sessions.length + 1, -".jsonl".length))),
			`${child.childSessionFile} is beside ${parentFile}`,
		);
	},
	REAL_SUBAGENT_TIMEOUT_MS,
);

test(
	"a subagent launched with a session directory keeps its session file there, whatever its parent's storage",
	async () => {
		const cwd = makeTempDirectory("atomic-child-store-dir-");
		cleanups.push(() => removeTempDirectory(cwd));
		const chosen = join(cwd, "chosen-sessions");
		const session = await parentSession(cwd, { sessionDir: chosen });

		const child = await delegate(session);
		const file = child.childSessionFile;
		assert.ok(file, "the child has a session file of its own");
		assert.ok(file.startsWith(chosen), `${file} is in ${chosen}`);
		assert.ok(readFileSync(file, "utf8").includes(CHILD_ANSWER), "its answer is in its file");
		assert.equal(sessionFilesUnder(chosen).length, 1);
	},
	REAL_SUBAGENT_TIMEOUT_MS,
);
