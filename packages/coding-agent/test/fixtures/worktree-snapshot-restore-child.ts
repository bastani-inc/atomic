/**
 * A process that restores one snapshot into a shared store directory (#4951). Usage: `bun
 * worktree-snapshot-restore-child.ts <job.json>`, where the job holds `{ mode, snapshot, storeDir, git }` and mode is
 * `exact` (restoreWorktree) or `best` (restoreBestWorktree). Prints `ready` once its modules are loaded, waits for a
 * line on stdin so concurrent children start together, then prints one JSON line: `{ status, path?, error? }`.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { restoreBestWorktree } from "../../src/core/worktree-snapshot/best-restore.ts";
import type { GitExecutable } from "../../src/core/worktree-snapshot/git.ts";
import { restoreWorktree } from "../../src/core/worktree-snapshot/restore.ts";
import type { WorktreeSnapshot } from "../../src/core/worktree-snapshot/types.ts";

interface RestoreJob {
	readonly mode: "exact" | "best";
	readonly snapshot: WorktreeSnapshot;
	readonly storeDir: string;
	readonly git: GitExecutable;
}

const job = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as RestoreJob;
process.stdout.write("ready\n");
const lines = createInterface({ input: process.stdin });
await new Promise<void>((resolve) => lines.once("line", () => resolve()));
lines.close();

async function run(): Promise<{ status: string; path?: string; error?: string }> {
	const options = { storeDir: job.storeDir, git: job.git };
	if (job.mode === "exact") return { status: "restored", path: (await restoreWorktree(job.snapshot, options)).path };
	const best = await restoreBestWorktree(job.snapshot, options);
	if (best.status === "unrestored") return { status: "unrestored", error: String(best.reason) };
	return { status: best.degraded ? "degraded" : "restored", path: best.path };
}

process.stdout.write(
	`${JSON.stringify(await run().catch((error: unknown) => ({ status: "failed", error: String(error) })))}\n`,
);
