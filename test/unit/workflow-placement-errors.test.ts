import assert from "node:assert/strict";
import { test } from "vitest";
import { SHARED_STORAGE_JOIN_HINT } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	gitInstallCommand,
	isSharedPoolSetupError,
	isStaleStageLeaseError,
	isWorkerPlacementConfigError,
	isWorkerPlacementError,
	isWorkspaceRestoreUnavailableError,
	rehydrateWorkerPlacementError,
	type SerializedWorkerPlacementError,
	SharedPoolSetupError,
	StaleStageLeaseError,
	selectionLocation,
	serializeWorkerPlacementError,
	sharedPoolProblems,
	WorkerPlacementConfigError,
	WorkerPlacementError,
	WorkspaceRestoreUnavailableError,
	workspaceBindingIdentity,
} from "../../packages/workflows/src/workers/placement-errors.js";
import { restoreUnavailable, type WorkspaceBinding } from "../../packages/workflows/src/workers/workspace-binding.js";

/** A #3109 bound workspace carries more than the binding's identity: its branch, among others. */
const binding: WorkspaceBinding & { readonly branch: string } = {
	remotes: ["https://user:s3cret@example.invalid/repo.git", "git@example.invalid:org/repo.git"],
	head: "abc123",
	tree: "def456",
	envHash: "env",
	branch: "main",
};

/** A copy as it crosses a process boundary: JSON, then the class it was. */
function acrossProcesses(error: WorkerPlacementError): WorkerPlacementError {
	return rehydrateWorkerPlacementError(JSON.parse(JSON.stringify(serializeWorkerPlacementError(error))));
}

test("a configuration error names its source, field and code, and renders its remedy once (#4310)", () => {
	const error = new WorkerPlacementConfigError(
		"sdk",
		"workers.placement",
		"invalid-option",
		'the only placement is "shared"',
	);
	assert.ok(error instanceof WorkerPlacementError);
	assert.ok(isWorkerPlacementError(error) && isWorkerPlacementConfigError(error));
	assert.equal(isWorkspaceRestoreUnavailableError(error), false);
	assert.deepEqual(
		[error.name, error.code, error.source, error.field, error.retryable],
		["WorkerPlacementConfigError", "invalid-option", "sdk", "workers.placement", false],
	);
	assert.equal(
		error.message,
		'Invalid worker placement configuration: workers.placement from sdk (invalid-option): the only placement is "shared". Fix the value and run again.',
	);
	assert.equal(error.hint, "Fix the value and run again.");
	for (const code of ["requires-local-workers", "unsupported-option"] as const) {
		const coded = new WorkerPlacementConfigError("settings", "journal", code);
		assert.equal(coded.code, code);
		assert.ok(coded.hint !== undefined && coded.message.endsWith(coded.hint));
		assert.ok(!coded.message.includes("undefined"));
	}
});

