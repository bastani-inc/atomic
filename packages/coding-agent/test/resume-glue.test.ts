import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { getBinDir } from "../src/config.ts";
import { STORAGE_JOIN_COMMAND } from "../src/core/agent-rehydrate-errors.ts";
import { clearWorktreeRootMappings } from "../src/core/resume/path-mapping.ts";
import { StorageAdapterLoadError, StorageTransientError, StorageUnavailableError } from "../src/core/storage/errors.js";
import type { StorageSelection } from "../src/core/storage/provider.js";
import { inMemorySecret, LIBSQL_ADAPTER_PACKAGE } from "../src/core/storage/selection.js";
import { GitUnavailableError, isGitUnavailableError } from "../src/core/worktree-snapshot/errors.ts";
import {
	checkResumeStoragePreconditions,
	findResumeError,
	isResumeCatalogUnavailableError,
	isResumeError,
	isResumeNotFoundError,
	isResumePreconditionError,
	isResumeSetupHookError,
	isRetryableResumeError,
	mapPathForCwd,
	ResumeCatalogUnavailableError,
	ResumeError,
	ResumeNotFoundError,
	ResumePreconditionError,
	type ResumePreconditionProblem,
	type ResumePreflightIo,
	ResumeSetupHookError,
	registerWorktreeRootMappings,
	rehydrateResumeError,
	resumeLookupError,
	resumeNotFoundError,
	serializeResumeError,
	storagePreconditionProblems,
} from "../src/index.ts";
import { GitProvisionTimeoutError } from "../src/utils/git-errors.ts";

useTemporaryAgentDir();

function gitUnavailable(): GitUnavailableError {
	return new GitUnavailableError({
		code: "not-installed",
		platform: "linux",
		arch: "x64",
		installDir: "/home/u/.atomic/agent/bin/git",
		installCommand: "sudo apt-get install git",
	});
}

const PROBLEM: ResumePreconditionProblem = {
	code: "git-unavailable",
	subject: "git (git)",
	why: "the snapshot must be restored",
	fix: "Install Git with `sudo apt-get install git`, then retry.",
};

const HOOK_FIELDS = {
	hook: ".atomic/setup",
	worktree: "/w",
	envHash: "e".repeat(64),
	exitStatus: 3,
	signal: null,
	logPath: "/w.log",
	timeoutMs: 1000,
	elapsedMs: 5,
};

