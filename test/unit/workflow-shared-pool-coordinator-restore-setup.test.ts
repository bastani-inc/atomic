import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { bindingOf, hostPlatform, ProjectTrustStore, workspace } from "../../packages/coding-agent/src/index.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { listWorkflowSnapshotBoundaries } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { isWorkspaceRestoreUnavailableError } from "../../packages/workflows/src/workers/placement-errors.js";
import type { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { recordedPlacement } from "../../packages/workflows/src/workers/public-pool.js";
import { RestoreBackoff } from "../../packages/workflows/src/workers/restore-backoff.js";
import { hostRestorePort, startWorkflowWorkerHost } from "../../packages/workflows/src/workers/worker-host.js";
import type {
	WorkerHostGit,
	WorkflowWorkerHost,
	WorkflowWorkerHostOptions,
} from "../../packages/workflows/src/workers/worker-host-types.js";
import { type WorkspaceBinding, workspaceAffinityKey } from "../../packages/workflows/src/workers/workspace-binding.js";
import { sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	type Fixture,
	fanOut,
	fixture,
	libsql,
	PREFIX,
	satellite,
	stubWorker,
} from "../helpers/workflow-shared-pool-coordinator.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

/**
 * The blueprint build in the worktrees a worker host restores for pooled children (#4523, #4588): bound work starts
 * only once the host's build ran in that worktree, and a failing build never fails the child nor removes its worktree.
 */
useTemporaryAgentDir();

const WINDOWS = process.platform === "win32";
/** How long a condition that follows a stopped host or a killed hook may take to hold. */
const SETTLE_TIMEOUT_MS = 30_000;
/** Long enough that a host registered right after its root started is registered before any child waits it out. */
const CLAIM_WINDOW_MS = 3_000;

type HookMode = "install" | "fail" | "hang";
type BindingMode = "recorded" | "carried";

/** What a setup command does in the worktree it runs in: it logs its worktree, and then installs, fails, or never ends. */
const HOOK_SCRIPT = `const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const [log, mode] = process.argv.slice(2);
appendFileSync(log, "hook " + process.cwd() + "\\n");
if (mode === "install") {
	mkdirSync("node_modules", { recursive: true });
	writeFileSync("node_modules/.installed", "");
}
if (mode === "fail") {
	console.log("install failed");
	process.exit(3);
}
if (mode === "hang") {
	appendFileSync(log, "pid " + process.pid + "\\n");
	setInterval(() => {}, 60000);
}
`;

function hookCommand(directory: string, log: string, mode: HookMode): string {
	const script = join(directory, "hook.cjs");
	writeFileSync(script, HOOK_SCRIPT);
	return [process.execPath, script, log, mode].map((part) => `"${part}"`).join(" ");
}

function writeHostSettings(agentDir: string, settings: object): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
}

const logLines = (path: string): string[] =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line !== "");

/** The worktrees the setup command of `log` ran in, in order. */
const hookedWorktrees = (path: string): string[] =>
	logLines(path)
		.filter((line) => line.startsWith("hook "))
		.map((line) => line.slice("hook ".length));

async function eventually(description: string, holds: () => boolean): Promise<void> {
	const deadline = Date.now() + SETTLE_TIMEOUT_MS;
	while (!holds()) {
		if (Date.now() >= deadline) assert.fail(`${description}: not within ${SETTLE_TIMEOUT_MS} ms`);
		await sleep(25);
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

/** A clone whose lockfile has no installed dependencies behind it, with a change that no commit holds. */
async function uninstalledClone(sandbox: GitSandbox): Promise<string> {
	const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "committed\n", "package-lock.json": "{}\n" });
	sandbox.write(join(clone, "a.txt"), "uncommitted\n");
	return clone;
}

function sandboxGit(sandbox: GitSandbox): WorkerHostGit {
	return {
		path: sandbox.executable.path,
		env: { GIT_CONFIG_GLOBAL: sandbox.globalConfig, GIT_CONFIG_NOSYSTEM: "1", HOME: sandbox.root },
	};
}

