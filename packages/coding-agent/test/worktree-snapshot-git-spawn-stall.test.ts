import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { runGit } from "../src/core/worktree-snapshot/git.ts";

/**
 * Memory the host holds while it starts Git: a fork copies the page tables of all of it before Git can run, which
 * took about 65 ms per GiB on Linux (131 ms at 2 GB and 321 ms at 6 GB), all of it on the JavaScript thread.
 */
const HOST_MEMORY_BYTES = 1024 * 1024 * 1024;

/**
 * The longest the event loop may stall, at the median of {@link GIT_RUNS} Git commands, while one starts. A start
 * that does not copy the address space stalls it for well under 5 ms at any size; a fork of {@link HOST_MEMORY_BYTES}
 * stalls it for 40 ms or more even on fast hardware. The median of several runs keeps a slow moment of a loaded
 * machine from deciding the result.
 */
const SPAWN_STALL_BUDGET_MS = 25;
const GIT_RUNS = 15;

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => {
	sandbox.dispose();
});

/** The longest gap between ticks of a 1 ms timer while `action` runs. */
async function longestStall(action: () => Promise<unknown>): Promise<number> {
	let last = performance.now();
	let longest = 0;
	const ticker = setInterval(() => {
		const now = performance.now();
		longest = Math.max(longest, now - last);
		last = now;
	}, 1);
	try {
		last = performance.now();
		await action();
		longest = Math.max(longest, performance.now() - last);
	} finally {
		clearInterval(ticker);
	}
	return longest;
}

test.skipIf(process.platform !== "linux")(
	"a host holding a gigabyte starts snapshot Git without stalling its event loop for a fork of it (#5345)",
	async () => {
		let held: Buffer | undefined = Buffer.alloc(HOST_MEMORY_BYTES, 1);
		try {
			const stalls: number[] = [];
			for (let run = 0; run < GIT_RUNS; run++) {
				stalls.push(await longestStall(() => runGit(["--version"], { cwd: sandbox.root })));
			}
			stalls.sort((left, right) => left - right);
			const median = stalls[Math.floor(stalls.length / 2)]!;
			assert.ok(
				median <= SPAWN_STALL_BUDGET_MS,
				`starting Git stalled the event loop for ${median.toFixed(1)} ms at the median (all: ${stalls.map((stall) => stall.toFixed(1)).join(", ")})`,
			);
			assert.equal(held.at(-1), 1);
		} finally {
			held = undefined;
		}
	},
);
