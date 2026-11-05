/**
 * Chaos fixture: one process contending for a worktree's writer lease. Prints one JSON line with its outcome, then
 * holds an acquired lease until it reads "release" on stdin (or is killed).
 */
import { acquireWorkspaceWriterLease } from "../../packages/coding-agent/src/core/workspace/lease.ts";

const [worktree, owner, lockWait] = process.argv.slice(2);
if (worktree === undefined || owner === undefined)
	throw new Error("usage: workspace-lease-worker <worktree> <owner> [lock wait ms]");
try {
	const lease = await acquireWorkspaceWriterLease({ worktree }, { owner, lockWaitMs: Number(lockWait ?? 60_000) });
	process.stdout.write(`${JSON.stringify({ outcome: "acquired", owner, pid: process.pid })}\n`);
	process.stdin.setEncoding("utf-8");
	for await (const chunk of process.stdin) {
		if (String(chunk).includes("release")) {
			await lease.release();
			process.stdout.write(`${JSON.stringify({ outcome: "released", owner })}\n`);
			process.exit(0);
		}
	}
} catch (error) {
	const typed = error as { readonly name?: string; readonly code?: string; readonly fields?: unknown };
	process.stdout.write(
		`${JSON.stringify({ outcome: "refused", owner, name: typed.name, code: typed.code, fields: typed.fields })}\n`,
	);
	process.exit(0);
}
