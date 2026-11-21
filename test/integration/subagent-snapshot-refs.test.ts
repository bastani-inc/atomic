/**
 * Subagents whose sessions are kept in their parent's store record worktree snapshots of the checkouts they change, and
 * keep a Git ref to each snapshot commit, one per subagent and checkout, as long as the session that launched them:
 * deleting that session deletes them with its own. Real parent and child sessions in a Git checkout, on a local model.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, test, vi } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { deleteSessionWithSnapshotRefs } from "../../packages/coding-agent/src/core/session-worktree-snapshots.js";
import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	ModelRuntime,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

/** Structural cost: a real parent session runs three real subagents that write in a Git checkout. */
const REAL_SUBAGENT_TIMEOUT_MS = 120_000;
const PROVIDER = "faux-child-refs";
const CHILDREN = 3;

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

/** The parent writes a file, then launches the children; each child writes its own file and answers. */
function scriptedModel(cwd: string): FauxResponseFactory {
	return (context) => {
		const first = context.messages.find((message) => message.role === "user");
		const text = JSON.stringify(first?.content ?? "");
		const results = context.messages.filter((message) => message.role === "toolResult").length;
		const child = /Write child-(\d+)/.exec(text);
		if (child)
			return results === 0
				? fauxAssistantMessage(
						[fauxToolCall("write", { path: join(cwd, `child-${child[1]}.txt`), content: "x\n" })],
						{
							stopReason: "toolUse",
						},
					)
				: fauxAssistantMessage(`wrote ${child[1]}`);
		if (results === 0)
			return fauxAssistantMessage([fauxToolCall("write", { path: join(cwd, "parent.txt"), content: "p\n" })], {
				stopReason: "toolUse",
			});
		if (results === 1)
			return fauxAssistantMessage(
				Array.from({ length: CHILDREN }, (_, index) =>
					fauxToolCall("subagent", { agent: "writer-refs", task: `Write child-${index}` }),
				),
				{ stopReason: "toolUse" },
			);
		return fauxAssistantMessage("done");
	};
}

async function parentSession(cwd: string): Promise<AgentSession> {
	// Under NODE_ENV=test a child runs a scripted stand-in session instead of its model.
	vi.stubEnv("NODE_ENV", "production");
	const faux = registerFauxProvider({ provider: PROVIDER, models: [{ id: "main" }, { id: "child" }] });
	cleanups.push(() => faux.unregister());
	faux.setResponses(Array.from({ length: 40 }, () => scriptedModel(cwd)));
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
		join(agents, "writer-refs.md"),
		`---\nname: writer-refs\ndescription: Writes a file\ntools: write\nmodel: ${PROVIDER}/child\n---\n\nWrite the file.\n`,
	);
	const { session } = await createAgentSession({
		cwd,
		modelRuntime,
		model: faux.getModel("main"),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			sessionSummary: { enabled: false },
		}),
		builtins: { mcp: false, intercom: false, "web-access": false },
		sessionStore: { kind: "sqlite", path: sandbox.path("sessions.sqlite") },
	});
	cleanups.push(() => session.dispose());
	return session;
}

function terminalChildren(session: AgentSession): number {
	return session.sessionManager
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "subagent-child" &&
				(entry.data as { state?: string }).state === "terminal",
		).length;
}

async function snapshotRefs(cwd: string): Promise<string[]> {
	const listed = await sandbox.git(cwd, "for-each-ref", "--format=%(refname)", "refs/atomic/snapshots/");
	return listed.split("\n").filter((line) => line.length > 0);
}

test(
	"the snapshot refs of subagents that finished stay, one per subagent and checkout, until the session that launched them is deleted",
	async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
		const session = await parentSession(clone);
		await session.prompt("Write and delegate.", { streamingBehavior: "followUp" });
		await vi.waitFor(
			() => {
				assert.equal(terminalChildren(session), CHILDREN);
				assert.equal(session.isStreaming, false);
			},
			{ timeout: REAL_SUBAGENT_TIMEOUT_MS, interval: 20 },
		);
		const parentId = session.sessionManager.getSessionId();
		const refs = await snapshotRefs(clone);
		const owners = refs.map((ref) => ref.split("/")[3]);
		assert.equal(owners.filter((owner) => owner === parentId).length, 1, refs.join("\n"));
		assert.equal(owners.filter((owner) => owner !== parentId).length, CHILDREN, refs.join("\n"));
		assert.equal(new Set(owners).size, CHILDREN + 1, "one ref per session and checkout");

		const store = session.sessionManager.getSessionStore();
		await deleteSessionWithSnapshotRefs(store, parentId);
		assert.deepEqual(await snapshotRefs(clone), [], "deleting the session removes its refs and its subagents'");
	},
	REAL_SUBAGENT_TIMEOUT_MS,
);
