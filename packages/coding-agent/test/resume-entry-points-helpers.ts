import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import type { AgentSession } from "../src/core/agent-session.js";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { renameReplacing } from "../src/core/rename-retry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { StorageSelection } from "../src/core/storage/provider.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";

/** The last record of a checkout the resume of `manager`'s session continued without (#4733). */
export function lastUnrestored(manager: SessionManager) {
	const entry = manager
		.getBranch()
		.findLast((candidate) => candidate.type === "worktree_snapshot" && candidate.unrestored !== undefined);
	return entry?.type === "worktree_snapshot" ? entry.unrestored : undefined;
}

/** Settings whose `resume.setupCommand` runs in every restored worktree: the alias runs only in a trusted project. */
export const settings = (setupCommand?: string) =>
	SettingsManager.inMemory(
		setupCommand === undefined ? {} : { defaultProjectTrust: "always", resume: { setupCommand } },
	);

/** The text `session`'s own read tool returns for `path`. */
export async function readWithTools(session: AgentSession, path: string): Promise<string> {
	const read = session.agent.state.tools.find((tool) => tool.name === "read");
	assert.ok(read);
	const result = await read.execute("read-recorded-path", { path });
	return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

export function useResumeEntryPointsFixture() {
	useTemporaryAgentDir();

	let currentSandbox: GitSandbox;
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeEach(() => {
		currentSandbox = new GitSandbox();
	});
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		currentSandbox.dispose();
	});

	const sqliteSelection = (name: string): StorageSelection => ({
		kind: "sqlite",
		path: currentSandbox.path(`${name}.sqlite`),
	});

	async function storeFor(selection: StorageSelection): Promise<SessionStore> {
		const store = await resolveSessionStore(currentSandbox.root, {
			agentDir: currentSandbox.path("agent"),
			sessionStore: selection,
		});
		cleanups.push(() => store.close());
		return store;
	}

	/** A session recorded "on node A" in `selection` whose last turn snapshotted its checkout. */
	async function recordSessionWithSnapshot(
		selection: StorageSelection,
		files: Record<string, string> = {},
		remotes?: readonly string[],
		name = "repo",
	) {
		const { clone } = await currentSandbox.remoteWithClone(name, { "README.md": "hello\n", ...files });
		currentSandbox.write(join(clone, "README.md"), "edited on node A\n");
		const store = await storeFor(selection);
		const manager = await SessionManager.create(store, clone);
		await manager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
		const capture = await captureWorktreeSnapshot(clone, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			blobs: store.snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		const snapshot = remotes === undefined ? capture.snapshot : { ...capture.snapshot, remotes: [...remotes] };
		await manager.appendWorktreeSnapshot(clone, snapshot.id, snapshot);
		return { clone, sessionId: manager.getSessionId() };
	}

	/** A session recorded "on node A" in `selection`, whose checkout then disappears from this machine. */
	async function sessionRecordedElsewhere(selection: StorageSelection, files: Record<string, string> = {}) {
		const recorded = await recordSessionWithSnapshot(selection, files);
		renameReplacing(recorded.clone, currentSandbox.path("node-a-offline"));
		return recorded;
	}

	/** A runtime whose sessions a UI shows, as for /resume, or with `"unset"` a runtime that is not told whether one does. */
	async function runtimeOn(agentDir: string, settingsJson: object, interactive: true | "unset" = true) {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settingsJson));
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one")]);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime,
				model,
				resourceLoaderOptions: {
					builtinPackagePaths: [],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const store = await storeFor(sqliteSelection("shared"));
		const initial = await SessionManager.create(store, currentSandbox.root);
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: currentSandbox.root,
			agentDir,
			sessionManager: initial,
			...(interactive === "unset" ? {} : { interactive }),
		});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
		});
		return { runtime, createRuntime };
	}

	return {
		get sandbox() {
			return currentSandbox;
		},
		cleanups,
		sqliteSelection,
		storeFor,
		recordSessionWithSnapshot,
		sessionRecordedElsewhere,
		runtimeOn,
	};
}
