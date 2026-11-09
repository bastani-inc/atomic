import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	type BlueprintNotice,
	isResumePreconditionError,
	isWorkspaceRestoreError,
	type ResumePreflightIo,
	restoreRunWorktree,
	runRestorePreconditionError,
	setUpRestoredRunWorktrees,
	setUpResumedRunWorktrees,
} from "../src/index.ts";
import { missingGit } from "./helpers/missing-git.ts";

let sandbox: string;

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "blueprint-run-setup-")));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

const path = (...segments: string[]) => join(sandbox, ...segments);

function write(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

const agentDir = () => path("agent");
const marker = () => path("markers.txt").replaceAll("\\", "/");
const mark = (label: string) => `echo "${label}" >> '${marker()}'`;
const ran = () => (existsSync(marker()) ? readFileSync(marker(), "utf8").trim().split("\n") : []);

function trustEverything(extra: Record<string, unknown> = {}): void {
	write(join(agentDir(), "settings.json"), JSON.stringify({ defaultProjectTrust: "always", ...extra }));
}

function worktree(name: string, blueprint?: string): string {
	const root = path("agent", "worktree-snapshots", "worktrees", name);
	mkdirSync(root, { recursive: true });
	if (blueprint !== undefined) write(join(root, ".atomic", "blueprint.yaml"), blueprint);
	return root;
}

class GitIo implements ResumePreflightIo {
	probes = 0;
	constructor(private readonly failure?: ReturnType<typeof missingGit>) {}
	async loadAdapter(): Promise<void> {}
	async readText(): Promise<string> {
		return "";
	}
	env(): string | undefined {
		return undefined;
	}
	async probeGit(): Promise<ReturnType<typeof missingGit> | undefined> {
		this.probes++;
		return this.failure;
	}
}

describe("building the blueprints of restored workflow worktrees (#4588)", () => {
	test("a trusted worktree is built and a clean build tells the caller nothing (#4588)", async () => {
		trustEverything();
		const root = worktree("one", `maintenance: ${mark("built")}\n`);
		const told: (readonly BlueprintNotice[])[] = [];
		const blueprints = await setUpRestoredRunWorktrees([{ root, remotes: ["https://example.test/a.git"] }], {
			agentDir: agentDir(),
			onNotices: (notices) => told.push(notices),
		});
		assert.deepEqual(ran(), ["built"]);
		assert.equal(blueprints.outcome?.status, "success");
		assert.deepEqual(told, []);
	});

	test("a failing blueprint is reported once to the caller and never rejects (#4588)", async () => {
		trustEverything();
		const root = worktree("one", "initialize:\n  - name: Install toolchain\n    run: exit 7\n");
		const told: (readonly BlueprintNotice[])[] = [];
		const blueprints = await setUpRestoredRunWorktrees([{ root, remotes: [] }], {
			agentDir: agentDir(),
			onNotices: (notices) => told.push(notices),
		});
		assert.equal(blueprints.outcome?.status, "partial");
		assert.equal(told.length, 1);
		assert.equal(told[0]?.length, 1);
		assert.equal(told[0]?.[0]?.type, "warning");
		assert.match(told[0]?.[0]?.message ?? "", /^Partial build: .*Install toolchain/);
		assert.equal(told[0], blueprints.notices);
		assert.ok(existsSync(root));
	});

	test("an untrusted worktree runs nothing and tells nobody, with the default trust setting (#4588)", async () => {
		const root = worktree("one", `maintenance: ${mark("never")}\n`);
		const told: (readonly BlueprintNotice[])[] = [];
		const blueprints = await setUpRestoredRunWorktrees([{ root, remotes: [] }], {
			agentDir: agentDir(),
			onNotices: (notices) => told.push(notices),
		});
		assert.deepEqual(ran(), []);
		assert.equal(blueprints.outcome?.status, "skipped");
		assert.deepEqual(told, []);
	});

	test("a project's own settings cannot set the setup command or the trust of its worktree (#4588)", async () => {
		write(
			join(agentDir(), ".atomic", "settings.json"),
			JSON.stringify({ defaultProjectTrust: "always", resume: { setupCommand: mark("project-command") } }),
		);
		const root = worktree("one");
		const blueprints = await setUpRestoredRunWorktrees([{ root, remotes: [] }], { agentDir: agentDir() });
		assert.deepEqual(ran(), []);
		assert.equal(blueprints.outcome?.status, "none");
	});

	test("the global resume.setupCommand runs in the restored worktree and earns the deprecation warning (#4588)", async () => {
		trustEverything({ resume: { setupCommand: `echo "alias $(pwd -P)" >> '${marker()}'` } });
		const root = worktree("one");
		const told: (readonly BlueprintNotice[])[] = [];
		await setUpRestoredRunWorktrees([{ root, remotes: [] }], {
			agentDir: agentDir(),
			onNotices: (notices) => told.push(notices),
		});
		assert.deepEqual(ran(), [`alias ${root}`]);
		assert.equal(told.length, 1);
		assert.match(told[0]?.[0]?.message ?? "", /^Deprecation warning: resume\.setupCommand is deprecated/);
	});
});

describe("cancelling the build of restored workflow worktrees (#4588)", () => {
	test("rejects with the signal's reason and keeps a removal failure as the cleanup cause (#4588)", async () => {
		trustEverything();
		const root = worktree("one", `maintenance: ${mark("never")}\n`);
		const stop = new Error("stop the resume");
		await assert.rejects(
			setUpRestoredRunWorktrees([{ root, remotes: [] }], { agentDir: agentDir(), signal: AbortSignal.abort(stop) }),
			(error: unknown) => {
				assert.equal(error, stop);
				const cleanup = (error as { cleanupCause?: unknown }).cleanupCause;
				assert.ok(isWorkspaceRestoreError(cleanup));
				assert.equal(Object.keys(error as object).includes("cleanupCause"), false);
				return true;
			},
		);
		assert.deepEqual(ran(), []);
		assert.ok(existsSync(root));
	});

	test("several removal failures are kept together as one AggregateError (#4588)", async () => {
		trustEverything();
		const first = worktree("one");
		const second = worktree("two");
		const stop = new Error("stop the resume");
		await assert.rejects(
			setUpRestoredRunWorktrees(
				[
					{ root: first, remotes: [] },
					{ root: second, remotes: [] },
				],
				{ agentDir: agentDir(), signal: AbortSignal.abort(stop) },
			),
			(error: unknown) => {
				const cleanup = (error as { cleanupCause?: unknown }).cleanupCause;
				assert.ok(cleanup instanceof AggregateError);
				assert.equal(cleanup.errors.length, 2);
				assert.equal(cleanup.message, "worktree cleanup failed");
				assert.ok(cleanup.errors.every(isWorkspaceRestoreError));
				return true;
			},
		);
	});

	test("a worktree that is already gone leaves no cleanup cause (#4588)", async () => {
		trustEverything();
		const stop = new Error("stop the resume");
		await assert.rejects(
			setUpRestoredRunWorktrees([{ root: path("agent", "worktree-snapshots", "worktrees", "gone"), remotes: [] }], {
				agentDir: agentDir(),
				signal: AbortSignal.abort(stop),
			}),
			(error: unknown) => {
				assert.equal(error, stop);
				assert.equal("cleanupCause" in (error as object), false);
				return true;
			},
		);
	});
});

describe("restoring one workflow worktree and building it (#4588)", () => {
	test("restores once, builds the worktree and resolves its root (#4588)", async () => {
		trustEverything();
		const root = worktree("one", `maintenance: ${mark("built")}\n`);
		let restores = 0;
		const resolved = await restoreRunWorktree(
			["https://example.test/a.git"],
			async () => {
				restores++;
				return root;
			},
			{ agentDir: agentDir() },
		);
		assert.equal(resolved, root);
		assert.equal(restores, 1);
		assert.deepEqual(ran(), ["built"]);
	});

	test("the same remotes are the same repository for differential builds, unknown remotes never are (#4588)", async () => {
		trustEverything();
		const blueprint = `initialize: ${mark("init")}\nmaintenance: ${mark("maint")}\n`;
		const remotes = ["https://example.test/a.git"];
		await restoreRunWorktree(remotes, async () => worktree("one", blueprint), { agentDir: agentDir() });
		await restoreRunWorktree(remotes, async () => worktree("two", blueprint), { agentDir: agentDir() });
		assert.deepEqual(ran(), ["init", "maint", "maint"]);
		await restoreRunWorktree(undefined, async () => worktree("three", blueprint), { agentDir: agentDir() });
		await restoreRunWorktree(undefined, async () => worktree("four", blueprint), { agentDir: agentDir() });
		assert.deepEqual(ran(), ["init", "maint", "maint", "init", "maint", "init", "maint"]);
	});

	test("a failing blueprint does not fail the restore and its warnings reach the caller (#4588)", async () => {
		trustEverything();
		const root = worktree("one", "maintenance: exit 3\n");
		const told: (readonly BlueprintNotice[])[] = [];
		const resolved = await restoreRunWorktree(undefined, async () => root, {
			agentDir: agentDir(),
			onNotices: (notices) => told.push(notices),
		});
		assert.equal(resolved, root);
		assert.equal(told.length, 1);
		assert.ok(existsSync(root));
	});

	test("a cancelled build rejects the restore with the signal's reason (#4588)", async () => {
		trustEverything();
		const root = worktree("one", `maintenance: ${mark("never")}\n`);
		const stop = new Error("stop");
		await assert.rejects(
			restoreRunWorktree([], async () => root, { agentDir: agentDir(), signal: AbortSignal.abort(stop) }),
			(error: unknown) => error === stop,
		);
	});
});

describe("the only restore precondition of a workflow run is Git (#4588)", () => {
	const missing = [
		{ root: "/work/a", remotes: [] },
		{ root: "/work/b", remotes: [] },
	];

	test("nothing to restore needs no Git probe (#4588)", async () => {
		const io = new GitIo(missingGit());
		assert.equal(await runRestorePreconditionError("run-1", [], { io }), undefined);
		assert.equal(io.probes, 0);
	});

	test("a machine with Git has no unmet precondition (#4588)", async () => {
		const io = new GitIo();
		assert.equal(await runRestorePreconditionError("run-1", missing, { io }), undefined);
		assert.equal(io.probes, 1);
	});

	test("a machine without Git reports git-unavailable naming the run and the checkouts, with the typed cause (#4588)", async () => {
		const failure = missingGit();
		const error = await runRestorePreconditionError("run-1", missing, { io: new GitIo(failure) });
		assert.ok(isResumePreconditionError(error));
		assert.equal(error.entryPoint, "workflow-resume");
		assert.deepEqual(
			error.problems.map((problem) => problem.code),
			["git-unavailable"],
		);
		assert.ok(error.problems[0]?.why.includes("workflow run run-1"));
		assert.ok(error.problems[0]?.why.includes("/work/a, /work/b"));
		assert.equal(error.cause, failure);
	});
});

describe("building a workflow run's worktrees on resume (#4588)", () => {
	const store = () => join(agentDir(), "worktree-snapshots");
	const root = (name: string) => join(store(), "worktrees", name);
	const mapping = (name: string, snapshotId = `snapshot-${name}`) => ({
		from: path("recorded", name),
		to: root(name),
		snapshotId,
		tree: "tree",
		restoredAt: "2026-11-09T00:00:00.000Z",
	});
	const snapshotsWith = (remotes: readonly string[], ...ids: string[]) =>
		new Map(ids.map((id) => [id, { remotes }])) as never;

	test("a restore whose snapshot record is missing is still built, identified by its own path (#4588)", async () => {
		trustEverything();
		write(join(root("a"), ".atomic", "blueprint.yaml"), `maintenance: ${mark("a")}\n`);
		const built = await setUpResumedRunWorktrees(
			{ restored: [mapping("a")], mappings: [], snapshots: new Map() },
			{ agentDir: agentDir() },
		);
		assert.equal(built.outcome?.status, "success");
		assert.deepEqual(ran(), ["a"]);
	});

	test("an earlier restored worktree whose build failed is built again, one that succeeded or is gone is not (#4588)", async () => {
		trustEverything();
		const tool = path("tool").replaceAll("\\", "/");
		write(
			join(root("failing"), ".atomic", "blueprint.yaml"),
			`initialize: test -f ${tool}\nmaintenance: ${mark("failing")}\n`,
		);
		write(join(root("fine"), ".atomic", "blueprint.yaml"), `maintenance: ${mark("fine")}\n`);
		write(path("plain-file"), "not a directory");
		const gone = mapping("gone");
		const belowFile = { ...mapping("below"), to: join(store(), "worktrees", "below-file") };
		write(belowFile.to, "a file where a worktree directory should be");
		const below = { ...belowFile, to: join(belowFile.to, "nested") };
		const notices: BlueprintNotice[][] = [];
		const options = { agentDir: agentDir(), onNotices: (n: readonly BlueprintNotice[]) => notices.push([...n]) };
		const snapshots = snapshotsWith(["https://example.test/repo.git"], "snapshot-failing", "snapshot-fine");

		const first = await setUpResumedRunWorktrees(
			{ restored: [mapping("failing"), mapping("fine")], mappings: [], snapshots },
			options,
		);
		assert.equal(first.outcome?.status, "partial");
		assert.deepEqual(ran(), ["fine"]);
		assert.equal(notices.length, 1);

		const all = [mapping("failing"), mapping("fine"), gone, below];
		const second = await setUpResumedRunWorktrees({ restored: [], mappings: all, snapshots }, options);
		assert.equal(second.outcome?.status, "partial");
		assert.equal(notices.length, 2);
		assert.deepEqual(ran(), ["fine"]);

		write(tool, "installed\n");
		const third = await setUpResumedRunWorktrees({ restored: [], mappings: all, snapshots }, options);
		assert.equal(third.outcome?.status, "success");
		assert.deepEqual(ran(), ["fine", "failing"]);
		assert.equal(notices.length, 2);

		const fourth = await setUpResumedRunWorktrees({ restored: [], mappings: all, snapshots }, options);
		assert.equal(fourth.outcome, undefined);
		assert.deepEqual(ran(), ["fine", "failing"]);
	});

	test("a repository keeps one ledger identity across restores of a run whose later snapshots have no remotes (#4588)", async () => {
		trustEverything();
		const remotes = ["https://example.test/repo.git"];
		const hopOne = mapping("hop-one", "snapshot-zero");
		const hopTwo = { ...mapping("hop-two", "snapshot-one"), from: hopOne.to };
		const snapshots = new Map([
			["snapshot-zero", { remotes }],
			["snapshot-one", { remotes: [] }],
		]) as never;
		for (const name of ["hop-one", "hop-two"]) {
			write(
				join(root(name), ".atomic", "blueprint.yaml"),
				`initialize: ${mark("initialize")}\nmaintenance: ${mark("maintenance")}\n`,
			);
		}
		await setUpResumedRunWorktrees({ restored: [hopOne], mappings: [], snapshots }, { agentDir: agentDir() });
		assert.deepEqual(ran(), ["initialize", "maintenance"]);
		await setUpResumedRunWorktrees({ restored: [hopTwo], mappings: [hopOne], snapshots }, { agentDir: agentDir() });
		assert.deepEqual(ran(), ["initialize", "maintenance", "maintenance"]);
	});
});
