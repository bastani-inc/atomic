import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { parseArgs } from "../src/cli/args.js";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { RESUME_CATALOG_TIMEOUT_MS } from "../src/core/resume/not-found.ts";
import { sessionResumeOptions } from "../src/core/resume/session-resume.ts";
import type { CreateAgentSessionOptions } from "../src/core/sdk-types.ts";
import { getMissingStoredSessionCwdIssue } from "../src/core/session-cwd.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { resolveSessionStore } from "../src/core/session-storage.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	StorageAdapterLoadError,
	StorageConfigError,
	StorageTransientError,
	StorageUnavailableError,
} from "../src/core/storage/errors.js";
import { resolveAdapterOptions, type StorageSelection } from "../src/core/storage/provider.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import type { SessionStore } from "../src/core/storage/session/types.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import {
	type GitUnavailableError,
	isGitUnavailableError,
	isResumeCatalogTimeoutError,
	isResumeCatalogUnavailableError,
	isResumePreconditionError,
	isResumeSetupHookError,
	isRetryableResumeError,
	type ResumePreflightIo,
	resolveWorkspace,
	setWorktreeSnapshotGit,
	workspace,
} from "../src/index.ts";
import {
	cliSessionStorageSelection,
	closeStoreAfter,
	openCliSession,
	startupResumeDiagnostics,
} from "../src/main-session.ts";
import { appendLineCommand, nodeCommand, shellPath } from "./helpers/hook-commands.ts";

useTemporaryAgentDir();

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

class CountingIo implements ResumePreflightIo {
	readonly calls: string[] = [];
	missing = false;
	async loadAdapter(module: string): Promise<void> {
		this.calls.push(`load:${module}`);
		if (this.missing) throw new StorageAdapterLoadError(module, new Error("Cannot find module"));
	}
	async readText(path: string): Promise<string> {
		this.calls.push(`read:${path}`);
		return "token";
	}
	env(name: string): string | undefined {
		this.calls.push(`env:${name}`);
		return undefined;
	}
	async probeGit(): Promise<GitUnavailableError | undefined> {
		this.calls.push("git");
		return undefined;
	}
}

const sqliteSelection = (name: string): StorageSelection => ({ kind: "sqlite", path: sandbox.path(`${name}.sqlite`) });

async function storeFor(selection: StorageSelection): Promise<SessionStore> {
	const store = await resolveSessionStore(sandbox.root, { agentDir: sandbox.path("agent"), sessionStore: selection });
	cleanups.push(() => store.close());
	return store;
}

/** A session recorded "on node A" in `selection` whose last turn snapshotted its checkout. */
async function recordSessionWithSnapshot(
	selection: StorageSelection,
	files: Record<string, string> = {},
	executable: readonly string[] = [],
) {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", ...files });
	for (const file of executable) {
		chmodSync(join(clone, file), 0o755);
		await sandbox.git(clone, "update-index", "--chmod=+x", file);
	}
	if (executable.length > 0) {
		await sandbox.commitAll(clone, "make hooks executable");
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
	}
	sandbox.write(join(clone, "README.md"), "edited on node A\n");
	const store = await storeFor(selection);
	const manager = await SessionManager.create(store, clone);
	await manager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
	const capture = await captureWorktreeSnapshot(clone, {
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		blobs: store.snapshotBlobs,
	});
	if (capture.status !== "captured") throw new Error(capture.status);
	await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	return { clone, sessionId: manager.getSessionId() };
}

/** A session recorded "on node A" in `selection`, whose checkout then disappears from this machine. */
async function sessionRecordedElsewhere(
	selection: StorageSelection,
	files: Record<string, string> = {},
	executable: readonly string[] = [],
) {
	const recorded = await recordSessionWithSnapshot(selection, files, executable);
	renameSync(recorded.clone, sandbox.path("node-a-offline"));
	return recorded;
}

const settings = (setupCommand?: string) =>
	SettingsManager.inMemory(setupCommand === undefined ? {} : { resume: { setupCommand } });

