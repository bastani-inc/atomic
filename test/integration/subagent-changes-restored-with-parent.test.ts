/**
 * Resuming a session restores what its subagents changed in its checkout, also when the session itself changed no
 * file after them: a checkout's restore uses the newest capture of it among the session and its finished subagents.
 * Real parent and child sessions with the bundled subagents extension in a Git checkout, on a local model; the
 * checkout is moved away before the resume, as on another machine.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, test, vi } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import {
	prepareSessionResume,
	sessionResumeOptions,
} from "../../packages/coding-agent/src/core/resume/session-resume.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { renameWithRetry } from "../helpers/rename-retry.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

/** Structural cost: a real parent session runs a real subagent, then a resume restores a Git checkout. */
const REAL_SUBAGENT_TIMEOUT_MS = 120_000;
const PROVIDER = "faux-child-restore";
const MAIN_MODEL = "main-child-restore";
const CHILD_MODEL = "child-child-restore";
const WRITTEN = "written by the subagent 5e2b\n";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	clearSubagentControls();
	vi.unstubAllEnvs();
	sandbox.dispose();
});

/** The parent delegates once; the child writes `file` and answers. */
function scriptedModel(file: string): FauxResponseFactory {
	return (context) => {
		const parent = context.messages.some(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("Delegate the edit"),
		);
		const results = context.messages.filter((message) => message.role === "toolResult").length;
		if (!parent)
			return results === 0
				? fauxAssistantMessage([fauxToolCall("write", { path: file, content: WRITTEN })], { stopReason: "toolUse" })
				: fauxAssistantMessage("edited");
		if (results > 0) return fauxAssistantMessage("done");
		return fauxAssistantMessage([fauxToolCall("subagent", { agent: "editor-restore", task: "Make the edit." })], {
			stopReason: "toolUse",
		});
	};
}

async function parentSession(cwd: string, sessions: string, file: string): Promise<AgentSession> {
	// Under NODE_ENV=test a child runs a scripted stand-in session instead of its model.
	vi.stubEnv("NODE_ENV", "production");
	const faux = registerFauxProvider({ provider: PROVIDER, models: [{ id: MAIN_MODEL }, { id: CHILD_MODEL }] });
	cleanups.push(() => faux.unregister());
	faux.setResponses(Array.from({ length: 20 }, () => scriptedModel(file)));
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
	const agents = join(cwd, ".atomic", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(
		join(agents, "editor-restore.md"),
		`---\nname: editor-restore\ndescription: Edits a file\ntools: write\nmodel: ${PROVIDER}/${CHILD_MODEL}\n---\n\nMake the edit.\n`,
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
		sessionStore: { kind: "sqlite", path: sessions },
	});
	cleanups.push(() => session.dispose());
	return session;
}

/** What the parent's session recorded about its child. */
interface ChildRecord {
	readonly state?: string;
}

function childRecords(session: AgentSession): ChildRecord[] {
	return session.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === "subagent-child" ? [entry.data as ChildRecord] : [],
		);
}

test(
	"resuming a session elsewhere restores the changes its finished subagent made in its checkout",
	async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
		const sessions = sandbox.path("sessions.sqlite");
		const file = join(clone, "edit.txt");
		const session = await parentSession(clone, sessions, file);
		await session.prompt("Delegate the edit.", { streamingBehavior: "followUp" });
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
		assert.equal(readFileSync(file, "utf8"), WRITTEN, "the child wrote its file");
		assert.equal(
			session.sessionManager.getLatestWorktreeSnapshots().size,
			0,
			"the parent changed no file itself, so it captured nothing",
		);
		const parentId = session.sessionManager.getSessionId();
		await session.dispose();

		// As on another machine: the checkout the session worked in is not here.
		await renameWithRetry(clone, `${clone}-elsewhere`);
		const database = await openNodeSqliteDatabase(sessions);
		const store = await SqlSessionStore.open(database);
		cleanups.push(async () => {
			await store.close();
			await database.close();
		});
		const reopened = await SessionManager.open(store, parentId);
		const options = sessionResumeOptions(
			"cli",
			sandbox.root,
			sandbox.path("agent"),
			SettingsManager.inMemory(),
			() => true,
		);
		const prepared = await prepareSessionResume(reopened, { ...options, blueprints: "skip" });
		assert.equal(prepared.status, "ready");
		assert.ok(prepared.status === "ready");
		const restored = prepared.sessionManager.getCwd();
		assert.notEqual(restored, clone, "the session continues in a restored worktree");
		const restoredFile = join(restored, "edit.txt");
		assert.ok(existsSync(restoredFile), `the subagent's file is in ${restored}`);
		assert.equal(readFileSync(restoredFile, "utf8"), WRITTEN);
	},
	REAL_SUBAGENT_TIMEOUT_MS,
);