describe("resume error family (#4329)", () => {
	test("every concrete error is a ResumeError with its stable code and a hint embedded once in the message", () => {
		const errors: ResumeError[] = [
			new ResumeNotFoundError({ subject: "session", id: "s1", reason: "shared-miss", storage: "libsql" }),
			new ResumePreconditionError({ entryPoint: "cli", problems: [PROBLEM] }),
			new ResumeSetupHookError("setup-hook-failed", HOOK_FIELDS),
		];
		assert.deepEqual(
			errors.map((error) => [error.name, error.code, error.retryable]),
			[
				["ResumeNotFoundError", "not-found", false],
				["ResumePreconditionError", "preconditions-unmet", false],
				["ResumeSetupHookError", "setup-hook-failed", false],
			],
		);
		for (const error of errors) {
			assert.ok(error instanceof ResumeError);
			assert.ok(isResumeError(error));
			assert.ok(error.hint.length > 0);
			assert.ok(error.message.endsWith(`(${error.code}). ${error.hint}`));
		}
	});

	test("the not-found message for a local-only node names the join command", () => {
		const error = new ResumeNotFoundError({
			subject: "session",
			id: "abc",
			reason: "local-storage-not-joined",
			storage: "node-sqlite at /home/u/.atomic/workflows/journal.sqlite",
		});
		assert.equal(
			error.message,
			"No session found matching 'abc': this node uses local-only storage (node-sqlite at /home/u/.atomic/workflows/journal.sqlite) and is not joined to the shared storage where other nodes record their work (not-found). Join this node's sessions to the shared storage with `atomic storage join <url> --token-file <path>` (after `atomic team leave` on a machine joined with `atomic team join`, which keeps sessions on each machine), then resume again.",
		);
		assert.equal(
			error.hint,
			"Join this node's sessions to the shared storage with `atomic storage join <url> --token-file <path>` (after `atomic team leave` on a machine joined with `atomic team join`, which keeps sessions on each machine), then resume again.",
		);
		assert.deepEqual(error.fields, {
			subject: "session",
			id: "abc",
			reason: "local-storage-not-joined",
			storage: "node-sqlite at /home/u/.atomic/workflows/journal.sqlite",
		});
	});

	test("a shared-storage miss points at storage status, not at joining", () => {
		const error = new ResumeNotFoundError({ subject: "session", id: "s1", reason: "shared-miss", storage: "libsql" });
		assert.ok(error.message.startsWith("No session found matching 's1' in the shared storage (libsql)"));
		assert.match(error.hint, /atomic storage status/);
		assert.doesNotMatch(error.hint, /team join/);
	});

	test("a precondition error lists every problem and joins every fix in the hint", () => {
		const second: ResumePreconditionProblem = {
			code: "credential-missing",
			subject: "environment variable TEAM_TOKEN",
			why: "it is not set",
			fix: "Set TEAM_TOKEN.",
		};
		const error = new ResumePreconditionError({ entryPoint: "switch-session", problems: [PROBLEM, second] });
		assert.equal(error.entryPoint, "switch-session");
		assert.deepEqual(error.problems, [PROBLEM, second]);
		assert.equal(error.hint, `${PROBLEM.fix} Then: ${second.fix}`);
		assert.match(
			error.message,
			/git \(git\) \(git-unavailable\): the snapshot must be restored; environment variable TEAM_TOKEN \(credential-missing\): it is not set/,
		);
		assert.throws(() => new ResumePreconditionError({ entryPoint: "cli", problems: [] }), RangeError);
	});

	test("setup hook failures name the hook and how it ended", () => {
		const failed = new ResumeSetupHookError("setup-hook-failed", HOOK_FIELDS);
		assert.match(failed.message, /^The setup hook \.atomic\/setup exited with status 3 in \/w \(setup-hook-failed\)/);
		assert.match(failed.hint, /\/w\.log/);
		assert.equal(failed.phase, "setup-hook");
		const killed = new ResumeSetupHookError("setup-hook-failed", {
			...HOOK_FIELDS,
			exitStatus: null,
			signal: "SIGKILL",
		});
		assert.match(killed.message, /was stopped by SIGKILL/);
		const timedOut = new ResumeSetupHookError("setup-hook-timed-out", HOOK_FIELDS);
		assert.match(timedOut.message, /did not finish within 1000 ms/);
		assert.equal(timedOut.timeoutMs, 1000);
		assert.equal(timedOut.elapsedMs, 5);
	});

	test("guards accept structural copies from other realms and reject mismatched names or codes", () => {
		const plain = { name: "ResumeNotFoundError", code: "not-found", message: "x" };
		assert.ok(isResumeNotFoundError(plain));
		assert.ok(isResumeError(plain));
		assert.equal(isResumePreconditionError(plain), false);
		assert.equal(isResumeNotFoundError({ name: "ResumeNotFoundError", code: "preconditions-unmet" }), false);
		assert.equal(isResumeError({ name: "OtherError", code: "not-found" }), false);
		assert.equal(isResumeError({ name: "ResumeError", code: "unknown" }), false);
		assert.equal(isResumeError({ name: "ResumeNotFoundError" }), false);
		assert.equal(isResumeError({ code: "not-found" }), false);
		assert.equal(isResumeError(null), false);
		assert.equal(isResumeError("ResumeNotFoundError"), false);
		assert.ok(isResumeSetupHookError({ name: "ResumeSetupHookError", code: "setup-hook-timed-out" }));
		assert.ok(isResumePreconditionError({ name: "ResumePreconditionError", code: "preconditions-unmet" }));
	});

	test("findResumeError walks the cause chain at most eight levels below the error", () => {
		const error = new ResumeNotFoundError({ subject: "session", id: "r", reason: "shared-miss", storage: "libsql" });
		let chain: Error = error;
		for (let depth = 0; depth < 8; depth++) chain = new Error(`wrap ${depth}`, { cause: chain });
		assert.equal(findResumeError(chain), error);
		assert.equal(findResumeError(new Error("deeper", { cause: chain })), undefined);
		assert.equal(findResumeError(chain, isResumePreconditionError), undefined);
		assert.equal(findResumeError(undefined), undefined);
	});

	test("serialize and rehydrate keep class, code, hint, fields and the cause chain", () => {
		const cause = new Error("spawn ENOENT");
		const originals: ResumeError[] = [
			new ResumeNotFoundError(
				{ subject: "session", id: "r", reason: "local-storage-not-joined", storage: "memory at :memory:" },
				cause,
			),
			new ResumePreconditionError({ entryPoint: "switch-session", problems: [PROBLEM] }),
			new ResumeSetupHookError("setup-hook-timed-out", HOOK_FIELDS),
		];
		for (const original of originals) {
			const copy = rehydrateResumeError(JSON.parse(JSON.stringify(serializeResumeError(original))));
			assert.equal(copy.constructor, original.constructor);
			assert.ok(isResumeError(copy));
			assert.equal(copy.message, original.message);
			assert.equal(copy.code, original.code);
			assert.equal(copy.hint, original.hint);
			assert.equal(copy.retryable, original.retryable);
			assert.deepEqual(copy.fields, original.fields);
		}
		const withCause = rehydrateResumeError(serializeResumeError(originals[0]!));
		assert.equal((withCause.cause as Error).message, "spawn ENOENT");
		assert.equal((withCause.cause as Error).name, "Error");
		const relayedCause = new TypeError("relayed");
		assert.equal(rehydrateResumeError(serializeResumeError(originals[1]!), relayedCause).cause, relayedCause);
	});

	test("an unknown resume error name rehydrates into the base class keeping name, code, hint and retryable", () => {
		const form = {
			name: "ResumeFutureError",
			code: "future-code",
			message: "m",
			hint: "h",
			retryable: true,
			fields: {},
		};
		const copy = rehydrateResumeError(form);
		assert.ok(copy instanceof ResumeError);
		assert.equal(copy.name, "ResumeFutureError");
		assert.equal(copy.code, "future-code");
		assert.equal(copy.hint, "h");
		assert.equal(copy.retryable, true);
		const mismatched = rehydrateResumeError({ ...form, name: "ResumeNotFoundError", code: "setup-hook-failed" });
		assert.equal(mismatched instanceof ResumeNotFoundError, false);
		assert.ok(mismatched instanceof ResumeError);
		const base = rehydrateResumeError({ ...form, name: "ResumeError", code: "not-found" });
		assert.equal(base.constructor, ResumeError);
	});

	test("serialization bounds the cause chain to five levels and drops stack traces", () => {
		let cause: Error = new Error("root");
		for (let depth = 0; depth < 6; depth++) cause = new Error(`level ${depth}`, { cause });
		let serialized = serializeResumeError(
			new ResumePreconditionError({ entryPoint: "cli", problems: [PROBLEM] }, cause),
		).cause;
		let depth = 0;
		while (serialized) {
			assert.equal("stack" in serialized, false);
			serialized = serialized.cause;
			depth++;
		}
		assert.equal(depth, 5);
	});
});