/** The text `session`'s own read tool returns for `path`. */
async function readWithTools(session: AgentSession, path: string): Promise<string> {
	const read = session.agent.state.tools.find((tool) => tool.name === "read");
	assert.ok(read);
	const result = await read.execute("read-recorded-path", { path });
	return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

describe("openCliSession (#4329)", () => {
	test("a new session runs no resume preflight and prepares nothing", async () => {
		const io = new CountingIo();
		const opened = await openCliSession(parseArgs([]), sandbox.root, settings(), {
			agentDir: sandbox.path("agent"),
			sessionStorage: { kind: "adapter", module: "@acme/not-installed" } as StorageSelection,
			trusted: () => false,
			io,
		}).catch((error: unknown) => error);
		assert.deepEqual(io.calls, []);
		assert.equal(isResumePreconditionError(opened), false);
	});

	for (const flags of [["--continue"], ["--session", "abc"], ["--resume"]]) {
		test(`${flags[0]} fails before opening storage when its adapter is not installed`, async () => {
			const io = new CountingIo();
			io.missing = true;
			await assert.rejects(
				openCliSession(parseArgs(flags), sandbox.root, settings(), {
					agentDir: sandbox.path("agent"),
					sessionStorage: { kind: "adapter", module: "@acme/not-installed" },
					trusted: () => false,
					io,
				}),
				(error: unknown) => {
					assert.ok(isResumePreconditionError(error));
					assert.equal(error.entryPoint, "cli");
					assert.deepEqual(
						error.problems.map((problem) => problem.code),
						["adapter-not-installed"],
					);
					assert.match(error.problems[0]!.why, /^this node's sessions storage selects it/);
					return true;
				},
			);
			assert.deepEqual(io.calls, ["load:@acme/not-installed"]);
		});
	}

	test("a resume whose storage cannot be opened fails with that storage error, not a retryable lookup failure", async () => {
		sandbox.write(sandbox.path("not-a-directory"), "file");
		const unreachable: StorageSelection = { kind: "sqlite", path: sandbox.path("not-a-directory", "s.sqlite") };
		const options = { agentDir: sandbox.path("agent"), sessionStorage: unreachable, trusted: () => false };
		await assert.rejects(
			openCliSession(parseArgs(["--session", "abc"]), sandbox.root, settings(), options),
			(error) => {
				assert.ok(error instanceof StorageUnavailableError, String(error));
				assert.equal(isResumeCatalogUnavailableError(error), false);
				assert.equal(error.adapter, "node-sqlite");
				return true;
			},
		);
		await assert.rejects(openCliSession(parseArgs(["--continue"]), sandbox.root, settings(), options), (error) => {
			assert.ok(error instanceof StorageUnavailableError, String(error));
			assert.equal(isResumeCatalogUnavailableError(error), false);
			return true;
		});
		await assert.rejects(openCliSession(parseArgs([]), sandbox.root, settings(), options), (error) => {
			assert.equal(isResumeCatalogUnavailableError(error), false);
			return true;
		});
	});

	test("--session for a session recorded on another node restores its checkout and runs the configured setup", async () => {
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await sessionRecordedElsewhere(selection, { "package-lock.json": "{}\n" });
		const marker = sandbox.path("setup-ran");
		const io = new CountingIo();
		const opened = await openCliSession(
			parseArgs(["--session", sessionId]),
			sandbox.root,
			settings(appendLineCommand(marker, "ran")),
			{
				agentDir: sandbox.path("agent"),
				sessionStorage: selection,
				trusted: () => false,
				io,
			},
		);
		assert.notEqual(opened, "cancelled");
		if (opened === "cancelled") return;
		cleanups.push(() => opened.sessionManager.getSessionStore().close());
		const cwd = opened.sessionManager.getCwd();
		assert.notEqual(cwd, clone);
		assert.ok(cwd.startsWith(join(sandbox.path("agent"), "worktree-snapshots", "worktrees")), cwd);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node A\n");
		assert.equal(readFileSync(marker, "utf8"), "ran\n");
		assert.match(opened.notices[0]!.message, /^Restored worktree snapshot/);
		assert.deepEqual(io.calls, ["git"]);
	});

	test("the user can cancel at the dirty-checkout prompt", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(selection);
		const checkout = sandbox.path("node-b-checkout");
		renameSync(sandbox.path("node-a-offline"), checkout);
		sandbox.write(join(checkout, "README.md"), "user edit\n");
		const opened = await openCliSession(parseArgs(["--session", sessionId]), checkout, settings(), {
			agentDir: sandbox.path("agent"),
			sessionStorage: selection,
			trusted: () => false,
			chooseDirtyCheckout: async () => "cancel",
		});
		assert.equal(opened, "cancelled");
	});
});

describe("openCliSession edge cases (#4329)", () => {
	test("a resume from a store instance needs no storage preflight", async () => {
		const store = await storeFor(sqliteSelection("instance"));
		const io = new CountingIo();
		const opened = await openCliSession(parseArgs(["--continue"]), sandbox.root, settings(), {
			agentDir: sandbox.path("agent"),
			sessionStorage: store,
			trusted: () => false,
			io,
		});
		assert.notEqual(opened, "cancelled");
		assert.deepEqual(io.calls, []);
	});

	test("a restore that needs a setup hook nobody configured fails as a CLI precondition", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(selection, { "package-lock.json": "{}\n" });
		await assert.rejects(
			openCliSession(parseArgs(["--session", sessionId]), sandbox.root, settings(), {
				agentDir: sandbox.path("agent"),
				sessionStorage: selection,
				trusted: () => false,
			}),
			(error: unknown) => {
				assert.ok(isResumePreconditionError(error));
				assert.equal(error.entryPoint, "cli");
				assert.equal(error.problems[0]?.code, "setup-hook-missing");
				return true;
			},
		);
	});

	test("a resume that fails or is cancelled closes the store it opened, and a close failure never hides the resume failure", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(selection, { "package-lock.json": "{}\n" });
		const checkout = sandbox.path("node-b-checkout");
		renameSync(sandbox.path("node-a-offline"), checkout);
		sandbox.write(join(checkout, "README.md"), "user edit\n");
		const resume = (cwd: string) =>
			openCliSession(parseArgs(["--session", sessionId]), cwd, settings(), {
				agentDir: sandbox.path("agent"),
				sessionStorage: selection,
				trusted: () => false,
				chooseDirtyCheckout: async () => "cancel",
			});
		const close = vi.spyOn(SqlSessionStore.prototype, "close");
		cleanups.push(() => close.mockRestore());

		await assert.rejects(resume(sandbox.root), (error: unknown) => isResumePreconditionError(error));
		assert.equal(close.mock.calls.length, 1);
		assert.equal(await resume(checkout), "cancelled");
		assert.equal(close.mock.calls.length, 2);

		const diskGone = new Error("disk gone");
		close.mockRejectedValue(diskGone);
		await assert.rejects(resume(sandbox.root), (error: unknown) => {
			assert.ok(isResumePreconditionError(error));
			assert.equal((error as Error & { cleanupCause?: unknown }).cleanupCause, diskGone);
			assert.equal(Object.keys(error).includes("cleanupCause"), false);
			return true;
		});
		await assert.rejects(resume(checkout), (error: unknown) => error === diskGone);
	});

	test("a resume that fails leaves a store the caller supplied open", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(selection, { "package-lock.json": "{}\n" });
		const store = await storeFor(selection);
		const close = vi.spyOn(store, "close");
		cleanups.push(() => close.mockRestore());
		await assert.rejects(
			openCliSession(parseArgs(["--session", sessionId]), sandbox.root, settings(), {
				agentDir: sandbox.path("agent"),
				sessionStorage: store,
				trusted: () => false,
			}),
			(error: unknown) => isResumePreconditionError(error),
		);
		assert.equal(close.mock.calls.length, 0);
	});

	test("closing after a failure that is not an Error keeps that failure and drops the close failure", async () => {
		const store = { close: async () => Promise.reject(new Error("disk gone")) };
		await closeStoreAfter(store, "stopped");
		await assert.rejects(closeStoreAfter(store), /disk gone/);
		await closeStoreAfter({ close: async () => {} });
	});
});