test("a setup error lists every missing piece with its remedy, without secret values (#4310)", () => {
	const error = new SharedPoolSetupError("worker-host", [
		sharedPoolProblems.sharedJournalRequired("a sqlite journal", "/home/me/.atomic/workflows/journal.sqlite"),
		sharedPoolProblems.secretUnavailable("authToken", { env: "TURSO_TOKEN" }),
		sharedPoolProblems.gitUnavailable("/usr/bin/git", "linux"),
	]);
	assert.ok(isSharedPoolSetupError(error) && isWorkerPlacementError(error));
	assert.deepEqual(
		[error.name, error.code, error.operation, error.retryable],
		["SharedPoolSetupError", "shared-journal-required", "worker-host", false],
	);
	assert.deepEqual(
		error.problems.map((problem) => [problem.code, problem.fields]),
		[
			[
				"shared-journal-required",
				{ selection: "a sqlite journal", location: "/home/me/.atomic/workflows/journal.sqlite" },
			],
			["journal-secret-unavailable", { secret: "authToken", env: "TURSO_TOKEN" }],
			["git-unavailable", { path: "/usr/bin/git", platform: "linux" }],
		],
	);
	assert.ok(error.hint?.includes("`atomic team join <url> --token-file <path>`"), "the command that joins this node");
	assert.ok(error.hint?.includes("export TURSO_TOKEN=..."));
	assert.ok(error.hint?.includes(gitInstallCommand("linux")));
	assert.equal(
		error.message,
		`Shared worker pool setup incomplete for startWorkflowWorkerHost: missing a shared journal (this node's journal is a sqlite journal at /home/me/.atomic/workflows/journal.sqlite, which other hosts cannot open) (shared-journal-required); the journal secret authToken from environment variable TURSO_TOKEN, which is not set (journal-secret-unavailable); git at /usr/bin/git, which a restore port needs and which does not run (git-unavailable). ${error.hint}`,
	);
	assert.deepEqual(
		[gitInstallCommand("darwin"), gitInstallCommand("win32")],
		["xcode-select --install", "winget install --id Git.Git -e"],
	);
	const adapter = new SharedPoolSetupError("worker-host", [sharedPoolProblems.adapterUnavailable("./missing.js")]);
	assert.equal(adapter.code, "storage-adapter-unavailable");
	assert.ok(adapter.hint?.includes("atomic install npm:@bastani/atomic-storage-libsql"));
	const elsewhere = new SharedPoolSetupError("resume", [
		sharedPoolProblems.poolOnAnotherHost("host-a", "host-b", "root-1"),
	]);
	assert.deepEqual(
		[elsewhere.code, elsewhere.problems[0]?.fields],
		["pool-on-another-host", { recordedHost: "host-a", thisHost: "host-b", root: "root-1" }],
	);
	assert.ok(elsewhere.hint?.includes("/workflow resume root-1"));
	const file = sharedPoolProblems.secretUnavailable("authToken", { file: "/run/secrets/turso" });
	assert.deepEqual(file.fields, { secret: "authToken", file: "/run/secrets/turso" });
});

test("a restore-unavailable error carries the binding's identity without credentials (#4310)", async () => {
	const refused = await restoreUnavailable(binding, { signal: new AbortController().signal }).catch(
		(error: Error) => error,
	);
	assert.ok(isWorkspaceRestoreUnavailableError(refused));
	assert.equal(refused.code, "workspace-restore-unavailable");
	assert.equal(refused.reason, "no-restore-port");
	assert.deepEqual(refused.binding, {
		remotes: ["https://example.invalid/repo.git", "git@example.invalid:org/repo.git"],
		head: "abc123",
		tree: "def456",
		envHash: "env",
	});
	assert.ok(
		!refused.message.includes("s3cret") && !JSON.stringify(serializeWorkerPlacementError(refused)).includes("s3cret"),
	);
	const unclaimed = new WorkspaceRestoreUnavailableError("no-capable-host", workspaceBindingIdentity(binding), {
		childRunId: "child-1",
		claimWindowMs: 5_000,
	});
	assert.deepEqual(
		[unclaimed.reason, unclaimed.childRunId, unclaimed.claimWindowMs, unclaimed.retryable],
		["no-capable-host", "child-1", 5_000, false],
	);
	assert.equal(
		unclaimed.message,
		"Workspace restore unavailable: tree def456 at abc123 of https://example.invalid/repo.git, git@example.invalid:org/repo.git (workspace-restore-unavailable): no capable live host claimed child child-1 within 5000 ms. Start a worker host that has this tree or can restore it (a restore port and git), then resume the root.",
	);
});

test("a stale stage lease error says which input of which stage was refused (#4310)", () => {
	const error = new StaleStageLeaseError("stage-lease-replaced", {
		root: "root",
		runId: "run",
		stageId: "stage",
		seq: 3,
	});
	assert.ok(isStaleStageLeaseError(error));
	assert.deepEqual(
		[error.code, error.reason, error.root, error.runId, error.stageId, error.seq],
		["stale-stage-lease", "stage-lease-replaced", "root", "run", "stage", 3],
	);
	assert.equal(
		error.message,
		"Stale stage lease: input 3 of stage stage in run run (stale-stage-lease): another holder took the stage. This worker stops handling the stage; its current holder processes the stage's inputs.",
	);
	const untaken = new StaleStageLeaseError("attempt-replaced", {
		root: "root",
		runId: "run",
		stageId: "stage",
		seq: null,
	});
	assert.equal(untaken.seq, null);
	assert.ok(
		untaken.message.startsWith(
			"Stale stage lease: stage stage in run run (stale-stage-lease): the attempt was replaced.",
		),
	);
});