describe("resume catalog lookups that cannot reach storage (#4329)", () => {
	test("an unreachable store during the lookup becomes a retryable typed error that keeps the cause", () => {
		const cause = new StorageTransientError(
			{ adapter: "libsql", location: "https://db?authToken=s" },
			{ code: "connection-refused", outcome: "not-applied", attempts: 1 },
			new Error("ECONNREFUSED"),
		);
		const error = resumeLookupError(cause, "session", "abc");
		assert.ok(error instanceof ResumeCatalogUnavailableError);
		assert.equal(error.code, "catalog-unavailable");
		assert.equal(error.retryable, true);
		assert.equal(error.phase, "catalog-lookup");
		assert.equal(error.storage, "libsql");
		assert.equal(error.cause, cause);
		assert.ok(isRetryableResumeError(error));
		assert.ok(isRetryableResumeError(new Error("wrapped", { cause: error })));
		assert.equal(
			error.message,
			"Cannot look up the session abc: the storage (libsql) could not be reached (catalog-unavailable). Check that this node can reach the shared storage (`atomic storage status`), then resume again; nothing was changed.",
		);
		assert.doesNotMatch(error.message, /authToken/);
	});

	test("a picker lookup has no id, and other failures pass through unchanged", () => {
		const cause = new StorageTransientError(
			{ adapter: "node-sqlite", location: "/x" },
			{ code: "connection-lost", outcome: "unknown", attempts: 1 },
		);
		const picker = resumeLookupError(cause, "session", null) as ResumeCatalogUnavailableError;
		assert.match(picker.message, /^Cannot look up the session: the storage \(node-sqlite\)/);
		const missingToken = new StorageUnavailableError(
			{ adapter: "@bastani/atomic-storage-libsql", location: "team-token" },
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		assert.equal(resumeLookupError(missingToken, "run", "r"), missingToken);
		const other = new TypeError("bug");
		assert.equal(resumeLookupError(other, "session", "abc"), other);
		assert.equal(isRetryableResumeError(other), false);
		assert.equal(
			isRetryableResumeError(
				new ResumeNotFoundError({ subject: "session", id: "r", reason: "shared-miss", storage: "libsql" }),
			),
			false,
		);
	});

	test("the catalog error crosses process boundaries intact", () => {
		const original = new ResumeCatalogUnavailableError({
			subject: "session",
			id: null,
			storage: "libsql",
			phase: "catalog-lookup",
		});
		const copy = rehydrateResumeError(JSON.parse(JSON.stringify(serializeResumeError(original))));
		assert.ok(copy instanceof ResumeCatalogUnavailableError);
		assert.ok(isResumeCatalogUnavailableError(copy));
		assert.equal((copy as ResumeCatalogUnavailableError).retryable, true);
		assert.deepEqual((copy as ResumeCatalogUnavailableError).fields, original.fields);
		assert.ok(
			isResumeCatalogUnavailableError({ name: "ResumeCatalogUnavailableError", code: "catalog-unavailable" }),
		);
	});
});

describe("resume not-found classification (#4329)", () => {
	test("built-in local adapters are local-only and named with their location", () => {
		for (const adapter of ["node-sqlite", "jsonl", "memory"]) {
			const error = resumeNotFoundError("id", { adapter, location: "/x" });
			assert.equal(error.reason, "local-storage-not-joined");
			assert.equal(error.storage, `${adapter} at /x`);
		}
	});

	test("a shared adapter miss never exposes the storage location", () => {
		const error = resumeNotFoundError("s", {
			adapter: "libsql",
			location: "https://db.example?authToken=s",
		});
		assert.equal(error.reason, "shared-miss");
		assert.equal(error.storage, "libsql");
		assert.equal(error.subject, "session");
		assert.doesNotMatch(error.message, /authToken|db\.example/);
	});
});

class CountingIo implements ResumePreflightIo {
	readonly calls: string[] = [];
	readonly missingModules = new Set<string>();
	readonly files = new Map<string, string | NodeJS.ErrnoException>();
	readonly variables = new Map<string, string>();
	gitError: GitUnavailableError | undefined;
	thrown: Error | undefined;

	async loadAdapter(module: string): Promise<void> {
		this.calls.push(`load:${module}`);
		if (this.thrown) throw this.thrown;
		if (this.missingModules.has(module)) throw new StorageAdapterLoadError(module, new Error("Cannot find module"));
	}
	async readText(path: string): Promise<string> {
		this.calls.push(`read:${path}`);
		const value = this.files.get(path);
		if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		if (value instanceof Error) throw value;
		return value;
	}
	env(name: string): string | undefined {
		this.calls.push(`env:${name}`);
		return this.variables.get(name);
	}
	async probeGit(): Promise<GitUnavailableError | undefined> {
		this.calls.push("git");
		return this.gitError;
	}
}

/** The most I/O operations one storage preflight may perform per adapter selection: one load and one read per secret. */
const MAX_OPERATIONS_PER_SELECTION = 1;

describe("resume storage preconditions (#4329)", () => {
	const agentDir = "/home/u/.atomic/agent";
	const libsql = (secrets?: Extract<StorageSelection, { kind: "adapter" }>["secrets"]): StorageSelection => ({
		kind: "adapter",
		module: LIBSQL_ADAPTER_PACKAGE,
		options: { url: "https://db" },
		...(secrets ? { secrets } : {}),
	});

	test("a secret held in this process's memory needs no check and costs no I/O", async () => {
		const io = new CountingIo();
		const problems = await storagePreconditionProblems(
			[{ domain: "sessions", selection: libsql({ authToken: inMemorySecret("in-memory-token") }) }],
			agentDir,
			io,
		);
		assert.deepEqual(problems, []);
		assert.deepEqual(io.calls, [`load:${LIBSQL_ADAPTER_PACKAGE}`]);
	});

	test("local selections need nothing and cost no I/O", async () => {
		const io = new CountingIo();
		const problems = await storagePreconditionProblems(
			[
				{ domain: "sessions", selection: { kind: "sqlite", path: "/x.sqlite" } },
				{ domain: "journal", selection: { kind: "jsonl", dir: "/x" } },
				{ domain: "journal", selection: { kind: "memory" } },
			],
			agentDir,
			io,
		);
		assert.deepEqual(problems, []);
		assert.deepEqual(io.calls, []);
	});

	test("a missing adapter, an unset variable and a missing token file are reported together in one pass", async () => {
		const io = new CountingIo();
		io.missingModules.add(LIBSQL_ADAPTER_PACKAGE);
		const selection = libsql({ authToken: { file: "agent/team-token" }, other: { env: "TEAM_TOKEN" } });
		await assert.rejects(
			checkResumeStoragePreconditions("cli", [{ domain: "sessions", selection }], agentDir, io),
			(error: unknown) => {
				assert.ok(error instanceof ResumePreconditionError);
				assert.equal(error.code, "preconditions-unmet");
				assert.equal(error.entryPoint, "cli");
				assert.deepEqual(
					error.problems.map((problem) => [problem.code, problem.subject]),
					[
						["adapter-not-installed", `storage adapter ${LIBSQL_ADAPTER_PACKAGE}`],
						["credential-missing", `token file ${join("/home/u/.atomic", "agent/team-token")}`],
						["credential-missing", "environment variable TEAM_TOKEN"],
					],
				);
				assert.match(error.hint, /atomic install npm:@bastani\/atomic-storage-libsql/);
				assert.match(error.hint, /atomic storage join <url> --token-file <path>/);
				return true;
			},
		);
		assert.deepEqual(io.calls, [
			`load:${LIBSQL_ADAPTER_PACKAGE}`,
			`read:${join("/home/u/.atomic", "agent/team-token")}`,
			"env:TEAM_TOKEN",
		]);
		assert.ok(io.calls.length <= MAX_OPERATIONS_PER_SELECTION + 2);
	});

	test("secret values never appear in problems", async () => {
		const io = new CountingIo();
		io.files.set("/abs/token", "   \n");
		io.variables.set("EMPTY_TOKEN", "");
		io.variables.set("GOOD_TOKEN", "secret-value-123");
		const problems = await storagePreconditionProblems(
			[
				{
					domain: "journal",
					selection: libsql({
						a: { file: "/abs/token" },
						b: { env: "EMPTY_TOKEN" },
						c: { env: "GOOD_TOKEN" },
					}),
				},
			],
			agentDir,
			io,
		);
		assert.deepEqual(
			problems.map((problem) => [problem.code, problem.subject]),
			[
				["credential-missing", "token file /abs/token"],
				["credential-missing", "environment variable EMPTY_TOKEN"],
			],
		);
		assert.match(problems[0]!.why, /is empty/);
		assert.match(problems[1]!.why, /is empty/);
		assert.doesNotMatch(JSON.stringify(problems), /secret-value-123/);
	});

	test("an unreadable token file names the file and the error code, not the content", async () => {
		const io = new CountingIo();
		io.files.set("/abs/token", Object.assign(new Error("EACCES"), { code: "EACCES" }));
		const [problem] = await storagePreconditionProblems(
			[{ domain: "sessions", selection: libsql({ authToken: { file: "/abs/token" } }) }],
			agentDir,
			io,
		);
		assert.equal(problem?.code, "credential-unreadable");
		assert.match(problem!.why, /\(EACCES\)/);
		assert.match(problem!.fix, /mode 600/);
	});

	test("each adapter loads once and each secret is read once across domains", async () => {
		const io = new CountingIo();
		io.variables.set("TOKEN", "t");
		const selection = libsql({ authToken: { env: "TOKEN" } });
		const problems = await storagePreconditionProblems(
			[
				{ domain: "sessions", selection },
				{ domain: "journal", selection },
			],
			agentDir,
			io,
		);
		assert.deepEqual(problems, []);
		assert.deepEqual(io.calls, [`load:${LIBSQL_ADAPTER_PACKAGE}`, "env:TOKEN"]);
	});

	test("an adapter given by path is fixed by making it loadable, and by package name by installing it", async () => {
		const io = new CountingIo();
		io.missingModules.add("./adapters/custom.mjs");
		io.missingModules.add("@acme/storage");
		const problems = await storagePreconditionProblems(
			[
				{ domain: "sessions", selection: { kind: "adapter", module: "./adapters/custom.mjs" } },
				{ domain: "journal", selection: { kind: "adapter", module: "@acme/storage" } },
			],
			agentDir,
			io,
		);
		assert.equal(problems[0]?.fix, `Make ./adapters/custom.mjs loadable from ${agentDir}.`);
		assert.match(problems[0]!.why, /sessions recorded on other nodes/);
		assert.equal(problems[1]?.fix, "Install it with `atomic install npm:@acme/storage`.");
		assert.match(problems[1]!.why, /workflow runs recorded on other nodes/);
	});

	test("a failure other than a load error is not mistaken for a missing adapter", async () => {
		const io = new CountingIo();
		io.thrown = new TypeError("bug");
		await assert.rejects(
			storagePreconditionProblems([{ domain: "sessions", selection: libsql() }], agentDir, io),
			TypeError,
		);
	});

	test("a satisfied selection passes without throwing", async () => {
		const io = new CountingIo();
		io.files.set("/abs/token", "token\n");
		await checkResumeStoragePreconditions(
			"switch-session",
			[{ domain: "journal", selection: libsql({ authToken: { file: "/abs/token" } }) }],
			agentDir,
			io,
		);
		assert.deepEqual(io.calls, [`load:${LIBSQL_ADAPTER_PACKAGE}`, "read:/abs/token"]);
	});
});

describe("tool path mapping for restored worktrees (#4329)", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-path-mapping-"));
		clearWorktreeRootMappings();
	});
	afterEach(() => {
		clearWorktreeRootMappings();
		rmSync(root, { recursive: true, force: true });
	});

	const mapping = (from: string, to: string) => ({
		from,
		to,
		snapshotId: "s".repeat(64),
		tree: "t".repeat(40),
		restoredAt: "2026-11-05T00:00:00.000Z",
	});

	test("an old-root absolute path resolves inside the restored worktree for work in it", () => {
		registerWorktreeRootMappings([mapping("/nodeA/repo", "/nodeB/wt")]);
		assert.equal(mapPathForCwd("/nodeA/repo/src/a.ts", "/nodeB/wt/src"), resolve("/nodeB/wt/src/a.ts"));
		assert.equal(mapPathForCwd("/nodeA/repo", "/nodeB/wt"), resolve("/nodeB/wt"));
	});

	test("paths outside the old root, inside the new root, or for other cwds are unchanged", () => {
		registerWorktreeRootMappings([mapping("/nodeA/repo", "/nodeB/wt")]);
		assert.equal(mapPathForCwd("/nodeA/repository/x", "/nodeB/wt"), "/nodeA/repository/x");
		assert.equal(mapPathForCwd("/etc/hosts", "/nodeB/wt"), "/etc/hosts");
		assert.equal(mapPathForCwd("/nodeB/wt/x", "/nodeB/wt"), "/nodeB/wt/x");
		assert.equal(mapPathForCwd("/nodeA/repo/x", "/elsewhere"), "/nodeA/repo/x");
		assert.equal(mapPathForCwd("/nodeA/repo/x", "/nodeB/wtx"), "/nodeA/repo/x");
	});

	test("a chain of restores maps every earlier root to the newest worktree", () => {
		registerWorktreeRootMappings([mapping("/nodeA/repo", "/nodeB/wt"), mapping("/nodeB/wt", "/nodeC/wt")]);
		assert.equal(mapPathForCwd("/nodeA/repo/a", "/nodeC/wt"), resolve("/nodeC/wt/a"));
		assert.equal(mapPathForCwd("/nodeB/wt/a", "/nodeC/wt"), resolve("/nodeC/wt/a"));
		assert.equal(mapPathForCwd("/nodeA/repo/a", "/nodeB/wt"), resolve("/nodeC/wt/a"));
	});

	test("every root a session restored follows its own restore for work in any of them", () => {
		registerWorktreeRootMappings([
			mapping("/nodeA/repo", "/nodeB/repo"),
			mapping("/nodeA/feature", "/nodeB/feature"),
		]);
		assert.equal(mapPathForCwd("/nodeA/feature/x", "/nodeB/repo"), resolve("/nodeB/feature/x"));
		assert.equal(mapPathForCwd("/nodeA/repo/x", "/nodeB/feature"), resolve("/nodeB/repo/x"));
	});

	test("the innermost restored root containing the cwd decides, and registering twice is harmless", () => {
		const outer = mapping("/old/outer", "/w");
		const inner = mapping("/old/inner", "/w/nested");
		registerWorktreeRootMappings([outer]);
		registerWorktreeRootMappings([inner]);
		registerWorktreeRootMappings([inner]);
		assert.equal(mapPathForCwd("/old/inner/x", "/w/nested/y"), resolve("/w/nested/x"));
		assert.equal(mapPathForCwd("/old/outer/x", "/w/nested/y"), "/old/outer/x");
		assert.equal(mapPathForCwd("/old/outer/x", "/w/y"), resolve("/w/x"));
	});

	test("the read and write tools resolve an old-root path into the restored worktree", async () => {
		const { resolveReadPath, resolveToCwd } = await import("../src/core/tools/path-utils.ts");
		const worktree = join(root, "wt");
		writeFileSync(join(root, "marker"), "");
		registerWorktreeRootMappings([mapping("/nodeA/repo", worktree)]);
		assert.equal(resolveToCwd("/nodeA/repo/a.txt", worktree), join(worktree, "a.txt"));
		assert.equal(resolveToCwd("a.txt", worktree), join(worktree, "a.txt"));
		assert.equal(resolveReadPath("/nodeA/repo/a.txt", worktree), join(worktree, "a.txt"));
		assert.equal(resolveToCwd(join(dirname(worktree), "marker"), worktree), join(root, "marker"));
	});
});