describe("resume helpers (#4329)", () => {
	test("only print-like modes report resume notices with the startup diagnostics", () => {
		const notices = [{ type: "info" as const, message: "Restored worktree snapshot 0123456789ab of /a into /b" }];
		assert.deepEqual(startupResumeDiagnostics("interactive", notices), []);
		for (const mode of ["print", "json", "rpc"] as const)
			assert.equal(startupResumeDiagnostics(mode, notices), notices);
	});

	test("sessionResumeOptions reads snapshot settings and the setup command", () => {
		const trusted = (worktree: string) => worktree === "/trusted";
		const options = sessionResumeOptions(
			"switch-session",
			"/launch",
			"/home/u/.atomic/agent",
			settings(" npm ci "),
			trusted,
		);
		assert.equal(options.storeDir, join("/home/u/.atomic/agent", "worktree-snapshots"));
		assert.equal(options.entryPoint, "switch-session");
		assert.equal(options.launchCwd, "/launch");
		assert.deepEqual(options.settings, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS);
		assert.equal(options.setup.command, "npm ci");
		assert.equal(options.setup.trusted, trusted);
		assert.equal(settings("   ").getResumeSetupCommand(), undefined);
		assert.equal(SettingsManager.inMemory({ resume: {} }).getResumeSetupCommand(), undefined);
		assert.equal(settings().getResumeSetupCommand(), undefined);
	});

	test("cliSessionStorageSelection is the selection the CLI opens, or undefined for a store instance", async () => {
		const selection = sqliteSelection("x");
		assert.deepEqual(cliSessionStorageSelection(parseArgs([]), sandbox.root, settings(), selection), selection);
		const store = await storeFor(sqliteSelection("y"));
		assert.equal(cliSessionStorageSelection(parseArgs([]), sandbox.root, settings(), store), undefined);
		assert.deepEqual(cliSessionStorageSelection(parseArgs(["--no-session"]), sandbox.root, settings()), {
			kind: "memory",
		});
	});

	test("a stored session whose recorded cwd is missing here is reported; new, file and memory sessions are not", async () => {
		const stored = await SessionManager.create(await storeFor(sqliteSelection("s")), sandbox.path("gone"));
		assert.equal(getMissingStoredSessionCwdIssue(stored, sandbox.root), undefined);
		await stored.appendMessage({ role: "user", content: "x", timestamp: Date.now() });
		assert.deepEqual(getMissingStoredSessionCwdIssue(stored, sandbox.root), {
			sessionCwd: sandbox.path("gone"),
			fallbackCwd: sandbox.root,
		});
		mkdirSync(sandbox.path("gone"));
		assert.equal(getMissingStoredSessionCwdIssue(stored, sandbox.root), undefined);
		const memory = SessionManager.inMemory(sandbox.path("missing"));
		await memory.appendMessage({ role: "user", content: "x", timestamp: Date.now() });
		assert.equal(getMissingStoredSessionCwdIssue(memory, sandbox.root), undefined);
		const withFile = {
			getSessionFile: () => "/s.jsonl",
			getCwd: () => sandbox.path("missing"),
			isPersisted: () => true,
			getEntries: () => [{}],
		};
		assert.equal(getMissingStoredSessionCwdIssue(withFile, sandbox.root), undefined);
		const noCwd = {
			getSessionFile: () => undefined,
			getCwd: () => "",
			isPersisted: () => true,
			getEntries: () => [{}],
		};
		assert.equal(getMissingStoredSessionCwdIssue(noCwd, sandbox.root), undefined);
	});

	test("a relative token file in an adapter selection resolves against Atomic home", async () => {
		const agentDir = sandbox.path("home", "agent");
		sandbox.write(sandbox.path("home", "team-token"), "secret\n");
		const options = await resolveAdapterOptions(
			{ kind: "adapter", module: "x", secrets: { authToken: { file: "team-token" } } },
			{ agentDir, domain: "sessions" },
		);
		assert.equal(options.authToken, "secret");
	});
});

