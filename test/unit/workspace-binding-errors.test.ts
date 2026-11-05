import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { gitInstallCommand } from "../../packages/coding-agent/src/core/workspace/errors.ts";
import {
	attachCleanupCause,
	findWorkspaceError,
	GitUnavailableError,
	isGitUnavailableError,
	isRetryableWorkspaceError,
	isWorkspaceBindingError,
	isWorkspaceConfigError,
	isWorkspaceError,
	isWorkspacePublicationError,
	isWorkspaceRestoreError,
	isWorkspaceSandboxError,
	isWorkspaceTimeoutError,
	rehydrateWorkspaceError,
	serializeWorkspaceError,
	WorkspaceBindingError,
	WorkspaceConfigError,
	WorkspaceError,
	WorkspacePublicationError,
	WorkspaceRestoreError,
	WorkspaceSandboxError,
	WorkspaceTimeoutError,
	workspace,
} from "../../packages/coding-agent/src/core/workspace/index.ts";
import { classifyRepository, isWorkspace } from "../../packages/coding-agent/src/core/workspace/spec.ts";

function thrown(body: () => unknown): unknown {
	try {
		body();
	} catch (error) {
		return error;
	}
	assert.fail("expected a throw");
}

const samples = {
	binding: () =>
		new WorkspaceBindingError({
			code: "wrong-branch",
			reason: "different-branch",
			fields: { repo: "/repos/api", worktree: "/wt/api", expected: "feat/x", actual: "main" },
		}),
	config: () =>
		new WorkspaceConfigError({
			source: "sdk",
			field: "workspace.sandbox",
			reason: "invalid-value",
			expected: '"workspace-write" or "read-only"',
			received: "an unsupported string",
		}),
	restore: () =>
		new WorkspaceRestoreError({
			reason: "branch-missing",
			fields: { repo: "/repos/api", branch: "feat/x", worktree: "/wt/api", repository: "/repos/api" },
		}),
	publication: () =>
		new WorkspacePublicationError({ reason: "gh-unavailable", fields: { repo: "/repos/api", branch: "feat/x" } }),
	timeout: () =>
		new WorkspaceTimeoutError({ phase: "clone", timeoutMs: 600_000, elapsedMs: 600_004, command: "git clone x" }),
	sandbox: () => new WorkspaceSandboxError({ tool: "write", worktree: "/wt/api" }),
};

