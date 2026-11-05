import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, describe, test } from "vitest";
import { inheritChildSessionOptions } from "../../packages/coding-agent/src/core/child-session-options.ts";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.ts";
import { createAgentSession, createUnstartedAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { setWorkspaceGitExecutableResolver } from "../../packages/coding-agent/src/core/workspace/git.ts";
import {
	type BoundWorkspace,
	isBoundWorkspace,
	isWorkspaceBindingError,
	isWorkspaceConfigError,
	resolveWorkspace,
	WORKSPACE_BINDING_ENTRY_TYPE,
	WorkspaceConfigError,
	workspace,
} from "../../packages/coding-agent/src/core/workspace/index.ts";
import {
	bindSessionWorkspace,
	inheritWorkspace,
	recordSessionWorkspace,
	workspaceSandboxDenial,
	workspaceSessionCwd,
} from "../../packages/coding-agent/src/core/workspace/session.ts";
import { AuthStorage, ModelRuntime, SessionManager, SettingsManager } from "../../packages/coding-agent/src/index.ts";
import { stripWorkflowOnlyOptions } from "../../packages/workflows/src/runs/foreground/stage-runner-options.js";
import {
	commitFile,
	countGitCommands,
	createRepository,
	git,
	type WorkspaceSandboxDirs,
	withInjectedGit,
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
		sessionStore: new MemorySessionStore(),
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
			sessionOptions({ workspace: reviewer, sessionManager: SessionManager.inMemory(repo) }),
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
			for (const name of ["write", "edit"])
				assert.equal(session.getActiveToolNames().includes(name), false, `${name} stays excluded`);
			await session.prompt("try again after asking for the tools");
			assert.equal(existsSync(target), false, "a write is still refused");
			const refused = toolResults(session.messages).slice(1);
			assert.deepEqual(
				refused.map((result) => [result.toolName, result.isError]),
				[
					["edit", true],
					["write", true],
				],
			);
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
			sessionOptions({ workspace: workspace({ repo }), sessionManager: SessionManager.inMemory(repo) }),
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
					sessionManager: SessionManager.inMemory(repo),
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
		const { worktree } = await resolveWorkspace(api);
		const first = await createAgentSession(
			sessionOptions({ workspace: api, sessionManager: await SessionManager.create(worktree, sessionDir) }),
		);
		const sessionFile = first.session.sessionManager.getSessionFile();
		const recorded = first.workspace!;
		first.session.dispose();
		rmSync(recorded.worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

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

	test("a resumed workflow stage session restores its recorded binding and fails closed on drift (#3109)", async () => {
		const repo = createRepository(dirs.root, "stage-resume");
		const store = new MemorySessionStore();
		const meta = { runId: "run-1", stageId: "stage-1", stageName: "work" };
		const stageWork = workspace({ repo, branch: "stage-work", label: "first" });
		const first = await createAgentSession(
			sessionOptions({
				workspace: stageWork,
				sessionManager: await SessionManager.create(store, (await resolveWorkspace(stageWork)).worktree),
			}),
		);
		const sessionId = first.session.sessionManager.getSessionId();
		const recorded = first.workspace!;
		first.session.dispose();
		commitFile(repo, "base-moved.txt", "main moved on\n");

		const resumedSpec = workspace({ repo, branch: "stage-work" });
		const { result: options, commands } = await countGitCommands(() =>
			stripWorkflowOnlyOptions(
				{ workspace: resumedSpec, resumeFromSessionId: sessionId, sessionStore: store },
				undefined,
				meta,
			),
		);
		const restored = options.workspace as BoundWorkspace;
		assert.equal(restored.baseCommit, recorded.baseCommit);
		assert.equal(restored.label, "first", "the recorded label survives");
		assert.equal(options.cwd, recorded.worktree, "an adapter's host directory cannot replace the worktree");
		assert.ok(
			commands.some((args) => args[0] === "merge-base" && args[1] === "--is-ancestor"),
			"the recorded binding was restored and checked for drift",
		);
		assert.equal(await resolveWorkspace(resumedSpec), restored, "later resolutions reuse it");
		const resumed = await createAgentSession(sessionOptions({ ...options, cwd: options.cwd }));
		try {
			assert.equal(resumed.workspace, restored);
			assert.equal(resumed.session.sessionManager.getSessionId(), sessionId);
		} finally {
			resumed.session.dispose();
		}

		git(recorded.worktree, "commit", "-q", "--allow-empty", "--amend", "-m", "rewritten");
		const drifted = await rejection(
			stripWorkflowOnlyOptions(
				{
					workspace: workspace({ repo, branch: "stage-work" }),
					resumeFromSessionId: sessionId,
					sessionStore: store,
				},
				undefined,
				meta,
			),
		);
		assert.ok(isWorkspaceBindingError(drifted));
		assert.equal(drifted.code, "drift");
		assert.equal(drifted.reason, "history-rewritten");
	});

	// POSIX: the stand-in git that stalls the worktree addition is a shell script.
	test.skipIf(process.platform === "win32")(
		"a stage stopped while its workspace is being bound stops waiting for the binding (#3109)",
		async () => {
			const repo = createRepository(dirs.root, "stopped-setup");
			const added = join(dirs.root, "added");
			const controller = new AbortController();
			const reason = new Error("stage stopped");
			const api = workspace({ repo, branch: "feat/slow-setup" });
			await withInjectedGit(
				dirs.root,
				{ FAKE_GIT_SLOW: "worktree add", FAKE_GIT_SLEEP: "2", FAKE_GIT_MARKER: added },
				async () => {
					const setup = stripWorkflowOnlyOptions(
						{ workspace: api },
						undefined,
						{ runId: "run-1", stageId: "stage-1", stageName: "work" },
						undefined,
						controller.signal,
					);
					setTimeout(() => controller.abort(reason), 200);
					assert.equal(await rejection(setup), reason);
					assert.equal(existsSync(added), false, "the stage stopped before the slow addition finished");
					await resolveWorkspace(api);
				},
			);
		},
	);

	test("a resumed stage session without a workspace still opens in the stage's cwd (#3109)", async () => {
		const store = new MemorySessionStore();
		const created = await SessionManager.create(store, dirs.root);
		await created.appendCustomEntry("marker", {});
		const cwd = join(dirs.root, "stage-cwd");
		mkdirSync(cwd);
		const options = await stripWorkflowOnlyOptions(
			{ resumeFromSessionId: created.getSessionId(), sessionStore: store, cwd },
			undefined,
			{ runId: "run-1", stageId: "stage-1", stageName: "work" },
		);
		assert.equal(options.sessionManager?.getCwd(), cwd);
	});

	test("a read-only session leaves file-writing tools out of an explicit tools list (#3109)", async () => {
		const listed = createRepository(dirs.root, "listed");
		const { session } = await createAgentSession(
			sessionOptions({
				workspace: workspace({ repo: listed }).readOnly(),
				tools: ["read", "write", "edit", "bash"],
				sessionManager: SessionManager.inMemory(listed),
			}),
		);
		try {
			assert.deepEqual([...session.getActiveToolNames()].sort(), ["bash", "read"]);
		} finally {
			session.dispose();
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

function fakeSession(entries: { customType?: string; data?: unknown }[] = []) {
	const appended: { customType: string; data: unknown }[] = [];
	return {
		appended,
		getEntries: () => [...entries, ...appended].map((entry) => ({ type: "custom", ...entry })),
		async appendCustomEntry(customType: string, data?: unknown) {
			appended.push({ customType, data });
			return String(appended.length);
		},
	};
}

describe("workspace session helpers (#3109)", () => {
	test("resolve a session cwd inside the worktree and reject escapes (#3109)", async () => {
		const repo = createRepository(dirs.root, "cwd-helper");
		const binding = await resolveWorkspace(workspace({ repo }));
		mkdirSync(join(binding.worktree, "pkg"));
		assert.equal(workspaceSessionCwd(binding), binding.worktree);
		assert.equal(workspaceSessionCwd(binding, "."), binding.worktree);
		assert.equal(workspaceSessionCwd(binding, "pkg"), join(binding.worktree, "pkg"));
		assert.equal(workspaceSessionCwd(binding, join(binding.worktree, "pkg")), join(binding.worktree, "pkg"));
		assert.equal(workspaceSessionCwd(binding, "not/yet/there"), join(binding.worktree, "not", "yet", "there"));
		symlinkSync(dirs.root, join(binding.worktree, "escape-link"), "junction");
		for (const outside of ["..", "../other", "escape-link", "escape-link/sub", dirs.root]) {
			const error = (() => {
				try {
					workspaceSessionCwd(binding, outside);
				} catch (caught) {
					return caught;
				}
				return undefined;
			})();
			assert.ok(isWorkspaceBindingError(error), outside);
			assert.equal(error.code, "cwd-outside-worktree");
			assert.equal(error.fields.worktree, binding.worktree);
		}
		assert.equal(git(repo, "status", "--porcelain").includes("escape-link"), true);
	});

	test("deny only file-writing tools, only in read-only bindings (#3109)", () => {
		const readOnly = { sandbox: "read-only" as const, worktree: "/w" };
		const denial = workspaceSandboxDenial(readOnly, "edit");
		assert.equal(denial?.code, "write-denied");
		assert.deepEqual(denial?.fields, { tool: "edit", worktree: "/w", sandbox: "read-only" });
		assert.equal(workspaceSandboxDenial(readOnly, "read"), undefined);
		assert.equal(workspaceSandboxDenial(readOnly, "bash"), undefined);
		assert.equal(workspaceSandboxDenial({ sandbox: "workspace-write", worktree: "/w" }, "write"), undefined);
		assert.equal(workspaceSandboxDenial(undefined, "write"), undefined);
	});

	test("inherit a parent's workspace and keep a read-only ceiling (#3109)", () => {
		const writable = workspace({ repo: "/srv/a" });
		const readOnly = writable.readOnly();
		assert.equal(inheritWorkspace(undefined, undefined), undefined);
		assert.equal(inheritWorkspace(undefined, writable), writable);
		assert.equal(inheritWorkspace(writable, undefined), writable);
		assert.equal(inheritWorkspace(readOnly, writable), readOnly);
		assert.equal(inheritWorkspace(writable, readOnly), readOnly);
	});

	test("restore a recorded binding only for the same workspace, keeping or replacing its label (#3109)", async () => {
		const repo = createRepository(dirs.root, "recorded");
		const recorded = await resolveWorkspace(workspace({ repo, base: "main", branch: "recorded", label: "first" }));
		const decoy = { ...recorded, label: "decoy" };
		const session = fakeSession([
			{ customType: WORKSPACE_BINDING_ENTRY_TYPE, data: recorded },
			{ customType: "something-else", data: decoy },
			{ customType: WORKSPACE_BINDING_ENTRY_TYPE, data: { kind: "not-a-binding" } },
		]);
		const same = await bindSessionWorkspace(workspace({ repo, branch: "recorded" }), session);
		assert.equal(same.label, "first");
		const branchless = await bindSessionWorkspace(workspace({ repo }), session);
		assert.equal(branchless.branch, "recorded", "a workspace without a branch restores the recorded one");
		assert.equal(branchless.label, "first");
		const sameBase = await bindSessionWorkspace(workspace({ repo, base: "main", branch: "recorded" }), session);
		assert.equal(sameBase.label, "first", "an explicit base that matches the record restores it");
		assert.equal(same.head, recorded.head);
		const relabelled = await bindSessionWorkspace(workspace({ repo, branch: "recorded", label: "second" }), session);
		assert.equal(relabelled.label, "second");
		const auto = await bindSessionWorkspace(workspace({ repo, branch: "recorded", worktree: "auto" }), session);
		assert.equal(auto.label, "first");
		const explicit = await bindSessionWorkspace(
			workspace({ repo, branch: "recorded", worktree: recorded.worktree }),
			session,
		);
		assert.equal(explicit.label, "first");
		const elsewhere = await rejection(
			bindSessionWorkspace(
				workspace({ repo, branch: "recorded", worktree: join(dirs.root, "elsewhere-wt") }),
				session,
			),
		);
		assert.ok(isWorkspaceBindingError(elsewhere), "another worktree path is resolved, not restored");
		for (const different of [
			workspace({ repo, branch: "other-branch" }),
			workspace({ repo, base: "HEAD", branch: "recorded" }),
			workspace({ repo: createRepository(dirs.root, "elsewhere"), branch: "recorded" }),
		]) {
			const bound = await bindSessionWorkspace(different, session);
			assert.equal(
				bound.label,
				undefined,
				`${different.repo} ${different.branch} ${different.base} ${different.worktree}`,
			);
		}
		const unlabelled = await resolveWorkspace(workspace({ repo, branch: "plain" }));
		const plain = await bindSessionWorkspace(
			workspace({ repo, branch: "plain" }),
			fakeSession([{ customType: WORKSPACE_BINDING_ENTRY_TYPE, data: unlabelled }]),
		);
		assert.equal("label" in plain, false);
		assert.equal(await bindSessionWorkspace(recorded, session), recorded);
	});

	test("cancel both restoring and resolving a session's workspace with signal.reason (#3109)", async () => {
		const repo = createRepository(dirs.root, "cancelled-session");
		const recorded = await resolveWorkspace(workspace({ repo, branch: "recorded" }));
		const session = fakeSession([{ customType: WORKSPACE_BINDING_ENTRY_TYPE, data: recorded }]);
		const controller = new AbortController();
		const reason = new Error("session cancelled");
		controller.abort(reason);
		assert.equal(
			await rejection(bindSessionWorkspace(workspace({ repo, branch: "recorded" }), session, controller.signal)),
			reason,
		);
		assert.equal(
			await rejection(bindSessionWorkspace(workspace({ repo, branch: "fresh" }), session, controller.signal)),
			reason,
		);
	});

	test("record a binding once per change (#3109)", async () => {
		const repo = createRepository(dirs.root, "record-once");
		const binding = await resolveWorkspace(workspace({ repo }));
		const session = fakeSession();
		await recordSessionWorkspace(session, binding);
		await recordSessionWorkspace(session, binding);
		assert.equal(session.appended.length, 1);
		await recordSessionWorkspace(session, { ...binding, sandbox: "read-only" });
		assert.equal(session.appended.length, 2);
		assert.deepEqual(session.appended[1], {
			customType: WORKSPACE_BINDING_ENTRY_TYPE,
			data: { ...binding, sandbox: "read-only" },
		});
	});
});

describe("sessions without a workspace (#3109)", () => {
	test("keep their cwd precedence and record no binding (#3109)", async () => {
		const cwd = join(dirs.root, "explicit");
		mkdirSync(cwd);
		const explicit = await createAgentSession(
			sessionOptions({ cwd, sessionManager: SessionManager.inMemory(dirs.root) }),
		);
		assert.equal((explicit.session as unknown as { _cwd: string })._cwd, cwd);
		assert.equal("workspace" in explicit, false);
		assert.equal(explicit.session.workspace, undefined);
		assert.equal(
			explicit.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === WORKSPACE_BINDING_ENTRY_TYPE),
			false,
		);
		explicit.session.dispose();
		const fromManager = await createAgentSession(
			sessionOptions({ sessionManager: SessionManager.inMemory(dirs.root) }),
		);
		assert.equal((fromManager.session as unknown as { _cwd: string })._cwd, dirs.root);
		fromManager.session.dispose();
		const fallback = await createAgentSession(sessionOptions({}));
		assert.equal((fallback.session as unknown as { _cwd: string })._cwd, process.cwd());
		fallback.session.dispose();
	});

	test("a resumed session created without a workspace records nothing about its earlier one (#3109)", async () => {
		const binding = await resolveWorkspace(workspace({ repo: createRepository(dirs.root, "earlier") }));
		const sessionManager = SessionManager.inMemory(dirs.root);
		await sessionManager.appendCustomEntry(WORKSPACE_BINDING_ENTRY_TYPE, binding);
		const bindings = () =>
			sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === WORKSPACE_BINDING_ENTRY_TYPE);
		const resumed = await createAgentSession(sessionOptions({ sessionManager }));
		assert.equal(bindings().length, 1);
		resumed.session.dispose();
	});

	test("a session manager working outside the worktree fails fast, naming it (#3109)", async () => {
		const repo = createRepository(dirs.root, "elsewhere-manager");
		const bound = await resolveWorkspace(workspace({ repo, branch: "feat/manager" }));
		const outside = SessionManager.inMemory(dirs.root);
		const { result: error, commands } = await countGitCommands(() =>
			rejection(
				createAgentSession(
					sessionOptions({ workspace: workspace({ repo, branch: "feat/manager" }), sessionManager: outside }),
				),
			),
		);
		assert.ok(error instanceof WorkspaceConfigError);
		assert.ok(isWorkspaceConfigError(error));
		assert.equal(error.field, "sessionManager");
		assert.equal(error.source, "sdk");
		assert.equal(error.reason, "invalid-value");
		assert.equal(error.fields.received, `a session manager in ${resolve(dirs.root)}`);
		assert.equal(
			error.message,
			`Invalid workspace option: sessionManager from sdk is a session manager in ${resolve(dirs.root)}, expected a session manager whose cwd is inside ${bound.worktree} (invalid-setting). Set sessionManager to a session manager whose cwd is inside ${bound.worktree}.`,
		);
		assert.equal(
			outside
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === WORKSPACE_BINDING_ENTRY_TYPE),
			false,
			"nothing was recorded in the session",
		);
		assert.ok(commands.length > 0, "the workspace was bound before the manager was checked");
		const inside = await createAgentSession(
			sessionOptions({
				workspace: workspace({ repo, branch: "feat/manager" }),
				sessionManager: SessionManager.inMemory(join(bound.worktree, "sub")),
			}),
		);
		assert.equal(inside.workspace?.worktree, bound.worktree, "a manager inside the worktree is accepted");
		inside.session.dispose();
	});

	test("an unstarted host mirror does not write the binding entry (#3109)", async () => {
		const repo = createRepository(dirs.root, "mirror");
		const sessionManager = SessionManager.inMemory(repo);
		const mirror = await createUnstartedAgentSession(
			sessionOptions({ workspace: workspace({ repo }), sessionManager }),
			false,
		);
		assert.ok(mirror.workspace !== undefined);
		assert.equal(
			sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === WORKSPACE_BINDING_ENTRY_TYPE),
			false,
		);
		mirror.session.dispose();
	});

	test("child sessions without workspaces resolve cwd as before (#3109)", () => {
		const parent = { cwd: "/parent" };
		assert.equal(inheritChildSessionOptions(parent, {}).cwd, resolve("/parent"));
		assert.equal(inheritChildSessionOptions(parent, { cwd: "sub" }).cwd, resolve("/parent", "sub"));
		assert.equal(
			inheritChildSessionOptions(parent, { sessionManager: SessionManager.inMemory("/elsewhere") }).cwd,
			resolve("/elsewhere"),
		);
		assert.equal(inheritChildSessionOptions(parent, { workspace: workspace({ repo: "/r" }), cwd: "pkg" }).cwd, "pkg");
	});
});