describe("AgentSessionRuntime.switchSession across nodes (#4329)", () => {
	async function runtimeOn(agentDir: string, settingsJson: object) {
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
		const initial = await SessionManager.create(store, sandbox.root);
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: sandbox.root,
			agentDir,
			sessionManager: initial,
		});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
		});
		return { runtime, createRuntime };
	}

	test("/resume of a session recorded on another node continues in a restored worktree after its setup hook", async () => {
		const agentDir = sandbox.path("agent");
		const marker = sandbox.path("setup-ran");
		const { clone, sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"), {
			"package-lock.json": "{}\n",
		});
		const { runtime, createRuntime } = await runtimeOn(agentDir, {
			resume: { setupCommand: appendLineCommand(marker, "ran") },
		});

		assert.deepEqual(await runtime.switchSession(sessionId), { cancelled: false });
		const cwd = runtime.session.sessionManager.getCwd();
		assert.notEqual(cwd, clone);
		assert.ok(cwd.startsWith(join(agentDir, "worktree-snapshots")), cwd);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node A\n");
		assert.equal(readFileSync(marker, "utf8"), "ran\n");
		assert.equal(existsSync(clone), false);

		assert.match(await readWithTools(runtime.session, join(clone, "README.md")), /edited on node A/);
		const reopened = await createRuntime({ cwd, agentDir, sessionManager: runtime.session.sessionManager });
		cleanups.push(() => reopened.session.dispose());
		assert.match(await readWithTools(reopened.session, join(clone, "README.md")), /edited on node A/);
	});

	test("a trusted repository's .atomic/setup runs when the default trust is always", async () => {
		const agentDir = sandbox.path("agent");
		const { sessionId } = await sessionRecordedElsewhere(
			sqliteSelection("shared"),
			{
				"package-lock.json": "{}\n",
				".atomic/setup": "#!/bin/sh\necho hook > ../hook-ran\n",
			},
			[".atomic/setup"],
		);
		const { runtime } = await runtimeOn(agentDir, { defaultProjectTrust: "always" });
		assert.deepEqual(await runtime.switchSession(sessionId), { cancelled: false });
		const cwd = runtime.session.sessionManager.getCwd();
		assert.equal(readFileSync(join(cwd, "..", "hook-ran"), "utf8"), "hook\n");
	});

	test("an untrusted repository's .atomic/setup never runs; the configured command does", async () => {
		const agentDir = sandbox.path("agent");
		const marker = sandbox.path("command-ran");
		const { sessionId } = await sessionRecordedElsewhere(
			sqliteSelection("shared"),
			{
				"package-lock.json": "{}\n",
				".atomic/setup": "#!/bin/sh\necho hook > ../hook-ran\n",
			},
			[".atomic/setup"],
		);
		const { runtime } = await runtimeOn(agentDir, { resume: { setupCommand: appendLineCommand(marker, "ran") } });
		assert.deepEqual(await runtime.switchSession(sessionId), { cancelled: false });
		const cwd = runtime.session.sessionManager.getCwd();
		assert.equal(existsSync(join(cwd, "..", "hook-ran")), false);
		assert.equal(readFileSync(marker, "utf8"), "ran\n");
	});

	/** Makes the runtime's store look like `adapter` and delays each session load by `delayMs` of timer time. */
	function slowStore(runtime: AgentSessionRuntime, adapter: string, delayMs: number): SessionStore {
		const store = runtime.session.sessionManager.getSessionStore();
		const descriptor = { ...store.descriptor, adapter };
		Object.defineProperty(store, "descriptor", { value: descriptor, configurable: true });
		const load = store.load.bind(store);
		store.load = (id) =>
			new Promise((resolveLoad, rejectLoad) => setTimeout(() => load(id).then(resolveLoad, rejectLoad), delayMs));
		return store;
	}

	test("a /resume whose shared storage does not answer fails retryable at the lookup deadline and keeps the session", async () => {
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(sandbox.path("agent"), {});
		const before = runtime.session.sessionId;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			slowStore(runtime, "libsql", RESUME_CATALOG_TIMEOUT_MS * 2);
			const pending = runtime.switchSession(sessionId).then(
				() => undefined,
				(error: unknown) => error,
			);
			await vi.advanceTimersByTimeAsync(RESUME_CATALOG_TIMEOUT_MS);
			const error = await pending;
			assert.ok(isResumeCatalogTimeoutError(error), String(error));
			assert.deepEqual(
				[error.subject, error.id, error.storage, error.timeoutMs, error.retryable],
				["session", sessionId, "libsql", RESUME_CATALOG_TIMEOUT_MS, true],
			);
		} finally {
			vi.useRealTimers();
		}
		assert.equal(runtime.session.sessionId, before);
	});

	test("a /resume from storage only this node reads sets no lookup deadline", async () => {
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(sandbox.path("agent"), { resume: { setupCommand: "true" } });
		const store = runtime.session.sessionManager.getSessionStore();
		assert.equal(store.descriptor.adapter, "node-sqlite");
		const load = store.load.bind(store);
		let release!: () => void;
		let loading!: () => void;
		const released = new Promise<void>((resolveRelease) => {
			release = resolveRelease;
		});
		const loadStarted = new Promise<void>((resolveLoading) => {
			loading = resolveLoading;
		});
		store.load = async (id) => {
			loading();
			await released;
			return load(id);
		};
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let switched: Promise<{ cancelled: boolean }>;
		try {
			switched = runtime.switchSession(sessionId);
			await loadStarted;
			assert.equal(vi.getTimerCount(), 0, "no deadline waits on the lookup");
		} finally {
			vi.useRealTimers();
		}
		release();
		assert.deepEqual(await switched, { cancelled: false });
		assert.equal(runtime.session.sessionId, sessionId);
	});

	test("a /resume whose shared storage cannot be reached fails as a retryable lookup error for the session", async () => {
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(sandbox.path("agent"), {});
		const store = runtime.session.sessionManager.getSessionStore();
		Object.defineProperty(store, "descriptor", {
			value: { ...store.descriptor, adapter: "libsql" },
			configurable: true,
		});
		const unreachable = new StorageTransientError(
			{ adapter: "libsql", location: "remote" },
			{ code: "connection-lost", outcome: "not-applied", attempts: 1 },
			new Error("ECONNRESET"),
		);
		store.load = async () => Promise.reject(unreachable);
		await assert.rejects(runtime.switchSession(sessionId), (error: unknown) => {
			assert.ok(isResumeCatalogUnavailableError(error), String(error));
			assert.deepEqual(
				[error.subject, error.id, error.retryable, error.cause],
				["session", sessionId, true, unreachable],
			);
			return true;
		});
	});

	test("rehydrating a session released on another node restores its checkout before it continues", async () => {
		const agentDir = sandbox.path("agent");
		const { clone, sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(agentDir, { resume: { setupCommand: "true" } });
		const woken = await runtime.rehydrate(sessionId);
		const cwd = woken.sessionManager.getCwd();
		assert.ok(cwd.startsWith(join(agentDir, "worktree-snapshots")), cwd);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node A\n");
		assert.deepEqual(
			woken.sessionManager.getWorktreeRootMappings().map((mapping) => mapping.from),
			[clone],
		);
		assert.match(await readWithTools(woken, join(clone, "README.md")), /edited on node A/);
	});

	test("rehydrating a session whose checkout is here and matches starts it there without restoring anything", async () => {
		const agentDir = sandbox.path("agent");
		const { clone, sessionId } = await recordSessionWithSnapshot(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(agentDir, {});
		const woken = await runtime.rehydrate(sessionId);
		assert.equal(woken.sessionManager.getCwd(), clone);
		assert.deepEqual(woken.sessionManager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(join(agentDir, "worktree-snapshots")), false);
	});

	test("rehydrating on a node where the recorded path holds another clone continues in a restored worktree, not there", async () => {
		const agentDir = sandbox.path("agent");
		const { clone, sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("repo.git"), clone);
		sandbox.write(join(clone, "README.md"), "another tree at the same path\n");
		const { runtime } = await runtimeOn(agentDir, { resume: { setupCommand: "true" } });

		const woken = await runtime.rehydrate(sessionId);

		const cwd = woken.sessionManager.getCwd();
		assert.ok(cwd.startsWith(join(agentDir, "worktree-snapshots")), cwd);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node A\n");
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "another tree at the same path\n");
	});

	test("rehydrating a session that worked outside its checkouts restores the one that is missing here", async () => {
		const agentDir = sandbox.path("agent");
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
		sandbox.write(join(clone, "README.md"), "edited on node A\n");
		const store = await storeFor(sqliteSelection("shared"));
		const manager = await SessionManager.create(store, sandbox.root);
		await manager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
		const capture = await captureWorktreeSnapshot(clone, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			blobs: store.snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		renameSync(clone, sandbox.path("node-a-offline"));
		const { runtime } = await runtimeOn(agentDir, { resume: { setupCommand: "true" } });

		const woken = await runtime.rehydrate(manager.getSessionId());

		const [restore] = woken.sessionManager.getWorktreeRootMappings();
		assert.equal(restore?.from, clone);
		assert.equal(readFileSync(join(restore!.to, "README.md"), "utf8"), "edited on node A\n");
	});

	test("rehydrating a session in its own checkout here continues there after the checkout changed, with no setup hook", async () => {
		const agentDir = sandbox.path("agent");
		const { clone, sessionId } = await recordSessionWithSnapshot(sqliteSelection("shared"), {
			"package-lock.json": "{}\n",
		});
		sandbox.write(join(clone, "written-after-the-release.txt"), "later\n");
		const { runtime } = await runtimeOn(agentDir, {});

		const woken = await runtime.rehydrate(sessionId);

		assert.equal(woken.sessionManager.getCwd(), clone);
		assert.deepEqual(woken.sessionManager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(join(agentDir, "worktree-snapshots")), false);
	});

	/**
	 * Sessions X and Y released on this node. X worked in `repo-b`. Y worked in `repo-a`, which has a lockfile so that
	 * restoring it would need a setup hook, and edited `repo-b` after X, so `repo-b` now holds Y's edit.
	 */
	async function sessionsSharingACheckout() {
		const store = await storeFor(sqliteSelection("shared"));
		const { clone: repoA } = await sandbox.remoteWithClone("repo-a", {
			"README.md": "a\n",
			"package-lock.json": "{}\n",
		});
		const { clone: repoB } = await sandbox.remoteWithClone("repo-b", { "README.md": "b\n" });
		const record = async (cwd: string, edits: ReadonlyArray<readonly [string, string]>) => {
			const manager = await SessionManager.create(store, cwd);
			await manager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
			for (const [root, text] of edits) {
				sandbox.write(join(root, "README.md"), text);
				const capture = await captureWorktreeSnapshot(root, {
					settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
					blobs: store.snapshotBlobs,
				});
				if (capture.status !== "captured") throw new Error(capture.status);
				await manager.appendWorktreeSnapshot(root, capture.snapshot.id, capture.snapshot);
			}
			return manager.getSessionId();
		};
		const x = await record(repoB, [[repoB, "X's edit\n"]]);
		const y = await record(repoA, [
			[repoA, "Y's work in repo-a\n"],
			[repoB, "Y's edit\n"],
		]);
		return { repoA, repoB, x, y };
	}

	test("rehydrating keeps the session's own changed checkout and restores only a sibling another clone holds here; its tools follow that restore (#4329)", async () => {
		const agentDir = sandbox.path("agent");
		const { repoA, repoB, y } = await sessionsSharingACheckout();
		sandbox.write(join(repoA, "written-after-the-release.txt"), "later\n");
		renameSync(repoB, sandbox.path("repo-b-offline"));
		await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("repo-b.git"), repoB);
		sandbox.write(join(repoB, "README.md"), "this node's own work\n");
		const { runtime } = await runtimeOn(agentDir, {});

		const woken = await runtime.rehydrate(y);

		assert.equal(woken.sessionManager.getCwd(), repoA);
		const [restore, ...others] = woken.sessionManager.getWorktreeRootMappings();
		assert.deepEqual([restore?.from, others], [repoB, []]);
		assert.equal(readFileSync(join(restore!.to, "README.md"), "utf8"), "Y's edit\n");
		assert.equal(readFileSync(join(repoB, "README.md"), "utf8"), "this node's own work\n");
		assert.match(await readWithTools(woken, join(repoB, "README.md")), /Y's edit/);
		assert.match(await readWithTools(woken, join(repoA, "written-after-the-release.txt")), /later/);
	});

	test("two sessions woken in one process each resolve a checkout both recorded into their own restore (#4329)", async () => {
		const { repoB, x, y } = await sessionsSharingACheckout();
		renameSync(repoB, sandbox.path("repo-b-offline"));
		const { runtime } = await runtimeOn(sandbox.path("agent"), {});

		const wokenX = await runtime.rehydrate(x);
		const wokenY = await runtime.rehydrate(y);

		assert.match(await readWithTools(wokenX, join(repoB, "README.md")), /X's edit/);
		assert.match(await readWithTools(wokenY, join(repoB, "README.md")), /Y's edit/);
		await assert.rejects(readWithTools(runtime.session, join(repoB, "README.md")), /ENOENT|not found/i);
	});

	test("rehydrating again after a failed setup hook runs the hook again in the worktree it restored", async () => {
		const agentDir = sandbox.path("agent");
		const marker = sandbox.path("setup-runs");
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"), { "package-lock.json": "{}\n" });
		const failing = await runtimeOn(agentDir, { resume: { setupCommand: nodeCommand("process.exit(3)") } });
		await assert.rejects(failing.runtime.rehydrate(sessionId), isResumeSetupHookError);

		const { runtime } = await runtimeOn(agentDir, { resume: { setupCommand: appendLineCommand(marker, "ran") } });
		const woken = await runtime.rehydrate(sessionId);

		assert.ok(woken.sessionManager.getCwd().startsWith(join(agentDir, "worktree-snapshots")));
		assert.equal(readFileSync(marker, "utf8"), "ran\n");
	});

	/** A session that node B woke in a restored worktree, edited there and released again. */
	async function sessionEditedOnNodeB(agentDir: string) {
		const { clone, sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(agentDir, { resume: { setupCommand: "true" } });
		const onB = await runtime.rehydrate(sessionId);
		const worktree = onB.sessionManager.getCwd();
		sandbox.write(join(worktree, "README.md"), "edited on node B\n");
		const capture = await captureWorktreeSnapshot(worktree, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			blobs: onB.sessionManager.getSessionStore().snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await onB.sessionManager.appendWorktreeSnapshot(worktree, capture.snapshot.id, capture.snapshot);
		await onB.release();
		return { clone, sessionId, runtime, worktree };
	}

	test("rehydrating after a failed setup hook, with none configured now, fails as a rehydrate precondition", async () => {
		const agentDir = sandbox.path("agent");
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"), { "package-lock.json": "{}\n" });
		const failing = await runtimeOn(agentDir, { resume: { setupCommand: nodeCommand("process.exit(3)") } });
		await assert.rejects(failing.runtime.rehydrate(sessionId), isResumeSetupHookError);

		const { runtime } = await runtimeOn(agentDir, {});

		await assert.rejects(
			runtime.rehydrate(sessionId),
			(error: unknown) =>
				isResumePreconditionError(error) &&
				error.entryPoint === "rehydrate" &&
				error.problems.map((problem) => problem.code).join() === "setup-hook-missing",
		);
	});

	test("rehydrating a session in a worktree this node restored needs no Git", async () => {
		const { sessionId, runtime, worktree } = await sessionEditedOnNodeB(sandbox.path("agent"));
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));

		const woken = await runtime.rehydrate(sessionId);

		assert.equal(woken.sessionManager.getCwd(), worktree);
	});

	test("rehydrating a session again on the node that restored it continues in that worktree as it is", async () => {
		const { sessionId, runtime, worktree } = await sessionEditedOnNodeB(sandbox.path("agent"));
		sandbox.write(join(worktree, "notes.txt"), "written after the release\n");

		const woken = await runtime.rehydrate(sessionId);

		assert.equal(woken.sessionManager.getCwd(), worktree);
		assert.equal(woken.sessionManager.getWorktreeRootMappings().length, 1);
		assert.equal(readFileSync(join(worktree, "notes.txt"), "utf8"), "written after the release\n");
	});

	test("rehydrating on the first node a session that worked on in node B's worktree continues from node B's work", async () => {
		const { clone, sessionId, runtime, worktree } = await sessionEditedOnNodeB(sandbox.path("agent"));
		renameSync(worktree, sandbox.path("node-b-offline"));
		renameSync(sandbox.path("node-a-offline"), clone);

		const woken = await runtime.rehydrate(sessionId);

		const cwd = woken.sessionManager.getCwd();
		assert.notEqual(cwd, clone);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node B\n");
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "edited on node A\n");
	});

	test("rehydrating a session released on another node, on a node without Git, fails as a rehydrate precondition", async () => {
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(sandbox.path("agent"), {});
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));
		await assert.rejects(runtime.rehydrate(sessionId), (error: unknown) => {
			assert.ok(isResumePreconditionError(error));
			assert.equal(error.entryPoint, "rehydrate");
			assert.equal(error.problems[0]?.code, "git-unavailable");
			return true;
		});
		assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots")), false);
	});

	test("a rehydration whose shared storage does not answer fails at the lookup deadline", async () => {
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(sandbox.path("agent"), {});
		const store = runtime.session.sessionManager.getSessionStore();
		Object.defineProperty(store, "descriptor", {
			value: { ...store.descriptor, adapter: "libsql" },
			configurable: true,
		});
		store.readHeader = () => new Promise(() => {});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const pending = runtime.rehydrate(sessionId).then(
				() => undefined,
				(error: unknown) => error,
			);
			await vi.advanceTimersByTimeAsync(RESUME_CATALOG_TIMEOUT_MS);
			const error = await pending;
			assert.ok(isResumeCatalogTimeoutError(error), String(error));
			assert.deepEqual([error.subject, error.id], ["session", sessionId]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a /resume that needs a restore on a node without Git fails as a switch-session precondition", async () => {
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(sandbox.path("agent"), {});
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));
		await assert.rejects(runtime.switchSession(sessionId), (error: unknown) => {
			assert.ok(isResumePreconditionError(error));
			assert.equal(error.entryPoint, "switch-session");
			assert.equal(error.problems[0]?.code, "git-unavailable");
			return true;
		});
	});
});