describe("workspace error family (#3109)", () => {
	test("every error is a WorkspaceError with an explicit literal name, code, hint and JSON-safe fields (#3109)", () => {
		const expected = {
			binding: ["WorkspaceBindingError", "wrong-branch", isWorkspaceBindingError],
			config: ["WorkspaceConfigError", "invalid-setting", isWorkspaceConfigError],
			restore: ["WorkspaceRestoreError", "restore-failed", isWorkspaceRestoreError],
			publication: ["WorkspacePublicationError", "publication-failed", isWorkspacePublicationError],
			timeout: ["WorkspaceTimeoutError", "timeout", isWorkspaceTimeoutError],
			sandbox: ["WorkspaceSandboxError", "write-denied", isWorkspaceSandboxError],
		} as const;
		for (const [key, make] of Object.entries(samples)) {
			const error = make();
			const [name, code, guard] = expected[key as keyof typeof expected];
			assert.ok(error instanceof WorkspaceError);
			assert.ok(isWorkspaceError(error));
			assert.ok(guard(error));
			assert.equal(error.name, name);
			assert.equal(error.code, code);
			assert.ok(error.hint.length > 0);
			assert.ok(error.message.endsWith(error.hint), `${name} renders its hint last`);
			assert.ok(error.message.includes(`(${code})`));
			assert.deepEqual(JSON.parse(JSON.stringify(error.fields)), error.fields);
			assert.ok(Object.isFrozen(error.fields));
			assert.equal(error.retryable, key === "timeout", `${name} retryable`);
			assert.equal(error.cleanupCause, undefined);
		}
		assert.deepEqual(samples.sandbox().fields, { tool: "write", worktree: "/wt/api", sandbox: "read-only" });
		assert.equal(samples.timeout().fields.command, "git clone x");
		const restoreCleanup = new Error("rm failed");
		assert.equal(
			new WorkspaceRestoreError({ reason: "branch-missing", fields: {}, cleanupCause: restoreCleanup }).cleanupCause,
			restoreCleanup,
		);
	});

	test("guards also match structurally, across realms and processes (#3109)", () => {
		const foreign = { name: "WorkspaceBindingError", code: "wrong-repository", message: "m" };
		assert.ok(isWorkspaceBindingError(foreign));
		assert.ok(isWorkspaceError(foreign));
		assert.equal(isWorkspaceRestoreError(foreign), false);
		assert.ok(isWorkspaceConfigError({ name: "WorkspaceConfigError", code: "invalid-setting" }));
		assert.ok(isWorkspaceRestoreError({ name: "WorkspaceRestoreError", code: "restore-failed" }));
		assert.ok(isWorkspacePublicationError({ name: "WorkspacePublicationError", code: "publication-failed" }));
		assert.ok(isWorkspaceTimeoutError({ name: "WorkspaceTimeoutError", code: "timeout" }));
		assert.ok(isWorkspaceSandboxError({ name: "WorkspaceSandboxError", code: "write-denied" }));
		assert.ok(isGitUnavailableError({ name: "GitUnavailableError", code: "not-installed" }));
		assert.equal(isWorkspaceBindingError({ name: "WorkspaceBindingError" }), false, "a code is required");
		assert.equal(isWorkspaceError({ name: "SomethingElse", code: "x" }), false);
		assert.equal(isWorkspaceError(null), false);
		assert.equal(isWorkspaceError("WorkspaceBindingError"), false);
	});

	test("findWorkspaceError walks at most eight causes (#3109)", () => {
		const root = samples.binding();
		let wrapped: unknown = root;
		for (let depth = 0; depth < 7; depth++) wrapped = new Error(`wrap ${depth}`, { cause: wrapped });
		assert.equal(findWorkspaceError(wrapped), root);
		assert.equal(findWorkspaceError(wrapped, isWorkspaceBindingError), root);
		assert.equal(findWorkspaceError(wrapped, isWorkspaceRestoreError), undefined);
		assert.equal(findWorkspaceError(new Error("too deep", { cause: wrapped })), undefined);
		assert.equal(findWorkspaceError(undefined), undefined);
	});

	test("retryable is explicit: conflicts, timeouts and network git phases only (#3109)", () => {
		const conflict = new WorkspaceBindingError({ code: "writer-conflict", fields: { worktree: "/wt" } });
		const fetchFailure = new WorkspaceBindingError({ code: "git-failed", fields: { phase: "fetch" } });
		const localFailure = new WorkspaceBindingError({ code: "git-failed", fields: { phase: "validate" } });
		assert.equal(conflict.retryable, true);
		assert.equal(fetchFailure.retryable, true);
		assert.equal(localFailure.retryable, false);
		assert.equal(samples.timeout().retryable, true);
		assert.equal(samples.binding().retryable, false);
		assert.equal(new WorkspacePublicationError({ reason: "push-failed", fields: {} }).retryable, true);
		assert.equal(samples.publication().retryable, false);
		assert.equal(isRetryableWorkspaceError(new Error("outer", { cause: conflict })), true);
		assert.equal(isRetryableWorkspaceError(new Error("outer", { cause: localFailure })), false);
		assert.equal(isRetryableWorkspaceError(new Error("plain")), false);
	});

	test("a cleanup failure is attached to the primary error, never replacing it (#3109)", () => {
		const primary = samples.binding();
		const cleanup = new Error("rm failed");
		assert.equal(attachCleanupCause(primary, cleanup), primary);
		assert.equal(primary.cleanupCause, cleanup);
		const untouched = samples.restore();
		assert.equal(attachCleanupCause(untouched, undefined), untouched);
		assert.equal(untouched.cleanupCause, undefined);
		assert.equal(attachCleanupCause("not an error", cleanup), "not an error");
	});

	test("serialized errors rehydrate into the same class with fields, cause chain and message intact (#3109)", () => {
		const unavailable = new GitUnavailableError({ gitPath: "/opt/git" });
		const wrapped = new WorkspaceBindingError({
			code: "git-unavailable",
			fields: { gitPath: "/opt/git", installCommand: gitInstallCommand("linux") },
			cause: unavailable,
		});
		for (const original of [...Object.values(samples).map((make) => make()), wrapped]) {
			const wire = JSON.parse(JSON.stringify(serializeWorkspaceError(original)));
			const rehydrated = rehydrateWorkspaceError(wire);
			assert.equal(rehydrated.constructor, original.constructor);
			assert.equal(rehydrated.name, original.name);
			assert.equal(rehydrated.code, original.code);
			assert.equal(rehydrated.reason, original.reason);
			assert.equal(rehydrated.message, original.message);
			assert.equal(rehydrated.hint, original.hint);
			assert.equal(rehydrated.retryable, original.retryable);
			assert.deepEqual(rehydrated.fields, original.fields);
		}
		const rehydrated = rehydrateWorkspaceError(JSON.parse(JSON.stringify(serializeWorkspaceError(wrapped))));
		assert.ok(isWorkspaceBindingError(rehydrated));
		assert.ok(rehydrated.cause instanceof GitUnavailableError);
		assert.equal(rehydrated.cause.message, unavailable.message);
		assert.equal(rehydrated.cause.code, "not-installed");
		const offline = new GitUnavailableError({ gitPath: "git", code: "offline" });
		const offlineWire = serializeWorkspaceError(
			new WorkspaceBindingError({ code: "git-unavailable", fields: { gitPath: "git" }, cause: offline }),
		);
		assert.equal((rehydrateWorkspaceError(offlineWire).cause as GitUnavailableError).code, "offline");
		const timeout = rehydrateWorkspaceError(serializeWorkspaceError(samples.timeout()));
		assert.ok(timeout instanceof WorkspaceTimeoutError);
		assert.equal(timeout.phase, "clone");
		assert.equal(timeout.elapsedMs, 600_004);
		const config = rehydrateWorkspaceError(serializeWorkspaceError(samples.config()));
		assert.ok(config instanceof WorkspaceConfigError);
		assert.equal(config.field, "workspace.sandbox");
	});

	test("an unknown serialized name rehydrates into WorkspaceError keeping its name and code (#3109)", () => {
		const wire = {
			name: "WorkspaceFutureError",
			code: "future-code",
			message: "Something new: x (future-code). Do y.",
			hint: "Do y.",
			fields: { id: "x" },
			retryable: true,
			reason: "sub-case",
			cause: { name: "TypeError", message: "inner", cause: { name: "Error", message: "innermost" } },
		};
		const rehydrated = rehydrateWorkspaceError(wire);
		assert.equal(rehydrated.constructor, WorkspaceError);
		assert.equal(rehydrated.name, "WorkspaceFutureError");
		assert.equal(rehydrated.code, "future-code");
		assert.equal(rehydrated.reason, "sub-case");
		assert.equal(rehydrated.retryable, true);
		assert.equal(rehydrated.message, wire.message);
		assert.equal((rehydrated.cause as Error).name, "TypeError");
		assert.equal(((rehydrated.cause as Error).cause as Error).message, "innermost");
	});

	test("serialization keeps non-error causes and the sender's message (#3109)", () => {
		const wire = serializeWorkspaceError(
			new WorkspaceBindingError({ code: "git-failed", fields: { phase: "fetch" }, cause: "a string cause" }),
		);
		assert.deepEqual(JSON.parse(JSON.stringify(wire.cause)), { name: "Error", message: "a string cause" });
		const rehydrated = rehydrateWorkspaceError({ ...JSON.parse(JSON.stringify(wire)), message: "older wording" });
		assert.equal(rehydrated.message, "older wording");
		assert.equal((rehydrated.cause as Error).message, "a string cause");
		const gitless = rehydrateWorkspaceError({
			...JSON.parse(JSON.stringify(wire)),
			cause: { name: "GitUnavailableError", code: "offline", message: "offline wording" },
		});
		const cause = gitless.cause as GitUnavailableError;
		assert.ok(cause instanceof GitUnavailableError);
		assert.equal(cause.code, "offline");
		assert.equal(cause.message, "offline wording");
		assert.equal(cause.fields.gitPath, "git");
		assert.equal(cause.retryable, false);
		assert.equal(cause.platform, process.platform);
		assert.equal(cause.hint, `Install git (${gitInstallCommand()}) and make sure it is on PATH.`);
	});

	test("serialization bounds a deep cause chain (#3109)", () => {
		let cause: unknown = new Error("bottom");
		for (let depth = 0; depth < 20; depth++) cause = new Error(`level ${depth}`, { cause });
		const wire = serializeWorkspaceError(
			new WorkspaceBindingError({ code: "git-failed", fields: { phase: "clone" }, cause }),
		);
		let depth = 0;
		for (let link = wire.cause; link !== undefined; link = link.cause) depth++;
		assert.equal(depth, 7);
	});
});