describe("resume error family edge cases (#4329)", () => {
	test("a serialized error without a cause has no cause key, and a rebuilt one keeps Error's property shape", () => {
		const bare = new ResumePreconditionError({ entryPoint: "cli", problems: [PROBLEM] });
		assert.equal("cause" in serializeResumeError(bare), false);
		const form = {
			name: "ResumeFutureError",
			code: "future-code",
			message: "m",
			hint: "h",
			retryable: false,
			fields: {},
			cause: { name: "Error", message: "inner" },
		};
		const copy = rehydrateResumeError(form);
		for (const key of ["name", "message", "cause"] as const) {
			const descriptor = Object.getOwnPropertyDescriptor(copy, key);
			assert.deepEqual([descriptor?.enumerable, descriptor?.configurable], [false, true], key);
		}
	});

	test("the base class names itself and adds no cause unless given one", () => {
		const bare = new ResumeError("not-found", "Summary", "Do this.", { a: 1 });
		assert.equal(bare.name, "ResumeError");
		assert.equal("cause" in bare, false);
		assert.ok(Object.isFrozen(bare.fields));
		const cause = new Error("root");
		assert.equal(new ResumeError("not-found", "S", "H", {}, cause).cause, cause);
		assert.throws(
			() => new ResumePreconditionError({ entryPoint: "cli", problems: [] }),
			/ResumePreconditionError needs at least one problem/,
		);
	});

	test("guards reject other resume classes, functions, and mismatched name and code pairs", () => {
		const notFound = new ResumeNotFoundError({
			subject: "session",
			id: "r",
			reason: "shared-miss",
			storage: "libsql",
		});
		assert.equal(isResumeSetupHookError(notFound), false);
		assert.equal(isResumePreconditionError(notFound), false);
		assert.equal(isResumeCatalogUnavailableError(notFound), false);
		assert.equal(isResumeNotFoundError({ name: "ResumePreconditionError", code: "not-found" }), false);
		assert.equal(isResumeError({ name: 7, code: "not-found" }), false);
		const named = Object.defineProperty(
			Object.assign(() => {}, { code: "not-found" }),
			"name",
			{
				value: "ResumeNotFoundError",
			},
		);
		assert.equal(isResumeError(named), false);
		assert.equal(isResumeNotFoundError(named), false);
	});

	test("findResumeError stops at a null cause", () => {
		assert.equal(findResumeError(new Error("x", { cause: null })), undefined);
		assert.equal(findResumeError("text"), undefined);
	});

	test("a rehydrated unknown resume error keeps the original's shape: enumerable code, hint, retryable and fields", () => {
		const form = { name: "ResumeFutureError", code: "future-code", message: "m", hint: "", retryable: false };
		const copy = rehydrateResumeError({ ...form, fields: { a: 1 }, cause: { name: "Error", message: "inner" } });
		assert.deepEqual(Object.keys(copy).sort(), ["code", "fields", "hint", "retryable"]);
		assert.equal(copy.name, "ResumeFutureError");
		assert.equal(copy.message, "m");
		assert.equal(copy.hint, "");
		assert.equal(copy.retryable, false);
		assert.deepEqual(copy.fields, { a: 1 });
		assert.ok(Object.isFrozen(copy.fields));
		assert.equal((copy.cause as Error).message, "inner");
		assert.equal("cause" in rehydrateResumeError({ ...form, fields: {} }), false);
	});
});