test("placement errors cross a process boundary as the same class, with their fields and causes (#4310)", () => {
	const cause = new StaleStageLeaseError("attempt-replaced", { root: "r", runId: "x", stageId: "s", seq: 1 });
	const errors: WorkerPlacementError[] = [
		new WorkerPlacementConfigError("env", "ATOMIC_POOL_DURABLE_JOURNAL", "invalid-option", "missing", {
			cause: new Error("plain cause"),
		}),
		new WorkspaceRestoreUnavailableError("no-capable-host", workspaceBindingIdentity(binding), {
			childRunId: "c",
			claimWindowMs: 1,
			cause,
		}),
		cause,
		new SharedPoolSetupError(
			"shared-placement",
			[
				sharedPoolProblems.sharedJournalRequired("a journal object", undefined),
				sharedPoolProblems.adapterUnavailable("libsql"),
			],
			{ cause: new Error("adapter failed to load") },
		),
	];
	for (const error of errors) {
		const copy = acrossProcesses(error);
		assert.equal(copy.constructor, error.constructor);
		assert.deepEqual(
			[copy.name, copy.code, copy.message, copy.hint, copy.retryable, copy.fields()],
			[error.name, error.code, error.message, error.hint, error.retryable, error.fields()],
		);
	}
	const restored = acrossProcesses(errors[1]!) as WorkspaceRestoreUnavailableError;
	assert.ok(isStaleStageLeaseError(restored.cause), "a typed cause comes back typed");
	assert.ok(isStaleStageLeaseError(restored), "guards walk the cause chain");
	const config = acrossProcesses(errors[0]!);
	assert.deepEqual([(config.cause as Error).name, (config.cause as Error).message], ["Error", "plain cause"]);
	assert.equal((acrossProcesses(errors[3]!).cause as Error).message, "adapter failed to load");
	assert.equal(acrossProcesses(errors[2]!).cause, undefined, "an error without a cause comes back without one");
});

test("an unknown placement error comes back as the family base with its name and code (#4310)", () => {
	const copy = rehydrateWorkerPlacementError({
		name: "FuturePlacementError",
		code: "future-code",
		message: "Future: x (future-code). Do y.",
		hint: "Do y.",
		retryable: true,
		fields: { x: 1 },
	});
	assert.equal(copy.constructor, WorkerPlacementError);
	assert.deepEqual(
		[copy.name, copy.code, copy.hint, copy.retryable],
		["FuturePlacementError", "future-code", "Do y.", true],
	);
	assert.equal(isWorkerPlacementError(copy), true, "the base is a placement error");
	assert.equal(isWorkerPlacementConfigError(copy), false);
});

test("guards match structurally, across realms, and stop at a bounded cause depth (#4310)", () => {
	const structural = {
		name: "WorkspaceRestoreUnavailableError",
		code: "workspace-restore-unavailable",
		retryable: false,
	};
	assert.equal(isWorkspaceRestoreUnavailableError(structural), true);
	assert.equal(isWorkerPlacementError(structural), true);
	assert.equal(isWorkerPlacementError({ name: "WorkspaceRestoreUnavailableError", code: 1, retryable: false }), false);
	assert.equal(isWorkerPlacementError({ name: "Other", code: "x", retryable: false }), false);
	assert.equal(isWorkerPlacementError(undefined), false);
	let deep: Error = new StaleStageLeaseError("attempt-replaced", { root: "r", runId: "x", stageId: "s", seq: 1 });
	for (let depth = 0; depth < 7; depth++) deep = new Error("wrapped", { cause: deep });
	assert.equal(isStaleStageLeaseError(deep), true);
	deep = new Error("wrapped", { cause: deep });
	assert.equal(isStaleStageLeaseError(deep), false, "a cause past the bound is not looked at");
});

