import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "vitest";
import { resolveWorkspace, workspace } from "../../packages/coding-agent/src/core/workspace/index.ts";
import { bunExecutable, moduleDir } from "../helpers/runtime.js";
import {
	createRemote,
	createRepository,
	git,
	type WorkspaceSandboxDirs,
	workspaceSandbox,
} from "../helpers/workspace-repos.ts";

/** Structural cost: every case starts real Bun processes that load the lease module and contend through SQLite. */
const CHAOS_TIMEOUT_MS = 120_000;
const WORKER = join(moduleDir(import.meta.url), "..", "fixtures", "workspace-lease-worker.ts");
const RESOLVER = join(moduleDir(import.meta.url), "..", "fixtures", "workspace-resolve-worker.ts");
const BINDERS = 8;
const CONTENDERS = 24;

interface Outcome {
	readonly outcome: "acquired" | "released" | "refused";
	readonly owner: string;
	readonly pid?: number;
	readonly code?: string;
	readonly name?: string;
}

interface Contender {
	readonly child: ChildProcessWithoutNullStreams;
	readonly first: Promise<Outcome | undefined>;
	readonly exited: Promise<void>;
}

const running = new Set<ChildProcessWithoutNullStreams>();
let dirs: WorkspaceSandboxDirs;

beforeEach(() => {
	dirs = workspaceSandbox("atomic-workspace-lease-chaos-");
});

afterEach(() => {
	for (const child of running) child.kill("SIGKILL");
	running.clear();
	dirs.cleanup();
});

function contend(worktree: string, owner: string): Contender {
	const child = spawn(bunExecutable(), [WORKER, worktree, owner], { stdio: ["pipe", "pipe", "pipe"] });
	running.add(child);
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	void exited.then(() => running.delete(child));
	const first = new Promise<Outcome | undefined>((resolve) => {
		let buffered = "";
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			buffered += chunk;
			const line = buffered.split("\n")[0];
			if (buffered.includes("\n") && line !== undefined) resolve(JSON.parse(line) as Outcome);
		});
		child.once("close", () => resolve(undefined));
	});
	return { child, first, exited };
}

async function boundWorktree(name: string): Promise<string> {
	const repo = createRepository(dirs.root, name);
	return (await resolveWorkspace(workspace({ repo, branch: `${name}-work` }))).worktree;
}

/** The lease database is intact and holds at most one writer. */
function assertLeaseStore(worktree: string): readonly { readonly owner: string; readonly pid: number }[] {
	const database = new DatabaseSync(
		join(git(worktree, "rev-parse", "--absolute-git-dir"), "atomic-writer-lease.sqlite"),
	);
	try {
		assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
		return database
			.prepare("SELECT owner, pid FROM writer")
			.all()
			.map((row) => ({ owner: String(row.owner), pid: Number(row.pid) }));
	} finally {
		database.close();
	}
}

