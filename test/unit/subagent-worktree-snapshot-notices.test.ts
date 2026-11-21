/**
 * A subagent's own session records worktree snapshots only where its storage can hold them, and never reports a store
 * it did not choose. Real in-process runner and real parent and child AgentSessions in a Git checkout, against a local
 * provider; no network is contacted.
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, test } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

/** Structural cost: each case builds a real parent AgentSession and a real child AgentSession with its resources. */
const REAL_CHILD_SESSION_TIMEOUT_MS = 90_000;

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	clearSubagentControls();
	sandbox.dispose();
});

const NO_BUILTINS = { subagents: false, mcp: false, "web-access": false, intercom: false } as const;

function writer(cwd: string): AgentConfig {
	return {
		name: "writer",
		description: "writes files",
		systemPrompt: "Write the files you are asked to.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(cwd, "writer.md"),
		tools: ["write"],
	};
}

/** A parent session in a Git checkout, on JSONL files or in a SQLite store, that launches children on a local model. */
async function parentIn(storage: "jsonl" | "sqlite") {
	const { clone } = await sandbox.remoteWithClone();
	const faux = registerFauxProvider();
	cleanups.push(() => faux.unregister());
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [{ ...model }] });
	const agentDir = sandbox.path("agent");
	mkdirSync(agentDir, { recursive: true });
	const { session: parent } = await createAgentSession({
		cwd: clone,
		agentDir,
		modelRuntime,
		model,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		builtins: NO_BUILTINS,
		tools: ["read", "write"],
		...(storage === "sqlite"
			? { sessionStore: { kind: "sqlite" as const, path: sandbox.path("sessions.sqlite") } }
			: { sessionManager: await SessionManager.create(clone, sandbox.path("parent-sessions")) }),
	});
	cleanups.push(() => parent.dispose());
	// The parent's own history, which a forked child copies.
	await parent.sessionManager.appendMessage({
		role: "user",
		content: "coordinate the writers",
		timestamp: Date.now(),
	});
	return { clone, faux, model, parent };
}

/**
 * Runs one child that writes `file` in `cwd` on two turns, and returns what its session reported and recorded. The
 * child's events are read from its own transcript, where its chat shows them.
 */
async function runWriter(
	fixture: Awaited<ReturnType<typeof parentIn>>,
	runId: string,
	options: { readonly cwd?: string; readonly fork?: boolean } = {},
) {
	const { faux, model, parent } = fixture;
	const cwd = options.cwd ?? fixture.clone;
	const file = join(cwd, `${runId}.txt`);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: file, content: "first\n" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("write", { path: file, content: "second\n" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("written"),
	]);
	const forked = options.fork
		? await createForkContextResolver(parent.sessionManager, "fork").sessionManagerForIndex(0)
		: undefined;
	const notices: string[] = [];
	let child: { readonly sessionId: string; readonly sessionFile: string | undefined } | undefined;
	let cleanup: Promise<unknown> | undefined;
	const unsubscribes: Array<() => void> = [];
	const fullId = `${model.provider}/${model.id}`;
	try {
		const result = await runSingleInProcess(cwd, writer(cwd), "Write the file.", {
			cwd,
			runId,
			index: 0,
			sessionDir: sandbox.path("subagent-sessions"),
			testSession: false,
			modelOverride: fullId,
			knownModelProviders: [model.provider],
			currentModel: fullId,
			availableModels: [{ provider: model.provider, id: model.id, fullId }],
			getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions,
			...(forked ? { sessionManager: forked } : {}),
			taskExecution: {
				signal: new AbortController().signal,
				reportActivity() {},
				onExecution(execution) {
					cleanup = execution.cleanup;
				},
				bindChildSession(session) {
					child = session;
				},
				bindTranscript(source) {
					const unsubscribe = source.subscribe?.((event) => {
						if (event.type === "worktree_snapshot_unavailable") notices.push(event.reason.code ?? "");
					});
					if (unsubscribe) unsubscribes.push(unsubscribe);
				},
			},
		});
		await cleanup;
		assert.equal(result.status, "ok", result.error);
		assert.equal(result.finalOutput, "written");
		assert.ok(child, "the child opened a session");
		// What the child's session saved, read back as a restart reads it.
		const saved = child.sessionFile
			? await SessionManager.open(child.sessionFile)
			: await SessionManager.open(parent.sessionManager.getSessionStore(), child.sessionId);
		return {
			notices,
			snapshots: saved.getEntries().filter((entry) => entry.type === "worktree_snapshot").length,
			holdsBlobs: saved.getSessionStore().snapshotBlobs !== undefined,
		};
	} finally {
		for (const unsubscribe of unsubscribes) unsubscribe();
	}
}

test(
	"a subagent whose session is a file of its run records no snapshot and shows no storage warning",
	async () => {
		const outcome = await runWriter(await parentIn("sqlite"), "fresh");
		assert.deepEqual(outcome, { notices: [], snapshots: 0, holdsBlobs: false });
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a subagent in a named worktree records no snapshot and shows no storage warning",
	async () => {
		const fixture = await parentIn("sqlite");
		const worktree = sandbox.path("named-worktree");
		await sandbox.git(fixture.clone, "worktree", "add", "-q", "-b", "feature", worktree);
		const outcome = await runWriter(fixture, "named", { cwd: worktree });
		assert.deepEqual(outcome, { notices: [], snapshots: 0, holdsBlobs: false });
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a forked subagent of a session kept in files shows no storage warning",
	async () => {
		const outcome = await runWriter(await parentIn("jsonl"), "fork-files", { fork: true });
		assert.deepEqual(outcome, { notices: [], snapshots: 0, holdsBlobs: false });
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a forked subagent of a session kept in a database still records a snapshot on each turn that writes",
	async () => {
		const outcome = await runWriter(await parentIn("sqlite"), "fork-database", { fork: true });
		assert.deepEqual(outcome, { notices: [], snapshots: 2, holdsBlobs: true });
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);
