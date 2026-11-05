import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, describe, test } from "vitest";
import { inheritChildSessionOptions } from "../../packages/coding-agent/src/core/child-session-options.ts";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { setWorkspaceGitExecutableResolver } from "../../packages/coding-agent/src/core/workspace/git.ts";
import {
	isBoundWorkspace,
	isWorkspaceBindingError,
	isWorkspaceConfigError,
	resolveWorkspace,
	WORKSPACE_BINDING_ENTRY_TYPE,
	workspace,
} from "../../packages/coding-agent/src/core/workspace/index.ts";
import { AuthStorage, ModelRuntime, SessionManager, SettingsManager } from "../../packages/coding-agent/src/index.ts";
import {
	countGitCommands,
	createRepository,
	type WorkspaceSandboxDirs,
	workspaceSandbox,
} from "../helpers/workspace-repos.ts";

const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;

let dirs: WorkspaceSandboxDirs;
let faux: ReturnType<typeof registerFauxProvider>;
let modelRuntime: ModelRuntime;

beforeEach(async () => {
	dirs = workspaceSandbox("atomic-workspace-session-");
	faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
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
});

afterEach(() => {
	faux.unregister();
	dirs.cleanup();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail("expected a rejection");
}

function sessionOptions(extra: Parameters<typeof createAgentSession>[0]) {
	return {
		agentDir: join(dirs.home, "agent"),
		model: faux.getModel(),
		modelRuntime,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		builtins: BUILTINS,
		...extra,
	};
}

function toolResults(messages: readonly { role: string }[]) {
	return messages.filter((message) => message.role === "toolResult") as unknown as {
		toolName: string;
		isError: boolean;
		content: { type: string; text?: string }[];
	}[];
}

describe("createAgentSession({ workspace }) (#3109)", () => {
	test("runs in the bound worktree and records the binding in the session (#3109)", async () => {
		const repo = createRepository(dirs.root, "session");
		const { session, workspace: binding } = await createAgentSession(
			sessionOptions({
				workspace: workspace({ repo, branch: "session-work", label: "ci" }),
			}),
		);
		try {
			assert.ok(binding !== undefined && isBoundWorkspace(binding));
			assert.equal(session.workspace, binding);
			assert.equal(session.sessionManager.getCwd(), binding.worktree);
			const recorded = session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === WORKSPACE_BINDING_ENTRY_TYPE);
			assert.equal(recorded.length, 1);
			assert.deepEqual((recorded[0] as { data: unknown }).data, binding);
			assert.equal(binding.label, "ci");
			assert.ok(session.getActiveToolNames().includes("write"));
		} finally {
			session.dispose();
		}
	});

	test("a read-only reviewer is not offered file-writing tools and is refused when it calls them (#3109)", async () => {
		const repo = createRepository(dirs.root, "review");
		const target = join(repo, "reviewer-wrote.txt");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: target, content: "should never land" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("review done"),
			fauxAssistantMessage([fauxToolCall("edit", { input: "[README.md#0000]\nreplace 1..1:\n+changed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("write", { path: target, content: "should never land" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("still read-only"),
		]);
		const reviewer = workspace({ repo }).readOnly();
		const { session } = await createAgentSession(
			sessionOptions({ workspace: reviewer, sessionManager: SessionManager.inMemory() }),
		);
		try {
			const active = session.getActiveToolNames();
			for (const name of ["write", "edit", "todo"]) assert.equal(active.includes(name), false, name);
			assert.ok(active.includes("read"));
			await session.prompt("review the change");
			assert.equal(existsSync(target), false);
			const [unavailable] = toolResults(session.messages);
			assert.equal(unavailable?.toolName, "write");
			assert.equal(unavailable?.isError, true);

			session.setActiveToolsByName([...active, "write", "edit"]);
			await session.prompt("try again with the tools re-enabled");
			assert.equal(existsSync(target), false, "a re-enabled write is still refused");
			const refused = toolResults(session.messages).slice(1);
			assert.deepEqual(
				refused.map((result) => [result.toolName, result.isError]),
				[
					["edit", true],
					["write", true],
				],
			);
			for (const result of refused) assert.match(result.content[0]?.text ?? "", /\(write-denied\)/);
			assert.equal(readFileSync(join(repo, "README.md"), "utf-8"), "review\n");
		} finally {
			session.dispose();
		}
	});

	test("a writable workspace keeps its write tools (#3109)", async () => {
		const repo = createRepository(dirs.root, "writer");
		const target = join(repo, "written.txt");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: target, content: "landed" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const { session } = await createAgentSession(
			sessionOptions({ workspace: workspace({ repo }), sessionManager: SessionManager.inMemory() }),
		);
		try {
			await session.prompt("write it");
			assert.equal(readFileSync(target, "utf-8"), "landed");
		} finally {
			session.dispose();
		}
	});

	test("an explicit cwd must stay inside the worktree (#3109)", async () => {
		const repo = createRepository(dirs.root, "cwd");
		const inside = await createAgentSession(sessionOptions({ workspace: workspace({ repo }), cwd: "." }));
		assert.equal(inside.session.sessionManager.getCwd(), inside.workspace?.worktree);
		inside.session.dispose();
		const error = await rejection(
			createAgentSession(
				sessionOptions({
					workspace: workspace({ repo }),
					cwd: "../escape",
					sessionManager: SessionManager.inMemory(),
				}),
			),
		);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "cwd-outside-worktree");
		assert.equal(error.fields.worktree, inside.workspace?.worktree);
	});

	test("restores the binding a session recorded instead of resolving again (#3109)", async () => {
		const repo = createRepository(dirs.root, "resumed");
		const sessionDir = join(dirs.root, "sessions");
		const api = workspace({ repo, branch: "resumed-work", label: "nightly" });
		const first = await createAgentSession(
			sessionOptions({ workspace: api, sessionManager: await SessionManager.create(dirs.root, sessionDir) }),
		);
		const sessionFile = first.session.sessionManager.getSessionFile();
		const recorded = first.workspace!;
		first.session.dispose();
		rmSync(recorded.worktree, { recursive: true, force: true });

		const reopened = await SessionManager.open(sessionFile!, sessionDir);
		const second = await createAgentSession(
			sessionOptions({
				workspace: workspace({ repo, branch: "resumed-work" }).readOnly(),
				sessionManager: reopened,
			}),
		);
		try {
			assert.equal(existsSync(recorded.worktree), true, "the deleted worktree was re-added");
			assert.equal(second.workspace?.baseCommit, recorded.baseCommit);
			assert.equal(second.workspace?.label, "nightly", "the recorded label survives");
			assert.equal(second.workspace?.sandbox, "read-only", "the caller's sandbox applies");
		} finally {
			second.session.dispose();
		}
	});

	test("rejects a malformed workspace before any git work or session (#3109)", async () => {
		const { result, commands } = await countGitCommands(() =>
			rejection(createAgentSession(sessionOptions({ workspace: { repo: "/tmp" } as never }))),
		);
		assert.ok(isWorkspaceConfigError(result));
		assert.equal(result.field, "workspace");
		assert.equal(commands.length, 0);
	});

	test("fails fast when git is missing, after one probe and no writes (#3109)", async () => {
		const repo = createRepository(dirs.root, "no-git");
		const restore = setWorkspaceGitExecutableResolver(async () => ({
			path: join(dirs.root, "missing-git"),
			env: {},
		}));
		try {
			const { result, commands } = await countGitCommands(() =>
				rejection(createAgentSession(sessionOptions({ workspace: workspace({ repo, branch: "never" }) }))),
			);
			assert.ok(isWorkspaceBindingError(result));
			assert.equal(result.code, "git-unavailable");
			assert.equal(commands.length, 1);
			assert.equal(existsSync(join(dirs.home, "worktrees")), false);
		} finally {
			restore();
		}
	});
});

describe("child sessions of a bound session (#3109)", () => {
	test("inherit the parent's workspace, and a read-only parent caps a child's own workspace (#3109)", async () => {
		const repo = createRepository(dirs.root, "child");
		const binding = await resolveWorkspace(workspace({ repo }).readOnly());
		const inherited = inheritChildSessionOptions({ cwd: binding.worktree, workspace: binding }, {});
		assert.equal(inherited.workspace, binding);
		assert.equal(inherited.cwd, binding.worktree);

		const own = workspace({ repo: createRepository(dirs.root, "child-own") });
		const capped = inheritChildSessionOptions({ cwd: binding.worktree, workspace: binding }, { workspace: own });
		assert.equal((capped.workspace as { sandbox: string }).sandbox, "read-only");
		assert.equal(capped.cwd, undefined, "the child's own workspace chooses its cwd");

		const writable = await resolveWorkspace(workspace({ repo }));
		const cappedBinding = inheritChildSessionOptions(
			{ cwd: binding.worktree, workspace: binding },
			{ workspace: writable },
		);
		assert.equal((cappedBinding.workspace as { sandbox: string }).sandbox, "read-only");
		const free = inheritChildSessionOptions({ cwd: writable.worktree, workspace: writable }, { workspace: own });
		assert.equal(free.workspace, own);
	});
});