describe("tool path mapping edge cases (#4329)", () => {
	const mapping = (from: string, to: string) => ({
		from,
		to,
		snapshotId: "s".repeat(64),
		tree: "t".repeat(40),
		restoredAt: "2026-11-05T00:00:00.000Z",
	});
	beforeEach(() => clearWorktreeRootMappings());
	afterEach(() => clearWorktreeRootMappings());

	test("clearing forgets every mapping", () => {
		registerWorktreeRootMappings([mapping("/nodeA/repo", "/nodeB/wt")]);
		clearWorktreeRootMappings();
		assert.equal(mapPathForCwd("/nodeA/repo/x", "/nodeB/wt"), "/nodeA/repo/x");
	});

	test("a directory whose name starts with two dots is inside the root; the root's parent is not", () => {
		registerWorktreeRootMappings([mapping("/nodeA/repo", "/nodeB/wt")]);
		assert.equal(mapPathForCwd("/nodeA/repo/x", "/nodeB/wt/..cache"), resolve("/nodeB/wt/x"));
		assert.equal(mapPathForCwd("/nodeA/repo/x", "/nodeB"), "/nodeA/repo/x");
	});

	test("the restored root that contains the cwd decides even when registered first", () => {
		registerWorktreeRootMappings([mapping("/old/one", "/w1")]);
		registerWorktreeRootMappings([mapping("/old/two", "/w2")]);
		assert.equal(mapPathForCwd("/old/one/x", "/w1"), resolve("/w1/x"));
		assert.equal(mapPathForCwd("/old/two/x", "/w1"), "/old/two/x");
	});

	test("an unmapped path is returned exactly as given", () => {
		registerWorktreeRootMappings([mapping("/nodeA/repo", "/nodeB/wt")]);
		assert.equal(mapPathForCwd("/etc//hosts", "/nodeB/wt"), "/etc//hosts");
	});
});