describe("workspace() validates its options before any work (#3109)", () => {
	test("accepts and keeps values verbatim with documented defaults (#3109)", () => {
		const api = workspace({
			repo: "github.com/acme/product-service",
			base: "origin/main",
			branch: "feat/ticket-123",
			worktree: "auto",
			label: "ci",
		});
		assert.equal(api.kind, "workspace");
		assert.equal(api.repo, "github.com/acme/product-service");
		assert.equal(api.base, "origin/main");
		assert.equal(api.branch, "feat/ticket-123");
		assert.equal(api.worktree, "auto");
		assert.equal(api.sandbox, "workspace-write");
		assert.equal(api.label, "ci");
		assert.ok(Object.isFrozen(api));
		const reviewer = api.readOnly();
		assert.equal(reviewer.sandbox, "read-only");
		assert.equal(reviewer.repo, api.repo);
		assert.equal(reviewer.label, "ci");
		const minimal = workspace({ repo: "/srv/repo" });
		assert.deepEqual(Object.keys(minimal).sort(), ["kind", "readOnly", "repo", "sandbox"]);
		for (const repo of ["https://github.com/acme/x.git", "ssh://git@host/acme/x", "git@github.com:acme/x.git"])
			assert.equal(workspace({ repo }).repo, repo);
	});

	test("rejects malformed options with WorkspaceConfigError naming source and field (#3109)", () => {
		const cases: readonly [Record<string, unknown>, string, string, string][] = [
			[{}, "workspace.repo", "missing", "undefined"],
			[{ repo: 7 }, "workspace.repo", "invalid-type", "number"],
			[{ repo: "relative/path" }, "workspace.repo", "invalid-value", "an unsupported string"],
			[{ repo: "https://" }, "workspace.repo", "invalid-value", "an unsupported string"],
			[{ repo: "https://host/" }, "workspace.repo", "invalid-value", "an unsupported string"],
			[{ repo: "host:/" }, "workspace.repo", "invalid-value", "an unsupported string"],
			[{ repo: "/r", base: "" }, "workspace.base", "invalid-value", "an unsupported string"],
			[{ repo: "/r", branch: "a/../b" }, "workspace.branch", "invalid-value", "an unsupported string"],
			[{ repo: "/r", branch: "a//b" }, "workspace.branch", "invalid-value", "an unsupported string"],
			[{ repo: "/r", branch: "" }, "workspace.branch", "invalid-value", "an unsupported string"],
			[{ repo: "/r", branch: "./x" }, "workspace.branch", "invalid-value", "an unsupported string"],
			[{ repo: "/r", worktree: "relative" }, "workspace.worktree", "invalid-value", "an unsupported string"],
			[{ repo: "/r", sandbox: "full" }, "workspace.sandbox", "invalid-value", "an unsupported string"],
			[{ repo: "/r", label: 3 }, "workspace.label", "invalid-type", "number"],
		];
		for (const [options, field, reason, received] of cases) {
			const error = thrown(() => workspace(options as never));
			assert.ok(isWorkspaceConfigError(error), JSON.stringify(options));
			assert.equal(error.source, "sdk");
			assert.equal(error.field, field);
			assert.equal(error.reason, reason);
			assert.equal(error.fields.received, received);
			assert.equal(error.code, "invalid-setting");
		}
		for (const notObject of [null, "repo", 3]) {
			const error = thrown(() => workspace(notObject as never));
			assert.ok(isWorkspaceConfigError(error));
			assert.equal(error.field, "workspace");
			assert.equal(error.fields.expected, "an object");
		}
		assert.equal(isWorkspace(workspace({ repo: "/r" })), true);
		for (const value of [null, undefined, "workspace", { kind: "workspace" }, { kind: "other", repo: "/r" }])
			assert.equal(isWorkspace(value), false);
		assert.equal(workspace({ repo: "/r", label: "" }).label, "", "an empty label is kept verbatim");
		assert.equal(workspace({ repo: "/r", branch: "feat/a.b-c" }).branch, "feat/a.b-c");
	});
});