test("credentials are stripped from remote URLs, and nothing else about a remote changes (#4310)", () => {
	const bound: WorkspaceBinding & Record<"root" | "branch" | "worktree", string> = {
		remotes: [
			"https://example.invalid",
			"https://token@example.invalid/r.git",
			"https://:secret@example.invalid/r.git",
			"git@example.invalid:org/r.git",
			"not a url",
		],
		head: "h",
		tree: "t",
		envHash: "e",
		root: "/r",
		branch: "main",
		worktree: "/w",
	};
	assert.deepEqual(
		workspaceBindingIdentity(bound),
		{
			remotes: [
				"https://example.invalid",
				"https://example.invalid/r.git",
				"https://example.invalid/r.git",
				"git@example.invalid:org/r.git",
				"not a url",
			],
			head: "h",
			tree: "t",
			envHash: "e",
		},
		"an identity keeps only the matched fields",
	);
});

test("each configuration code carries its own remedy, and the detail only when there is one (#4310)", () => {
	const hints = Object.fromEntries(
		(["invalid-option", "requires-local-workers", "unsupported-option", "changed-on-resume"] as const).map((code) => [
			code,
			new WorkerPlacementConfigError("settings", "field", code).hint,
		]),
	);
	assert.deepEqual(hints, {
		"invalid-option": "Fix the value and run again.",
		"requires-local-workers":
			"Set localWorkers with the worker definitions the root pools, or remove workers.placement.",
		"unsupported-option": "Remove the option, or run the root without shared placement.",
		"changed-on-resume": "Resume the root with the workers settings it started with, or start a new run.",
	});
	assert.equal(
		new WorkerPlacementConfigError("sdk", "workers.placement", "changed-on-resume", "workers.placement changed")
			.message,
		"Invalid worker placement configuration: workers.placement from sdk (changed-on-resume): workers.placement changed. Resume the root with the workers settings it started with, or start a new run.",
	);
	const bare = new WorkerPlacementConfigError("env", "VARIABLE", "invalid-option");
	assert.equal(
		bare.message,
		"Invalid worker placement configuration: VARIABLE from env (invalid-option). Fix the value and run again.",
	);
	assert.deepEqual(bare.fields(), { source: "env", field: "VARIABLE" });
	assert.equal(bare.detail, undefined);
	assert.equal(bare.cause, undefined);
	const detailed = new WorkerPlacementConfigError("sdk", "maxWorkers", "invalid-option", "must be positive");
	assert.deepEqual(detailed.fields(), { source: "sdk", field: "maxWorkers", detail: "must be positive" });
	assert.ok(detailed.message.includes("(invalid-option): must be positive."));
	const base = new WorkerPlacementError("custom", "Custom failure");
	assert.deepEqual(
		[base.name, base.code, base.hint, base.retryable, base.fields(), base.cause],
		["WorkerPlacementError", "custom", undefined, false, {}, undefined],
	);
	assert.equal(new WorkerPlacementError("custom", "m", { retryable: true, hint: "h" }).retryable, true);
});