describe.skipIf(process.platform === "win32")("workspace writer lease under process chaos (#3109)", () => {
	test(
		"many concurrent writers see exactly one winner; a SIGKILLed holder is taken over (#3109)",
		async () => {
			const worktree = await boundWorktree("race");
			const contenders = Array.from({ length: CONTENDERS }, (_, index) => contend(worktree, `writer-${index}`));
			const outcomes = await Promise.all(contenders.map((contender) => contender.first));
			const winners = outcomes.filter((outcome) => outcome?.outcome === "acquired");
			const refused = outcomes.filter((outcome) => outcome?.outcome === "refused");
			assert.equal(winners.length, 1, "exactly one writer holds the lease");
			assert.equal(refused.length, CONTENDERS - 1);
			for (const outcome of refused) assert.equal(outcome?.code, "writer-conflict");
			assert.deepEqual(
				assertLeaseStore(worktree).map((row) => row.owner),
				[winners[0]!.owner],
			);

			const holder = contenders[outcomes.indexOf(winners[0])]!;
			holder.child.kill("SIGKILL");
			await holder.exited;
			const successor = contend(worktree, "successor");
			assert.equal((await successor.first)?.outcome, "acquired", "recovery needs no manual step");
			successor.child.stdin.write("release\n");
			await successor.exited;
			assert.equal(assertLeaseStore(worktree).length, 0);
		},
		CHAOS_TIMEOUT_MS,
	);

	test(
		"a SIGSTOPped holder keeps its lease until it continues and releases (#3109)",
		async () => {
			const worktree = await boundWorktree("stopped");
			const holder = contend(worktree, "stopped-holder");
			assert.equal((await holder.first)?.outcome, "acquired");
			holder.child.kill("SIGSTOP");
			const blocked = contend(worktree, "while-stopped");
			const refused = await blocked.first;
			assert.equal(refused?.outcome, "refused");
			assert.equal(refused?.code, "writer-conflict");
			holder.child.kill("SIGCONT");
			holder.child.stdin.write("release\n");
			await holder.exited;
			const next = contend(worktree, "after-continue");
			assert.equal((await next.first)?.outcome, "acquired");
			next.child.kill("SIGKILL");
		},
		CHAOS_TIMEOUT_MS,
	);

	test(
		"SIGKILL at random points of contention never corrupts the store or yields two holders (#3109)",
		async () => {
			const worktree = await boundWorktree("killed");
			for (let round = 0; round < 6; round++) {
				const contenders = Array.from({ length: 8 }, (_, index) => contend(worktree, `round-${round}-${index}`));
				await Promise.all(
					contenders.map(
						(contender, index) =>
							new Promise<void>((resolve) =>
								setTimeout(
									() => {
										if (index % 2 === 0) contender.child.kill("SIGKILL");
										resolve();
									},
									5 + ((round * 7 + index * 13) % 60),
								),
							),
					),
				);
				const outcomes = await Promise.all(contenders.map((contender) => contender.first));
				const live = outcomes.filter((outcome, index) => outcome?.outcome === "acquired" && index % 2 === 1);
				assert.ok(live.length <= 1, `round ${round}: at most one surviving holder`);
				const rows = assertLeaseStore(worktree);
				assert.ok(rows.length <= 1, `round ${round}: one writer row at most`);
				for (const contender of contenders) contender.child.kill("SIGKILL");
				await Promise.all(contenders.map((contender) => contender.exited));
			}
			const recovered = contend(worktree, "recovered");
			assert.equal((await recovered.first)?.outcome, "acquired", "every killed holder is recoverable");
			recovered.child.kill("SIGKILL");
		},
		CHAOS_TIMEOUT_MS,
	);
});

describe("workspace binding across processes (#3109)", () => {
	test(
		"processes binding one new branch at once all get its one worktree (#3109)",
		async () => {
			const remote = createRemote(dirs.root, "shared-branch");
			const outcomes = await Promise.all(
				Array.from(
					{ length: BINDERS },
					() =>
						new Promise<{ readonly outcome: string; readonly worktree?: string; readonly message?: string }>(
							(resolve, reject) => {
								const child = spawn(bunExecutable(), [RESOLVER, remote.url, "together"], {
									stdio: ["ignore", "pipe", "pipe"],
								});
								let output = "";
								child.stdout.setEncoding("utf-8");
								child.stdout.on("data", (chunk: string) => {
									output += chunk;
								});
								child.once("error", reject);
								child.once("close", () => resolve(JSON.parse(output.split("\n")[0] ?? "{}")));
							},
						),
				),
			);
			assert.deepEqual(
				outcomes.map((outcome) => outcome.outcome),
				Array.from({ length: BINDERS }, () => "bound"),
				JSON.stringify(outcomes.find((outcome) => outcome.outcome !== "bound")),
			);
			const worktrees = new Set(outcomes.map((outcome) => outcome.worktree));
			assert.equal(worktrees.size, 1, "one worktree for the branch");
			const [worktree] = worktrees;
			assert.equal(git(worktree!, "symbolic-ref", "--short", "HEAD"), "together");
		},
		CHAOS_TIMEOUT_MS,
	);
});