describe("createAgentSession with a session recorded on another node (#4329)", () => {
	test("continues in a restored worktree after its setup hook", async () => {
		const agentDir = sandbox.path("agent");
		const marker = sandbox.path("setup-ran");
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await sessionRecordedElsewhere(selection, { "package-lock.json": "{}\n" });
		const store = await storeFor(selection);
		const settingsManager = settings(appendLineCommand(marker, "ran"));
		const { createAgentSession } = await import("../src/core/sdk.ts");
		const { getModel } = await import("@bastani/pi-ai/compat");
		const { session } = await createAgentSession({
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: await SessionManager.open(store, sessionId),
		});
		cleanups.push(() => session.dispose());
		const cwd = session.sessionManager.getCwd();
		assert.ok(cwd.startsWith(join(agentDir, "worktree-snapshots", "worktrees")), cwd);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node A\n");
		assert.equal(readFileSync(marker, "utf8"), "ran\n");
		assert.match(await readWithTools(session, join(clone, "README.md")), /edited on node A/);
	});

	test("fails typed before restoring when Git is missing", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(selection);
		const store = await storeFor(selection);
		const { createAgentSession } = await import("../src/core/sdk.ts");
		const { getModel } = await import("@bastani/pi-ai/compat");
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));
		await assert.rejects(
			createAgentSession({
				agentDir: sandbox.path("agent"),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager: settings(),
				sessionManager: await SessionManager.open(store, sessionId),
			}),
			(error: unknown) => {
				assert.ok(isResumePreconditionError(error));
				assert.equal(error.entryPoint, "create-agent-session");
				assert.equal(error.problems[0]?.code, "git-unavailable");
				return true;
			},
		);
	});

	const createOn = async (options: Partial<CreateAgentSessionOptions>) => {
		const { createAgentSession } = await import("../src/core/sdk.ts");
		const { getModel } = await import("@bastani/pi-ai/compat");
		const { session } = await createAgentSession({
			agentDir: sandbox.path("agent"),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			...options,
		});
		cleanups.push(() => session.dispose());
		return session;
	};

	test("a supplied session bound with workspace is not prepared: the binding decides where it runs", async () => {
		const selection = sqliteSelection("shared");
		const { clone } = await sandbox.remoteWithClone("bound", { "README.md": "bound\n" });
		const bound = await resolveWorkspace(workspace({ repo: clone, branch: "feat/bound" }));
		const sub = join(bound.worktree, "sub");
		mkdirSync(sub);
		const store = await storeFor(selection);
		const sessionManager = await SessionManager.create(store, sub);
		await sessionManager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
		const capture = await captureWorktreeSnapshot(bound.worktree, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			blobs: store.snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await sessionManager.appendWorktreeSnapshot(bound.worktree, capture.snapshot.id, capture.snapshot);
		writeFileSync(join(bound.worktree, "README.md"), "changed after the snapshot\n");
		const session = await createOn({ settingsManager: settings(), sessionManager, workspace: bound });
		assert.deepEqual(session.sessionManager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots")), false);
		assert.equal(readFileSync(join(bound.worktree, "README.md"), "utf8"), "changed after the snapshot\n");
	});

	test("a trusted repository's .atomic/setup runs for the restored worktree", async () => {
		const marker = sandbox.path("setup-ran");
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(
			selection,
			{ "package-lock.json": "{}\n", ".atomic/setup": `#!/bin/sh\necho hook >> "${shellPath(marker)}"\n` },
			[".atomic/setup"],
		);
		const store = await storeFor(selection);
		await createOn({
			settingsManager: SettingsManager.inMemory({ defaultProjectTrust: "always" }),
			sessionManager: await SessionManager.open(store, sessionId),
		});
		assert.equal(readFileSync(marker, "utf8"), "hook\n");
	});

	test("an untrusted repository's .atomic/setup never runs: with no setup command the resume stops before restoring", async () => {
		const marker = sandbox.path("setup-ran");
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(
			selection,
			{ "package-lock.json": "{}\n", ".atomic/setup": `#!/bin/sh\necho hook >> "${shellPath(marker)}"\n` },
			[".atomic/setup"],
		);
		const store = await storeFor(selection);
		await assert.rejects(
			createOn({ settingsManager: settings(), sessionManager: await SessionManager.open(store, sessionId) }),
			(error: unknown) => {
				assert.ok(isResumePreconditionError(error));
				assert.equal(error.problems[0]?.code, "setup-hook-missing");
				return true;
			},
		);
		assert.equal(existsSync(marker), false);
		assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots", "worktrees")), false);
	});

	test("an invalid storage selection fails before anything about a session recorded elsewhere is prepared", async () => {
		const marker = sandbox.path("setup-ran");
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(selection, { "package-lock.json": "{}\n" });
		const store = await storeFor(selection);
		const sessionManager = await SessionManager.open(store, sessionId);
		let gitResolutions = 0;
		const previousGit = setWorktreeSnapshotGit(async () => {
			gitResolutions++;
			return previousGit();
		});
		cleanups.push(() => {
			setWorktreeSnapshotGit(previousGit);
		});
		vi.stubEnv("ATOMIC_STORAGE", "{not json");
		cleanups.push(() => {
			vi.unstubAllEnvs();
		});
		await assert.rejects(
			createOn({ settingsManager: settings(appendLineCommand(marker, "ran")), sessionManager }),
			StorageConfigError,
		);
		await assert.rejects(
			openCliSession(parseArgs(["--session", sessionId]), sandbox.root, settings(appendLineCommand(marker, "ran")), {
				agentDir: sandbox.path("agent"),
				trusted: () => false,
			}),
			StorageConfigError,
		);
		assert.equal(gitResolutions, 0);
		assert.deepEqual(sessionManager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots")), false);
		assert.equal(existsSync(marker), false);
	});

	const countGitResolutions = () => {
		const counter = { resolutions: 0 };
		const previousGit = setWorktreeSnapshotGit(async () => {
			counter.resolutions++;
			return previousGit();
		});
		cleanups.push(() => {
			setWorktreeSnapshotGit(previousGit);
		});
		return counter;
	};

	test("a session whose checkout here still matches its snapshot starts there as recorded", async () => {
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await recordSessionWithSnapshot(selection);
		const store = await storeFor(selection);
		const session = await createOn({
			settingsManager: settings(),
			sessionManager: await SessionManager.open(store, sessionId),
		});
		assert.equal(session.sessionManager.getCwd(), clone);
		assert.deepEqual(session.sessionManager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots", "worktrees")), false);
	});

	test("a session whose recorded path holds a different tree here continues in a restored worktree, like the CLI", async () => {
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await recordSessionWithSnapshot(selection);
		sandbox.write(join(clone, "README.md"), "node B's own checkout at the same path\n");
		const store = await storeFor(selection);
		const session = await createOn({
			settingsManager: settings(),
			sessionManager: await SessionManager.open(store, sessionId),
		});
		const cwd = session.sessionManager.getCwd();
		assert.ok(cwd.startsWith(join(sandbox.path("agent"), "worktree-snapshots", "worktrees")), cwd);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node A\n");
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "node B's own checkout at the same path\n");
		assert.deepEqual(
			session.sessionManager.getWorktreeRootMappings().map((mapping) => [mapping.from, mapping.to]),
			[[clone, cwd]],
		);
	});

	test("a session whose recorded path holds a different tree fails typed with nothing written when Git is missing", async () => {
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await recordSessionWithSnapshot(selection);
		sandbox.write(join(clone, "README.md"), "node B's own checkout at the same path\n");
		const store = await storeFor(selection);
		const sessionManager = await SessionManager.open(store, sessionId);
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));
		await assert.rejects(createOn({ settingsManager: settings(), sessionManager }), (error: unknown) => {
			assert.ok(isGitUnavailableError(error));
			assert.equal(error.code, "not-installed");
			return true;
		});
		assert.deepEqual(sessionManager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots")), false);
	});

	test("the host's snapshots option decides whether a supplied session's checkout changed, and can turn preparation off", async () => {
		const selection = sqliteSelection("shared");
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
		sandbox.write(join(clone, "notes.txt"), "untracked and not recorded\n");
		const store = await storeFor(selection);
		const manager = await SessionManager.create(store, clone);
		await manager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
		const capture = await captureWorktreeSnapshot(clone, {
			settings: { ...DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, includeUntracked: false },
			blobs: store.snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		const sessionId = manager.getSessionId();

		const untrackedLeftOut = await createOn({
			settingsManager: settings(),
			snapshots: { includeUntracked: false },
			sessionManager: await SessionManager.open(store, sessionId),
		});
		assert.equal(untrackedLeftOut.sessionManager.getCwd(), clone);
		assert.deepEqual(untrackedLeftOut.sessionManager.getWorktreeRootMappings(), []);

		sandbox.write(join(clone, "README.md"), "changed after the snapshot\n");
		const git = countGitResolutions();
		const disabled = await createOn({
			settingsManager: settings(),
			snapshots: { enabled: false },
			sessionManager: await SessionManager.open(store, sessionId),
		});
		assert.equal(git.resolutions, 0);
		assert.equal(disabled.sessionManager.getCwd(), clone);
		assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots")), false);
	});

	test("a supplied session without snapshots, or with an explicit cwd, costs no Git call", async () => {
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await recordSessionWithSnapshot(selection);
		sandbox.write(join(clone, "README.md"), "node B's own checkout at the same path\n");
		const store = await storeFor(selection);
		const plain = await SessionManager.create(store, clone);
		await plain.appendMessage({ role: "user", content: "no tool ran", timestamp: Date.now() });
		const git = countGitResolutions();

		const withoutSnapshots = await createOn({ settingsManager: settings(), sessionManager: plain });
		const explicitCwd = await createOn({
			cwd: clone,
			settingsManager: settings(),
			sessionManager: await SessionManager.open(store, sessionId),
		});

		assert.equal(git.resolutions, 0);
		assert.equal(withoutSnapshots.sessionManager.getCwd(), clone);
		assert.equal(explicitCwd.sessionManager.getCwd(), clone);
		assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots")), false);
	});

	test("an explicit cwd keeps a session recorded elsewhere as supplied, and no session starts in process.cwd()", async () => {
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await sessionRecordedElsewhere(selection);
		const store = await storeFor(selection);
		const explicit = await createOn({
			cwd: sandbox.root,
			settingsManager: settings(),
			sessionManager: await SessionManager.open(store, sessionId),
		});
		assert.equal(explicit.sessionManager.getCwd(), clone);
		assert.equal((explicit as unknown as { _cwd: string })._cwd, sandbox.root);
		assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots")), false);
		const fresh = await createOn({ settingsManager: settings() });
		assert.equal((fresh as unknown as { _cwd: string })._cwd, process.cwd());
	});
});

describe("bounded catalog lookups (#4329)", () => {
	test("the deadline passes results and failures through and times out typed and retryable", async () => {
		const { withResumeLookupDeadline } = await import("../src/core/resume/not-found.ts");
		const target = { subject: "session" as const, id: "abc", storage: "libsql" };
		assert.equal(await withResumeLookupDeadline(Promise.resolve(7), target, 1000), 7);
		await assert.rejects(withResumeLookupDeadline(Promise.reject(new TypeError("x")), target, 1000), TypeError);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		try {
			const pending = withResumeLookupDeadline(new Promise(() => {}), target, 40).then(
				() => assert.fail("the lookup never answers"),
				(error: unknown) => error,
			);
			await vi.advanceTimersByTimeAsync(39);
			assert.equal(vi.getTimerCount(), 1);
			await vi.advanceTimersByTimeAsync(1);
			const error = await pending;
			assert.ok(isResumeCatalogTimeoutError(error));
			assert.deepEqual(
				[error.code, error.retryable, error.phase, error.timeoutMs, error.elapsedMs, error.id, error.storage],
				["catalog-timeout", true, "catalog-lookup", 40, 40, "abc", "libsql"],
			);
			assert.ok(isRetryableResumeError(error));
			assert.match(
				error.message,
				/^Cannot look up the session abc: the storage \(libsql\) did not answer within 40 ms/,
			);
			await withResumeLookupDeadline(Promise.resolve(1), target, 1000);
			assert.equal(vi.getTimerCount(), 0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a resume whose shared storage never answers fails within the deadline, before the session lookup", async () => {
		const adapter = sandbox.path("hanging-adapter.mjs");
		sandbox.write(
			adapter,
			`export const atomicStorageAdapter = 1;
export async function openSessionStore() {
	globalThis.__atomicHangingReads = (globalThis.__atomicHangingReads ?? []);
	return {
		descriptor: { adapter: "hanging", location: "nowhere" },
		readHeader(id) { globalThis.__atomicHangingReads.push(id); return new Promise(() => {}); },
		async close() {},
	};
}
`,
		);
		const io = new CountingIo();
		await assert.rejects(
			openCliSession(parseArgs(["--session", "abc"]), sandbox.root, settings(), {
				agentDir: sandbox.path("agent"),
				sessionStorage: { kind: "adapter", module: adapter },
				trusted: () => false,
				io,
				catalogTimeoutMs: 100,
			}),
			(error: unknown) => {
				assert.ok(isResumeCatalogTimeoutError(error));
				assert.deepEqual([error.subject, error.id, error.timeoutMs], ["session", "abc", 100]);
				assert.equal(
					error.hint,
					"Check that this node can reach the shared storage (`atomic storage status`), then resume again; nothing was changed.",
				);
				return true;
			},
		);
		assert.deepEqual((globalThis as { __atomicHangingReads?: string[] }).__atomicHangingReads, ["abc"]);
		assert.deepEqual(io.calls, [`load:${adapter}`]);
	});

	test("a probe the storage answers with a failure is a retryable lookup error, and the probe's store is closed", async () => {
		const adapter = sandbox.path("probe-adapter.mjs");
		sandbox.write(
			adapter,
			`export const atomicStorageAdapter = 1;
export async function openSessionStore() {
	const probe = globalThis.__atomicProbe;
	return {
		descriptor: { adapter: "probe", location: "test" },
		readHeader(id) { probe.reads.push(id); return probe.read(id); },
		async close() { probe.closes += 1; },
	};
}
`,
		);
		const unavailable = new StorageTransientError(
			{ adapter: "probe", location: "test" },
			{ code: "connection-lost", outcome: "not-applied", attempts: 1 },
			new Error("ECONNRESET"),
		);
		const probe = { reads: [] as string[], closes: 0, read: async () => Promise.reject(unavailable) };
		(globalThis as { __atomicProbe?: typeof probe }).__atomicProbe = probe;
		cleanups.push(() => {
			delete (globalThis as { __atomicProbe?: typeof probe }).__atomicProbe;
		});
		const open = (args: string[]) =>
			openCliSession(parseArgs(args), sandbox.root, settings(), {
				agentDir: sandbox.path("agent"),
				sessionStorage: { kind: "adapter", module: adapter },
				trusted: () => false,
				io: new CountingIo(),
			});
		await assert.rejects(open(["--session", "abc"]), (error: unknown) => {
			assert.ok(isResumeCatalogUnavailableError(error));
			assert.deepEqual(
				[error.subject, error.id, error.storage, error.cause],
				["session", "abc", "probe", unavailable],
			);
			return true;
		});
		await assert.rejects(open(["--continue"]), (error: unknown) => {
			assert.ok(isResumeCatalogUnavailableError(error));
			assert.equal(error.id, null);
			return true;
		});
		assert.equal(probe.reads[0], "abc");
		assert.match(probe.reads[1] ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		assert.equal(probe.reads.length, 2);
		assert.equal(probe.closes, 2);
	});
});