test("setup problems name each missing piece and how to supply it (#4310)", () => {
	assert.deepEqual(sharedPoolProblems.sharedJournalRequired("a memory journal", undefined), {
		code: "shared-journal-required",
		subject: "a shared journal (this node's journal is a memory journal, which other hosts cannot open)",
		hint: `Join this node to the shared storage with \`${SHARED_STORAGE_JOIN_HINT}\`, or select the journal through a storage adapter every host opens, such as { adapter: "@bastani/atomic-storage-libsql", options: { url } }.`,
		fields: { selection: "a memory journal" },
	});
	assert.deepEqual(sharedPoolProblems.adapterUnavailable("./adapter.js"), {
		code: "storage-adapter-unavailable",
		subject: "the storage adapter ./adapter.js, which cannot be loaded",
		hint: "Install it with `atomic install npm:@bastani/atomic-storage-libsql`, or fix the adapter path.",
		fields: { module: "./adapter.js" },
	});
	assert.deepEqual(sharedPoolProblems.secretUnavailable("authToken", { file: "/run/token" }), {
		code: "journal-secret-unavailable",
		subject: "the journal secret authToken from file /run/token, which cannot be read",
		hint: "Create /run/token with the secret, readable by this user.",
		fields: { secret: "authToken", file: "/run/token" },
	});
	assert.deepEqual(sharedPoolProblems.secretUnavailable("authToken", { env: "TOKEN" }), {
		code: "journal-secret-unavailable",
		subject: "the journal secret authToken from environment variable TOKEN, which is not set",
		hint: "Set TOKEN in this host's environment, for example `export TOKEN=...`.",
		fields: { secret: "authToken", env: "TOKEN" },
	});
	assert.deepEqual(sharedPoolProblems.gitUnavailable("/opt/git", "darwin"), {
		code: "git-unavailable",
		subject: "git at /opt/git, which a restore port needs and which does not run",
		hint: "Install git with `xcode-select --install`, pass its path as git: { path }, or start the host without restore.",
		fields: { path: "/opt/git", platform: "darwin" },
	});
	assert.deepEqual(sharedPoolProblems.gitUnavailable("git").fields, { path: "git", platform: process.platform });
	assert.deepEqual(sharedPoolProblems.processContainmentUnavailable("linux"), {
		code: "process-containment-unavailable",
		subject:
			"process containment for pooled workers (this host runs linux without Atomic's native process identity), which their tool processes need",
		hint: "Reinstall Atomic so its native module for this platform loads, for example `npm install -g @bastani/atomic`.",
		fields: { platform: "linux" },
	});
	assert.equal(sharedPoolProblems.processContainmentUnavailable("win32").hint, "Run worker hosts on Linux or macOS.");
	assert.deepEqual(sharedPoolProblems.processContainmentUnavailable().fields, { platform: process.platform });
	assert.equal(gitInstallCommand(), gitInstallCommand(process.platform));
	assert.equal(gitInstallCommand("linux"), "sudo apt-get install -y git");
	assert.deepEqual(sharedPoolProblems.poolOnAnotherHost("a", "b", "r"), {
		code: "pool-on-another-host",
		subject: "the pool database of host a, where this root's work queue and leases are (this host is b)",
		hint: 'Run `/workflow resume r` on host a; its workers may still be running children. Roots started with workers: { placement: "shared" } on a shared journal resume on any host.',
		fields: { recordedHost: "a", thisHost: "b", root: "r" },
	});
	assert.deepEqual(
		[
			selectionLocation({ kind: "sqlite", path: "/j.sqlite" }),
			selectionLocation({ kind: "adapter", module: "libsql" }),
			selectionLocation({ kind: "memory" }),
			selectionLocation({ kind: "database", path: "/ignored", module: "ignored" }),
		],
		["/j.sqlite", "libsql", undefined, undefined],
	);
	const operations = (["shared-placement", "worker-host", "resume", "local-pool"] as const).map(
		(operation) =>
			new SharedPoolSetupError(operation, [sharedPoolProblems.adapterUnavailable("m")]).message.split(":")[0],
	);
	assert.deepEqual(operations, [
		"Shared worker pool setup incomplete for a root with workers",
		"Shared worker pool setup incomplete for startWorkflowWorkerHost",
		"Shared worker pool setup incomplete for resuming this root here",
		"Local workers cannot start for a root with localWorkers",
	]);
	const setup = new SharedPoolSetupError("resume", [sharedPoolProblems.adapterUnavailable("m")], {
		cause: new Error("load"),
	});
	assert.deepEqual(setup.fields(), {
		operation: "resume",
		problems: [{ ...sharedPoolProblems.adapterUnavailable("m") }],
	});
	assert.equal((setup.cause as Error).message, "load");
	assert.equal(setup.retryable, false);
});

test("restore and stale-stage errors carry exactly their facts (#4310)", () => {
	const identity = { remotes: [], head: "h", tree: "t", envHash: "e" };
	const port = new WorkspaceRestoreUnavailableError("no-restore-port", identity);
	assert.equal(
		port.message,
		"Workspace restore unavailable: tree t at h (workspace-restore-unavailable): this host has no restore port. Configure restore on startWorkflowWorkerHost, or run the work on a host that already has this tree.",
	);
	assert.deepEqual(port.fields(), { reason: "no-restore-port", binding: identity });
	assert.deepEqual([port.childRunId, port.claimWindowMs, port.retryable], [undefined, undefined, false]);
	const unnamed = new WorkspaceRestoreUnavailableError("no-capable-host", identity, { claimWindowMs: 10 });
	assert.ok(unnamed.message.includes("no capable live host claimed the work within 10 ms"));
	assert.deepEqual(unnamed.fields(), { reason: "no-capable-host", binding: identity, claimWindowMs: 10 });
	const stale = new StaleStageLeaseError("attempt-replaced", { root: "r", runId: "x", stageId: "s", seq: 2 });
	assert.deepEqual(stale.fields(), { reason: "attempt-replaced", root: "r", runId: "x", stageId: "s", seq: 2 });
	assert.ok(stale.message.includes("input 2 of stage s in run x (stale-stage-lease): the attempt was replaced."));
	assert.equal(stale.retryable, false);
	assert.equal(stale.hint, "This worker stops handling the stage; its current holder processes the stage's inputs.");
});