async function boundChild() {
	return loadWorkerDefinition({
		path: childPath,
		exportName: "boundChild",
		digest: await definitionDigest(childPath),
	});
}

/** The binding of the snapshot another run, on the root's host, recorded of `clone` in the shared journal. */
async function recordedBinding(backend: Fixture["backend"], clone: string): Promise<WorkspaceBinding> {
	const producer = workflow({
		name: "shared-pool-snapshot-producer",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("step", {}, async () => "done");
			return {};
		},
	});
	const produced = await run(
		producer,
		{},
		{ runId: "producer", cwd: clone, store: createStore(), durableBackend: backend },
	);
	assert.equal(produced.status, "completed", JSON.stringify(produced));
	const [boundary] = await listWorkflowSnapshotBoundaries(backend.snapshotJournal, "producer");
	assert.ok(boundary, "the producer recorded a snapshot");
	return bindingOf(boundary.snapshot);
}

/**
 * A root whose children are bound to `clone`: with `recorded`, to a snapshot of it that the shared journal holds and
 * the children do not carry; with `carried`, to the root's own worktree, which the root captures as it dispatches, so
 * each child carries a snapshot that names its environment.
 */
async function boundRoot(label: string, mode: BindingMode, clone: string, claimWindowMs?: number) {
	const window = claimWindowMs === undefined ? {} : { claimWindowMs };
	if (mode === "carried") {
		const placed = await recordedPlacement({
			placement: "shared",
			workspace: workspace({ repo: clone, branch: "main", base: "main", worktree: clone }),
		});
		const binding = placed.placement.workspace!;
		const f = await fixture(label, { workspace: binding, workspaceWorktree: placed.worktree, ...window });
		return { f, binding, snapshots: {} };
	}
	let binding: WorkspaceBinding | undefined;
	const f = await fixture(label, {
		bind: async (backend) => {
			binding = await recordedBinding(backend, clone);
			return binding;
		},
		...window,
	});
	// The root records no snapshot of its own, so its children carry none.
	return { f, binding: binding!, snapshots: { snapshots: { enabled: false } } };
}

async function startHost(
	f: Fixture,
	agentDir: string,
	custom?: { readonly restore: WorkflowWorkerHostOptions["restore"]; readonly git: WorkerHostGit },
): Promise<WorkflowWorkerHost> {
	return startWorkflowWorkerHost({
		journal: {
			adapter: libsql,
			options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
			prefix: PREFIX,
		},
		agentDir,
		maxWorkers: 1,
		hostId: "host-c",
		workerEntry: stubWorker,
		...custom,
	});
}

function startRoot(f: Fixture, parent: Parameters<typeof run>[0], snapshots: object) {
	return run(
		parent,
		{},
		{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend, ...snapshots },
	);
}

/** A host of one worker whose restore port is the default one of a worker host, and whose failed restores it never retries. */
async function restoringSatellite(f: Fixture, sandbox: GitSandbox, agentDir: string, failures: Error[]) {
	const root = await f.root();
	await f.shared.reportHost({
		host: "host-b",
		labels: {},
		git: "system",
		restore: true,
		workers: 1,
		maxWorkers: 1,
		roots: ["root"],
	});
	const options: WorkflowWorkerHostOptions = {
		journal: {
			adapter: libsql,
			options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
			prefix: PREFIX,
		},
		maxWorkers: 1,
	};
	return satellite(
		f,
		root,
		{
			restore: hostRestorePort(options, sandboxGit(sandbox), f.shared, f.hostJournal, agentDir),
			restoreBackoff: new RestoreBackoff(undefined, { firstMs: 600_000, maxMs: 600_000 }),
		},
		failures,
		"host-b",
		1,
	);
}

