import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";
import { treeDigest } from "../helpers/tree-digest.js";
import { processIdentity } from "./process-instance.js";

/** The "host" a fixture process stands in for; every process a host starts inherits it (see shared-pool-host.mjs). */
function host(): string {
	return process.env.SHARED_POOL_HOST ?? "unknown";
}

/** A child that holds long enough for a test to kill or stop its host; the worst a stuck test costs is this bound. */
const HOLD_BOUND_MS = 600_000;

/**
 * A child of the root bound to a worktree (#4329, scenario 3). It runs in the worktree its host restored from the
 * snapshot its root captured, so each step reports the host, the working directory, and what the restored tree holds.
 *
 * `first` is checkpointed on the host that runs it first. `hold` marks that this host holds the child (`held-<host>-<index>`
 * in `directory`) and waits for `release`, so a test can kill or stop the host while the child is in flight. `final`
 * runs on whichever host finishes the child, and reports its working tree: every file's digest and the commit `HEAD`
 * points at.
 */
export const campaignChild = workflow({
	name: "multinode-pool-child",
	description: "A pooled child bound to the root's worktree, which reports the tree its host restored",
	inputs: { directory: Type.String(), index: Type.Number() },
	outputs: {
		firstHost: Type.String(),
		firstCwd: Type.String(),
		finalHost: Type.String(),
		finalCwd: Type.String(),
		finalHead: Type.String(),
		finalFiles: Type.String(),
		finalInstance: Type.String(),
	},
	async run(ctx) {
		const { directory, index } = ctx.inputs;
		const first = await ctx.tool("first", { index }, async () => ({ host: host(), cwd: ctx.cwd ?? process.cwd() }));
		await ctx.tool("hold", { index }, async () => {
			writeFileSync(
				join(directory, `held-${host()}-${index}-${process.pid}`),
				JSON.stringify({ host: host(), cwd: ctx.cwd ?? process.cwd() }),
			);
			const deadline = Date.now() + HOLD_BOUND_MS;
			while (!existsSync(join(directory, "release"))) {
				if (Date.now() >= deadline) throw new Error("The campaign child was never released");
				await delay(20);
			}
			return host();
		});
		const final = await ctx.tool("final", { index }, async () => {
			const cwd = ctx.cwd ?? process.cwd();
			const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
			return { host: host(), cwd, head, files: JSON.stringify(treeDigest(cwd)), instance: processIdentity().instance };
		});
		return {
			firstHost: first.host,
			firstCwd: first.cwd,
			finalHost: final.host,
			finalCwd: final.cwd,
			finalHead: final.head,
			finalFiles: final.files,
			finalInstance: final.instance,
		};
	},
});