test("each guard matches its own class structurally and nothing else (#4310)", () => {
	const shapes = {
		WorkerPlacementConfigError: isWorkerPlacementConfigError,
		SharedPoolSetupError: isSharedPoolSetupError,
		WorkspaceRestoreUnavailableError: isWorkspaceRestoreUnavailableError,
		StaleStageLeaseError: isStaleStageLeaseError,
	};
	for (const [name, guard] of Object.entries(shapes)) {
		const shape = { name, code: "c", retryable: false };
		assert.equal(guard(shape), true, `${name} matches structurally`);
		assert.equal(isWorkerPlacementError(shape), true);
		assert.equal(guard({ ...shape, retryable: "no" }), false);
		assert.equal(guard({ ...shape, code: undefined }), false);
		for (const [other, otherGuard] of Object.entries(shapes))
			if (other !== name) assert.equal(otherGuard(shape), false, `${other} does not match ${name}`);
	}
	assert.equal(isWorkerPlacementError({ name: "WorkerPlacementError", code: "c", retryable: true }), true);
	assert.equal(isWorkerPlacementError({ name: 5, code: "c", retryable: true }), false);
	assert.equal(isWorkerPlacementError(null), false);
	assert.equal(isWorkerPlacementError("WorkerPlacementError"), false);
	assert.equal(isStaleStageLeaseError(new Error("wrapped", { cause: "a string cause" })), false);
	assert.equal(isStaleStageLeaseError(new Error("x", { cause: null })), false, "a null cause ends the chain");
	const stale = new StaleStageLeaseError("attempt-replaced", { root: "r", runId: "x", stageId: "s", seq: 1 });
	const errorShapedFunction = Object.defineProperties(() => undefined, {
		name: { value: "WorkerPlacementError" },
		code: { value: "c" },
		retryable: { value: true },
	});
	assert.equal(isWorkerPlacementError(errorShapedFunction), false, "only objects are errors");
	assert.equal(
		isStaleStageLeaseError(new Error("x", { cause: Object.assign(() => undefined, { cause: stale }) })),
		false,
		"the chain follows the causes of objects only",
	);
});