describe("repository classification (#3109)", () => {
	test("tells local paths from every remote form and derives host and path (#3109)", () => {
		assert.deepEqual(classifyRepository("/srv/repo"), { kind: "local", path: "/srv/repo" });
		assert.deepEqual(classifyRepository("https://github.com/acme/api.git"), {
			kind: "remote",
			url: "https://github.com/acme/api.git",
			host: "github.com",
			segments: ["acme", "api"],
		});
		assert.deepEqual(classifyRepository("ssh://git@host:2222//srv/git.git/x.git"), {
			kind: "remote",
			url: "ssh://git@host:2222//srv/git.git/x.git",
			host: "host:2222",
			segments: ["srv", "git.git", "x"],
		});
		assert.deepEqual(classifyRepository("file:///tmp/remotes/origin.git"), {
			kind: "remote",
			url: "file:///tmp/remotes/origin.git",
			host: "file",
			segments: ["tmp", "remotes", "origin"],
		});
		assert.deepEqual(classifyRepository("github.com/acme/product-service"), {
			kind: "remote",
			url: "https://github.com/acme/product-service",
			host: "github.com",
			segments: ["acme", "product-service"],
		});
		assert.deepEqual(classifyRepository("git@github.com:acme/x.GIT"), {
			kind: "remote",
			url: "git@github.com:acme/x.GIT",
			host: "github.com",
			segments: ["acme", "x"],
		});
		for (const invalid of ["relative", "https://", "https://host/", "host:/", "http://[::1"])
			assert.equal(classifyRepository(invalid), undefined, invalid);
	});
});