test("a worker host started without restore, or without a git, has no restore port, and any other host has the default one (#4523)", () => {
	const git: WorkerHostGit = { path: "git", env: {} };
	const options: WorkflowWorkerHostOptions = { journal: { adapter: libsql, prefix: PREFIX }, maxWorkers: 1 };
	const shared = {} as Parameters<typeof hostRestorePort>[2];
	const journal = {} as Parameters<typeof hostRestorePort>[3];
	const portOf = (hostOptions: WorkflowWorkerHostOptions, hostGit: WorkerHostGit | undefined) =>
		hostRestorePort(hostOptions, hostGit, shared, journal, "agent");

	assert.equal(portOf({ ...options, restore: false }, git), undefined);
	assert.equal(portOf(options, undefined), undefined);
	assert.equal(portOf({ ...options, restore: false }, undefined), undefined);
	assert.equal(typeof portOf(options, git), "function");
});

for (const mode of ["recorded", "carried"] as const) {
	test.skipIf(WINDOWS)(
		`a pooled child starts on a host only after its setup command ran once in the worktree the host restored for it, with a snapshot ${
			mode === "carried" ? "the child carries" : "the shared journal recorded"
		} (#4523)`,
		async () => {
			const sandbox = new GitSandbox();
			const clone = await uninstalledClone(sandbox);
			const { f, snapshots } = await boundRoot(`shared-restore-setup-${mode}`, mode, clone);
			const agentDir = join(f.directory, "host-c", "agent");
			const storeDir = join(agentDir, "worktree-snapshots");
			writeHostSettings(agentDir, {
				defaultProjectTrust: "always",
				resume: { setupCommand: hookCommand(f.directory, f.log, "install") },
			});
			const { parent, outcomes } = await fanOut(2)((await boundChild()) as never);
			const execution = startRoot(f, parent, snapshots);
			let host: WorkflowWorkerHost | undefined;
			try {
				await f.root();
				host = await startHost(f, agentDir);
				const result = await execution;
				assert.equal(result.status, "completed", JSON.stringify(result));
				assert.deepEqual(outcomes, ["completed", "completed"]);

				const lines = logLines(f.log);
				const claims = f.claims().filter(([claimer]) => claimer === "host-c");
				assert.equal(claims.length, 2);
				const worktrees = claims.map(([, , cwd]) => cwd!);
				assert.equal(new Set(worktrees).size, 2, "each child runs in a worktree of its own");
				assert.deepEqual(
					[...hookedWorktrees(f.log)].sort(),
					worktrees.map((worktree) => realpathSync(worktree)).sort(),
					"the setup command ran once in each",
				);
				for (const worktree of worktrees) {
					assert.ok(worktree.startsWith(join(storeDir, "worktrees")), worktree);
					const hooked = lines.indexOf(`hook ${realpathSync(worktree)}`);
					const claimed = lines.findIndex((line) => line.startsWith("host-c ") && line.split(" ")[2] === worktree);
					assert.ok(
						hooked >= 0 && hooked < claimed,
						"the child was claimed after the command ran in its worktree",
					);
					assert.ok(existsSync(join(worktree, "node_modules", ".installed")), "the dependencies are installed");
				}
				assert.equal((await host.stats()).lastPlacementFailure, undefined);
			} finally {
				await host?.stop();
				await execution.catch(() => {});
				await f.close();
				sandbox.dispose();
			}
		},
		COORDINATOR_TEST_TIMEOUT_MS,
	);
}