describe("resume storage precondition messages (#4329)", () => {
	const agentDir = "/home/u/.atomic/agent";
	const adapter = (secrets: Extract<StorageSelection, { kind: "adapter" }>["secrets"]): StorageSelection => ({
		kind: "adapter",
		module: LIBSQL_ADAPTER_PACKAGE,
		secrets,
	});

	test("each problem says exactly what is missing and why", async () => {
		const io = new CountingIo();
		io.missingModules.add(LIBSQL_ADAPTER_PACKAGE);
		io.variables.set("EMPTY", "");
		io.files.set("/notdir/token", Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" }));
		io.files.set("/odd/token", new Error("no code"));
		const problems = await storagePreconditionProblems(
			[
				{
					domain: "sessions",
					selection: adapter({
						a: { env: "UNSET" },
						b: { env: "EMPTY" },
						c: { file: "/notdir/token" },
						d: { file: "/odd/token" },
					}),
				},
			],
			agentDir,
			io,
		);
		assert.deepEqual(problems, [
			{
				code: "adapter-not-installed",
				subject: `storage adapter ${LIBSQL_ADAPTER_PACKAGE}`,
				why: "this node's sessions storage selects it, and resuming reads sessions recorded on other nodes through it, but it cannot be loaded",
				fix: `Install it with \`atomic install npm:${LIBSQL_ADAPTER_PACKAGE}\`.`,
			},
			{
				code: "credential-missing",
				subject: "environment variable UNSET",
				why: `storage secret a of ${LIBSQL_ADAPTER_PACKAGE} reads it to authenticate to the shared storage, and it is not set`,
				fix: `Set UNSET for this process, or join with \`${STORAGE_JOIN_COMMAND}\` to keep the token in a file.`,
			},
			{
				code: "credential-missing",
				subject: "environment variable EMPTY",
				why: `storage secret b of ${LIBSQL_ADAPTER_PACKAGE} reads it to authenticate to the shared storage, and it is empty`,
				fix: `Set EMPTY for this process, or join with \`${STORAGE_JOIN_COMMAND}\` to keep the token in a file.`,
			},
			{
				code: "credential-missing",
				subject: "token file /notdir/token",
				why: `storage secret c of ${LIBSQL_ADAPTER_PACKAGE} reads it to authenticate to the shared storage, and it does not exist`,
				fix: `Write the token to /notdir/token (mode 600, readable by this user), or join again with \`${STORAGE_JOIN_COMMAND}\`.`,
			},
			{
				code: "credential-unreadable",
				subject: "token file /odd/token",
				why: `storage secret d of ${LIBSQL_ADAPTER_PACKAGE} reads it to authenticate to the shared storage, and it cannot be read (read failed)`,
				fix: `Write the token to /odd/token (mode 600, readable by this user), or join again with \`${STORAGE_JOIN_COMMAND}\`.`,
			},
		]);
	});

	test("the default I/O loads adapters without opening storage, reads files, reads the environment and probes Git", async () => {
		const { defaultResumePreflightIo } = await import("../src/core/resume/preflight.ts");
		const { setWorktreeSnapshotGit } = await import("../src/core/worktree-snapshot/git.ts");
		await assert.rejects(
			defaultResumePreflightIo.loadAdapter("@acme/atomic-storage-missing", agentDir, "sessions"),
			StorageAdapterLoadError,
		);
		const root = mkdtempSync(join(tmpdir(), "atomic-preflight-io-"));
		try {
			writeFileSync(join(root, "token"), "abc\n");
			assert.equal(await defaultResumePreflightIo.readText(join(root, "token")), "abc\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
		process.env.ATOMIC_TEST_RESUME_PREFLIGHT = "set";
		try {
			assert.equal(defaultResumePreflightIo.env("ATOMIC_TEST_RESUME_PREFLIGHT"), "set");
		} finally {
			delete process.env.ATOMIC_TEST_RESUME_PREFLIGHT;
		}
		assert.equal(await defaultResumePreflightIo.probeGit(), undefined);
		const previous = setWorktreeSnapshotGit(async () => ({ path: "/nonexistent/git-for-atomic-test", env: {} }));
		try {
			const missing = await defaultResumePreflightIo.probeGit();
			assert.ok(isGitUnavailableError(missing));
			assert.equal(missing.code, "not-installed");
		} finally {
			setWorktreeSnapshotGit(previous);
		}
		const provisionFailure = gitUnavailable();
		setWorktreeSnapshotGit(async () => {
			throw provisionFailure;
		});
		try {
			assert.equal(await defaultResumePreflightIo.probeGit(), provisionFailure);
			const timeout = new GitProvisionTimeoutError({ phase: "download", timeoutMs: 600_000, elapsedMs: 600_002 });
			setWorktreeSnapshotGit(async () => {
				throw timeout;
			});
			const timedOut = await defaultResumePreflightIo.probeGit();
			assert.ok(isGitUnavailableError(timedOut));
			assert.deepEqual(
				[timedOut.code, timedOut.platform, timedOut.cause],
				["not-installed", process.platform, timeout],
			);
			assert.equal(timedOut.fields.installDir, join(getBinDir(), "git"));
			setWorktreeSnapshotGit(async () => {
				throw provisionFailure;
			});
			const aborted = new AbortController();
			const reason = new Error("stopped");
			aborted.abort(reason);
			await assert.rejects(defaultResumePreflightIo.probeGit(aborted.signal), (error: unknown) => error === reason);
		} finally {
			setWorktreeSnapshotGit(previous);
		}
	});

	test("the git problem reuses Git's own install hint", async () => {
		const { gitUnavailableProblem } = await import("../src/core/resume/preflight.ts");
		const error = gitUnavailable();
		assert.deepEqual(gitUnavailableProblem(error, "a restore is needed"), {
			code: "git-unavailable",
			subject: "git (not-installed)",
			why: "a restore is needed",
			fix: error.hint,
		});
	});
});

describe("resume glue: remaining edge cases (#4329)", () => {
	const mapping = (from: string, to: string) => ({
		from,
		to,
		snapshotId: "s".repeat(64),
		tree: "t".repeat(40),
		restoredAt: "2026-11-05T00:00:00.000Z",
	});
	beforeEach(() => clearWorktreeRootMappings());
	afterEach(() => clearWorktreeRootMappings());

	test("a guard does not accept a name that only stringifies to a resume class", () => {
		assert.equal(isResumeError({ name: { toString: () => "ResumeNotFoundError" }, code: "not-found" }), false);
	});

	test("a sibling of the restored root is outside it", () => {
		registerWorktreeRootMappings([mapping("/nodeA/repo", "/nodeB/wt")]);
		assert.equal(mapPathForCwd("/nodeA/repo/x", "/nodeB/other"), "/nodeA/repo/x");
	});

	test("the innermost restored root wins whatever order the roots were registered in", () => {
		registerWorktreeRootMappings([mapping("/old/inner", "/w/nested")]);
		registerWorktreeRootMappings([mapping("/old/outer", "/w")]);
		assert.equal(mapPathForCwd("/old/inner/x", "/w/nested/y"), resolve("/w/nested/x"));
	});

	// Windows has no /bin/false to stand in for a Git that starts and fails.
	test.skipIf(process.platform === "win32")(
		"the default I/O loads an installed adapter and reports a failing Git as a failure, not as missing",
		async () => {
			const { defaultResumePreflightIo } = await import("../src/core/resume/preflight.ts");
			const { setWorktreeSnapshotGit } = await import("../src/core/worktree-snapshot/git.ts");
			const adapter = join(dirname(new URL(import.meta.url).pathname), "..", "..", "storage-libsql", "libsql.js");
			await defaultResumePreflightIo.loadAdapter(adapter, "/home/u/.atomic/agent", "journal");
			const previous = setWorktreeSnapshotGit(async () => ({ path: "/bin/false", env: {} }));
			try {
				await assert.rejects(defaultResumePreflightIo.probeGit(), (error: unknown) => {
					assert.equal((error as { name?: string }).name, "WorkspaceGitError");
					return true;
				});
			} finally {
				setWorktreeSnapshotGit(previous);
			}
		},
	);

	test("tool paths keep stripping @ and normalizing unicode spaces", async () => {
		const { resolveToCwd } = await import("../src/core/tools/path-utils.ts");
		const base = resolve(tmpdir(), "x");
		assert.equal(resolveToCwd("@a.ts", base), join(base, "a.ts"));
		assert.equal(resolveToCwd("a\u00A0b.ts", base), join(base, "a b.ts"));
	});
});

test("the catalog timeout error crosses process boundaries intact and is retryable (#4329)", async () => {
	const { ResumeCatalogTimeoutError, isResumeCatalogTimeoutError } = await import("../src/core/resume/errors.ts");
	const original = new ResumeCatalogTimeoutError({
		subject: "session",
		id: null,
		storage: "libsql",
		phase: "catalog-lookup",
		timeoutMs: 15000,
		elapsedMs: 15003,
	});
	assert.match(
		original.message,
		/^Cannot look up the session: the storage \(libsql\) did not answer within 15000 ms \(catalog-timeout\)\./,
	);
	const copy = rehydrateResumeError(JSON.parse(JSON.stringify(serializeResumeError(original))));
	assert.ok(copy instanceof ResumeCatalogTimeoutError);
	assert.deepEqual((copy as typeof original).fields, original.fields);
	assert.ok(isResumeCatalogTimeoutError({ name: "ResumeCatalogTimeoutError", code: "catalog-timeout" }));
	assert.equal(isResumeCatalogTimeoutError({ name: "ResumeCatalogTimeoutError", code: "catalog-unavailable" }), false);
	assert.ok(isRetryableResumeError(new Error("wrapped", { cause: copy })));
});