describe("workspace error messages (#3109)", () => {
	test("render what failed, the subject, the code and the remedy (#3109)", () => {
		assert.equal(
			samples.binding().message,
			"Workspace worktree is on the wrong branch: /wt/api is on main, expected feat/x (wrong-branch). Check out feat/x in that worktree, or pass the branch it is on.",
		);
		assert.equal(
			samples.config().message,
			'Invalid workspace option: workspace.sandbox from sdk is an unsupported string, expected "workspace-write" or "read-only" (invalid-setting). Set workspace.sandbox to "workspace-write" or "read-only".',
		);
		assert.equal(
			samples.restore().message,
			"Workspace restore failed: branch feat/x for /wt/api is gone (restore-failed). Recreate branch feat/x or push it to the remote, then resume.",
		);
		assert.equal(
			samples.publication().message,
			"Pull request publication failed: feat/x of /repos/api (gh-unavailable) (publication-failed). Install the GitHub CLI (https://cli.github.com) and run gh auth login.",
		);
		assert.equal(
			samples.timeout().message,
			"Workspace git command timed out: git clone x ran 600004ms during clone, limit 600000ms (timeout). Check network access to the remote, then retry.",
		);
		assert.equal(
			samples.sandbox().message,
			"Write denied in a read-only workspace: write cannot change /wt/api (write-denied). This stage is a read-only reviewer; report the change instead of making it.",
		);
		assert.equal(
			new GitUnavailableError({ gitPath: "git" }).message,
			`Git is unavailable: git could not be started (not-installed). Install git (${gitInstallCommand()}) and make sure it is on PATH.`,
		);
	});

	test("name the platform's install command for a missing git (#3109)", () => {
		assert.equal(gitInstallCommand("darwin"), "xcode-select --install");
		assert.equal(gitInstallCommand("win32"), "winget install --id Git.Git -e");
		assert.match(gitInstallCommand("linux"), /apt-get install git/);
	});

	test("describe every code and reason from its fields (#3109)", () => {
		const fields = {
			repo: "/r",
			worktree: "/w",
			expected: "E",
			actual: "A",
			input: "git_worktree_dir",
			base: "origin/x",
			cwd: "/elsewhere",
			gitPath: "git",
			installCommand: "install-git",
			command: "git fetch",
			status: 128,
			phase: "fetch",
			branch: "b",
			holder: "run/stage",
			holderPid: 42,
			holderHost: "host",
			lockFile: "/w/.git/lease",
		};
		const binding: [string, string | null, string][] = [
			[
				"wrong-repository",
				"different-repository",
				'Workspace worktree belongs to another repository: /w uses A, expected E (wrong-repository). Pass a worktree of /r, or use worktree: "auto".',
			],
			[
				"wrong-repository",
				"not-a-worktree",
				'Workspace worktree belongs to another repository: /w is not a git worktree (wrong-repository). Pass a worktree of /r, or use worktree: "auto".',
			],
			[
				"wrong-repository",
				"not-a-worktree-root",
				'Workspace worktree belongs to another repository: /w is inside the worktree A, not its root (wrong-repository). Pass a worktree of /r, or use worktree: "auto".',
			],
			[
				"wrong-branch",
				"different-branch",
				"Workspace worktree is on the wrong branch: /w is on A, expected E (wrong-branch). Check out E in that worktree, or pass the branch it is on.",
			],
			[
				"conflicting-worktree-input",
				null,
				"Workspace conflicts with a worktree input: git_worktree_dir is set together with workspace (conflicting-worktree-input). Remove git_worktree_dir; the workspace already selects the worktree.",
			],
			[
				"invalid-repository",
				"not-a-repository",
				"Workspace repository is not usable: /r is not a git repository (invalid-repository). Pass the absolute path of a git repository root, or a remote URL.",
			],
			[
				"invalid-repository",
				"not-a-repository-root",
				"Workspace repository is not usable: /r is inside the repository A, not its root (invalid-repository). Pass the repository root A.",
			],
			[
				"unknown-base",
				null,
				"Workspace base does not resolve: origin/x is not a commit in /r (unknown-base). Pass a base that exists in the repository, for example origin/main.",
			],
			[
				"cwd-outside-worktree",
				null,
				"Working directory escapes the workspace: /elsewhere is outside /w (cwd-outside-worktree). Use a cwd inside the workspace worktree, or a relative path.",
			],
			[
				"git-unavailable",
				null,
				"Git is unavailable: git could not be started, and workspaces need git to bind repositories (git-unavailable). Install git (install-git) and make sure it is on PATH.",
			],
			[
				"git-failed",
				null,
				"Workspace git command failed: git fetch exited with status 128 during fetch (git-failed). Check the repository, network access and credentials, then retry.",
			],
			[
				"drift",
				"history-rewritten",
				"Workspace changed unexpectedly: b in /w no longer contains the recorded commit E (drift). Restore the recorded repository state, or start a new run instead of resuming.",
			],
			[
				"drift",
				"remote-changed",
				"Workspace changed unexpectedly: /w no longer has the recorded remote E (drift). Restore the recorded repository state, or start a new run instead of resuming.",
			],
			[
				"writer-conflict",
				null,
				"Workspace already has a writer: /w is held by run/stage (pid 42 on host) (writer-conflict). Wait for that writer to finish, use a read-only workspace, or remove /w/.git/lease if its process is gone.",
			],
		];
		for (const [code, reason, rendered] of binding) {
			const error = new WorkspaceBindingError({
				code: code as never,
				reason: (reason ?? undefined) as never,
				fields,
			});
			assert.equal(error.message, rendered);
			assert.ok(rendered.endsWith(error.hint));
		}
		const restoreFields = { repo: "/r", branch: "b", worktree: "/w", repository: "/r" };
		assert.equal(
			new WorkspaceRestoreError({ reason: "repository-missing", fields: restoreFields }).message,
			"Workspace restore failed: repository /r is gone (restore-failed). Restore the repository at /r, or start a new run.",
		);
		const publication: [string, string][] = [
			["no-remote", "Add an origin remote to the repository before publishing."],
			["push-failed", "Check push access to the remote, then retry."],
			["gh-unavailable", "Install the GitHub CLI (https://cli.github.com) and run gh auth login."],
			["gh-unauthenticated", "Run gh auth login, or set GH_TOKEN, then retry."],
			["gh-failed", "Check gh auth status and the repository on GitHub, then retry."],
		];
		for (const [reason, hint] of publication)
			assert.equal(
				new WorkspacePublicationError({ reason: reason as never, fields: { repo: "/r", branch: "b" } }).message,
				`Pull request publication failed: b of /r (${reason}) (publication-failed). ${hint}`,
			);
		const missing = new WorkspaceConfigError({
			source: "env",
			field: "workspace.repo",
			reason: "missing",
			expected: "a path",
			received: "undefined",
		});
		assert.equal(
			missing.message,
			"Invalid workspace option: workspace.repo from env is missing (invalid-setting). Set workspace.repo to a path.",
		);
		assert.deepEqual(missing.fields, {
			source: "env",
			field: "workspace.repo",
			expected: "a path",
			received: "undefined",
		});
	});
});