test("serialization keeps a bounded cause chain, plain causes by name and message, and omits what is absent (#4310)", () => {
	let chain: Error = new Error("root cause");
	for (let depth = 0; depth < 10; depth++)
		chain = new StaleStageLeaseError(
			"attempt-replaced",
			{ root: "r", runId: "x", stageId: `s${depth}`, seq: null },
			{ cause: chain },
		);
	let serialized = serializeWorkerPlacementError(chain as StaleStageLeaseError) as
		| SerializedWorkerPlacementError
		| undefined;
	let depth = 0;
	while (serialized !== undefined && "code" in serialized) {
		depth++;
		serialized = serialized.cause as SerializedWorkerPlacementError | undefined;
	}
	assert.equal(depth, 8, "eight levels are kept");
	assert.equal(serialized, undefined);
	const plain = serializeWorkerPlacementError(
		new WorkerPlacementError("c", "m", { cause: Object.assign(new TypeError("bad"), { secret: "x" }) }),
	);
	assert.deepEqual(plain, {
		name: "WorkerPlacementError",
		code: "c",
		message: "m",
		retryable: false,
		fields: {},
		cause: { name: "TypeError", message: "bad" },
	});
	assert.deepEqual(serializeWorkerPlacementError(new WorkerPlacementError("c", "m", { cause: 42 })).cause, {
		name: "Error",
		message: "42",
	});
	assert.equal("cause" in serializeWorkerPlacementError(new WorkerPlacementError("c", "m", { cause: null })), false);
	const rehydrated = rehydrateWorkerPlacementError(plain);
	assert.deepEqual([(rehydrated.cause as Error).name, (rehydrated.cause as Error).message], ["TypeError", "bad"]);
	assert.equal(rehydrateWorkerPlacementError({ ...plain, cause: undefined }).cause, undefined);
	const withoutHint = rehydrateWorkerPlacementError({
		name: "X",
		code: "c",
		message: "m",
		retryable: false,
		fields: {},
	});
	assert.equal(withoutHint.hint, undefined);
	assert.equal(withoutHint.name, "X");
	assert.equal(Object.keys(withoutHint).includes("name"), false, "the kept name is not an enumerable own field");
	for (const reason of ["no-restore-port", "no-capable-host"] as const) {
		const copy = rehydrateWorkerPlacementError(
			serializeWorkerPlacementError(
				new WorkspaceRestoreUnavailableError(reason, { remotes: ["r"], head: "h", tree: "t", envHash: "e" }),
			),
		) as WorkspaceRestoreUnavailableError;
		assert.deepEqual([copy.reason, copy.childRunId, copy.claimWindowMs], [reason, undefined, undefined]);
	}
	for (const [reason, seq] of [
		["attempt-replaced", null],
		["stage-lease-replaced", 7],
	] as const) {
		const copy = rehydrateWorkerPlacementError(
			serializeWorkerPlacementError(new StaleStageLeaseError(reason, { root: "r", runId: "x", stageId: "s", seq })),
		) as StaleStageLeaseError;
		assert.deepEqual([copy.reason, copy.seq, copy.root, copy.runId, copy.stageId], [reason, seq, "r", "x", "s"]);
	}
	for (const source of ["sdk", "settings", "env"] as const) {
		const copy = rehydrateWorkerPlacementError(
			serializeWorkerPlacementError(new WorkerPlacementConfigError(source, "f", "unsupported-option")),
		) as WorkerPlacementConfigError;
		assert.deepEqual(
			[copy.source, copy.field, copy.code, copy.detail],
			[source, "f", "unsupported-option", undefined],
		);
	}
});

test("an error carries only what it was given: no cause own property without one, the hint on the wire, causes kept by class (#4310)", () => {
	assert.equal(Object.hasOwn(new WorkerPlacementConfigError("sdk", "f", "invalid-option"), "cause"), false);
	assert.equal(Object.hasOwn(new WorkerPlacementError("c", "m"), "cause"), false);
	const setup = new SharedPoolSetupError("worker-host", [
		sharedPoolProblems.adapterUnavailable("adapter-a"),
		sharedPoolProblems.gitUnavailable("/usr/bin/git"),
	]);
	assert.equal(setup.hint, `${setup.problems[0]!.hint} ${setup.problems[1]!.hint}`, "each remedy, space-separated");
	const config = new WorkerPlacementConfigError("settings", "workers.placement", "unsupported-option", undefined, {
		cause: new RangeError("out of range"),
	});
	const wire = serializeWorkerPlacementError(config);
	assert.equal(wire.hint, config.hint, "the hint crosses the boundary");
	assert.equal(serializeWorkerPlacementError(setup).hint, setup.hint);
	const configCopy = rehydrateWorkerPlacementError(JSON.parse(JSON.stringify(wire))) as WorkerPlacementConfigError;
	assert.ok(configCopy.cause instanceof Error);
	assert.equal(configCopy.cause instanceof WorkerPlacementError, false, "a plain cause comes back as a plain error");
	assert.deepEqual(
		[(configCopy.cause as Error).name, (configCopy.cause as Error).message],
		["RangeError", "out of range"],
	);
	const stale = new StaleStageLeaseError(
		"stage-lease-replaced",
		{ root: "r", runId: "x", stageId: "s", seq: 3 },
		{ cause: new Error("lease taken") },
	);
	const staleCopy = acrossProcesses(stale) as StaleStageLeaseError;
	assert.equal((staleCopy.cause as Error).message, "lease taken");
});