test.skipIf(WINDOWS)(
	"a host trusted for its restored worktrees builds the repository's own blueprint in the worktree it restored for a pooled child (#4523)",
	async () => {
		const sandbox = new GitSandbox();
		const clone = await uninstalledClone(sandbox);
		sandbox.write(
			join(clone, ".atomic", "blueprint.yaml"),
			[
				`runs-on: ${hostPlatform()}`,
				"maintenance:",
				"  - name: install",
				"    run: |",
				"      mkdir -p node_modules",
				"      : > node_modules/.installed",
				'      echo "hook $(pwd -P)" >> "$SHARED_POOL_STUB_LOG"',
				"",
			].join("\n"),
		);
		await sandbox.commitAll(clone, "repository blueprint");
		const { f, snapshots } = await boundRoot("shared-restore-setup-repository", "recorded", clone);
		const agentDir = join(f.directory, "host-c", "agent");
		const storeDir = join(agentDir, "worktree-snapshots");
		writeHostSettings(agentDir, {});
		new ProjectTrustStore(agentDir).set(join(storeDir, "worktrees"), true);
		const { parent, outcomes } = await fanOut(1)((await boundChild()) as never);
		const execution = startRoot(f, parent, snapshots);
		let host: WorkflowWorkerHost | undefined;
		try {
			await f.root();
			host = await startHost(f, agentDir);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			const [claim] = f.claims().filter(([claimer]) => claimer === "host-c");
			const worktree = claim![2]!;
			assert.deepEqual(hookedWorktrees(f.log), [realpathSync(worktree)]);
			assert.ok(
				logLines(f.log).indexOf(`hook ${realpathSync(worktree)}`) <
					logLines(f.log).findIndex((line) => line.startsWith("host-c ")),
			);
			assert.ok(existsSync(join(worktree, "node_modules", ".installed")));
		} finally {
			await host?.stop();
			await execution.catch(() => {});
			await f.close();
			sandbox.dispose();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(WINDOWS)(
	"a host given its own restore function runs no blueprint build in the worktree it restores for a pooled child (#4523)",
	async () => {
		const sandbox = new GitSandbox();
		const clone = await uninstalledClone(sandbox);
		const { f, snapshots } = await boundRoot("shared-restore-setup-custom", "recorded", clone);
		const agentDir = join(f.directory, "host-c", "agent");
		const hooks = join(f.directory, "hooks.log");
		writeFileSync(hooks, "");
		writeHostSettings(agentDir, {
			defaultProjectTrust: "always",
			resume: { setupCommand: hookCommand(f.directory, hooks, "install") },
		});
		const restored = join(f.directory, "custom-restored");
		const { parent, outcomes } = await fanOut(1)((await boundChild()) as never);
		const execution = startRoot(f, parent, snapshots);
		let host: WorkflowWorkerHost | undefined;
		try {
			await f.root();
			host = await startHost(f, agentDir, {
				restore: async () => {
					mkdirSync(restored, { recursive: true });
					writeFileSync(join(restored, "package-lock.json"), "{}\n");
					return restored;
				},
				git: sandboxGit(sandbox),
			});
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			assert.deepEqual(
				f.claims().map(([claimer, , cwd]) => [claimer, cwd]),
				[["host-c", restored]],
				"the child ran in the worktree its host's own restore returned",
			);
			assert.deepEqual(hookedWorktrees(hooks), [], "no setup command ran for it");
			assert.equal(existsSync(join(restored, "node_modules")), false);
			assert.equal(existsSync(join(agentDir, "worktree-snapshots", "blueprint-builds")), false);
		} finally {
			await host?.stop();
			await execution.catch(() => {});
			await f.close();
			sandbox.dispose();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(WINDOWS)(
	"a pooled child whose host's setup command fails still runs in its restored worktree, which is kept, and the host warns (#4588)",
	async () => {
		const sandbox = new GitSandbox();
		const clone = await uninstalledClone(sandbox);
		const { f, snapshots } = await boundRoot("shared-restore-setup-failing", "recorded", clone);
		const agentDir = join(f.directory, "host-c", "agent");
		const storeDir = join(agentDir, "worktree-snapshots");
		writeHostSettings(agentDir, {
			defaultProjectTrust: "always",
			resume: { setupCommand: hookCommand(f.directory, f.log, "fail") },
		});
		const { parent, outcomes } = await fanOut(1)((await boundChild()) as never);
		const execution = startRoot(f, parent, snapshots);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let host: WorkflowWorkerHost | undefined;
		try {
			await f.root();
			host = await startHost(f, agentDir);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);

			const [claim] = f.claims().filter(([claimer]) => claimer === "host-c");
			const worktree = claim![2]!;
			assert.ok(worktree.startsWith(join(storeDir, "worktrees")), worktree);
			assert.deepEqual(hookedWorktrees(f.log), [realpathSync(worktree)], "the setup command ran once and failed");
			assert.equal(existsSync(worktree), true, "the restored worktree was kept");
			assert.deepEqual(readdirSync(join(storeDir, "worktrees")), [basename(worktree)]);
			assert.ok(
				warn.mock.calls.some(([message]) => String(message).startsWith("atomic-workflows: ")),
				"the host warned about the failed build",
			);
			assert.equal((await host.stats()).lastPlacementFailure, undefined);
		} finally {
			warn.mockRestore();
			await host?.stop();
			await execution.catch(() => {});
			await f.close();
			sandbox.dispose();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(WINDOWS)(
	"a pooled child whose snapshot has dependency inputs still runs on a host with no blueprint or setup command, in the worktree it restored (#4588)",
	async () => {
		const sandbox = new GitSandbox();
		const clone = await uninstalledClone(sandbox);
		const { f, snapshots } = await boundRoot("shared-restore-setup-missing", "carried", clone);
		const agentDir = join(f.directory, "host-c", "agent");
		writeHostSettings(agentDir, {});
		const { parent, outcomes } = await fanOut(1)((await boundChild()) as never);
		const execution = startRoot(f, parent, snapshots);
		let host: WorkflowWorkerHost | undefined;
		try {
			await f.root();
			host = await startHost(f, agentDir);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			const [claim] = f.claims().filter(([claimer]) => claimer === "host-c");
			const worktree = claim![2]!;
			assert.ok(worktree.startsWith(join(agentDir, "worktree-snapshots", "worktrees")), worktree);
			assert.equal(existsSync(worktree), true);
			assert.equal((await host.stats()).lastPlacementFailure, undefined);
		} finally {
			await host?.stop();
			await execution.catch(() => {});
			await f.close();
			sandbox.dispose();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(WINDOWS)(
	"a host that stops while its setup command runs stops the command and removes the worktree, and records no failure for the child (#4523)",
	async () => {
		const sandbox = new GitSandbox();
		const clone = await uninstalledClone(sandbox);
		const { f, binding, snapshots } = await boundRoot(
			"shared-restore-setup-stopped",
			"recorded",
			clone,
			CLAIM_WINDOW_MS,
		);
		const hooks = join(f.directory, "hooks.log");
		writeFileSync(hooks, "");
		const agentDir = join(f.directory, "host-b", "agent");
		const worktrees = join(agentDir, "worktree-snapshots", "worktrees");
		writeHostSettings(agentDir, {
			defaultProjectTrust: "always",
			resume: { setupCommand: hookCommand(f.directory, hooks, "hang") },
		});
		const { parent, outcomes } = await fanOut(1)((await boundChild()) as never);
		const execution = startRoot(f, parent, snapshots);
		const failures: Error[] = [];
		let host: PoolCoordinator | undefined;
		try {
			host = await restoringSatellite(f, sandbox, agentDir, failures);
			await eventually("the hook started", () => logLines(hooks).some((line) => line.startsWith("pid ")));
			const pid = Number(
				logLines(hooks)
					.find((line) => line.startsWith("pid "))!
					.slice("pid ".length),
			);
			assert.ok(alive(pid));

			await host.stopSatellite();
			await host.shutdown();
			host = undefined;

			await eventually("the hook was stopped", () => !alive(pid));
			await eventually("the restored worktree was removed", () => readdirSync(worktrees).length === 0);
			assert.equal(
				await f.shared.restoreFailure(workspaceAffinityKey(binding)),
				undefined,
				"no restore failure recorded",
			);
			assert.deepEqual(failures, []);
			await f.shared.forgetHost("host-b");
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			const [failure] = outcomes;
			assert.ok(isWorkspaceRestoreUnavailableError(failure), String(failure));
			assert.equal(failure.cause, undefined, "the child fails without a restore failure to carry");
			assert.deepEqual(f.claims(), [], "no worker ran it");
		} finally {
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
			sandbox.dispose();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
