import { captureWorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/capture.js";

/**
 * Captures the checkout at `dir` `rounds` times from a separate process, for the cross-process capture-index tests.
 * Prints one line per capture: the tree, or the status when nothing was captured. Usage: worktree-snapshot-capture-child.ts <dir> <rounds>
 */
const [dir = "", roundsText = "1"] = process.argv.slice(2);

for (let round = 0; round < Number(roundsText); round++) {
	const result = await captureWorktreeSnapshot(dir);
	console.log(
		result.status === "captured"
			? result.snapshot.tree
			: `${result.status}${result.status === "unavailable" ? ` ${result.reason.message}` : ""}`,
	);
}
