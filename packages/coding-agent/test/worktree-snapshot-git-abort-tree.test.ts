import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "vitest";
import { isGone, recordProcess, signalRecordedProcess } from "../../../test/helpers/recorded-process.js";
import { sleep } from "../../../test/helpers/runtime.js";
import { GitSandbox, gitConfigPath } from "../../../test/helpers/worktree-snapshot.js";
import { renameWithRetry } from "../src/core/rename-retry.ts";
import { runGit } from "../src/core/worktree-snapshot/git.ts";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => {
	sandbox.dispose();
});

const HOLDER = `
const { spawn } = require("node:child_process");
const { openSync, renameSync, writeFileSync } = require("node:fs");
const [script, pidFile, role] = process.argv.slice(1);
if (role === "held") {
	openSync("held.txt", "w");
	writeFileSync(pidFile + ".tmp", String(process.pid));
	renameSync(pidFile + ".tmp", pidFile);
	setInterval(() => {}, 1000);
} else if (role === "starter") {
	spawn(process.execPath, [script, pidFile, "held"], { detached: true, stdio: "ignore" }).unref();
} else {
	spawn(process.execPath, [script, pidFile, "starter"], { stdio: "ignore" });
	setInterval(() => {}, 1000);
}
`;

test.skipIf(process.platform !== "win32")(
	"an aborted Git command rejects once every process it started has ended, even one whose parent ended first",
	async () => {
		const checkout = sandbox.path("checkout");
		mkdirSync(checkout);
		await sandbox.git(checkout, "init", "-q");
		const script = sandbox.path("holder.cjs");
		const pidFile = sandbox.path("holder.pid");
		writeFileSync(script, HOLDER);
		const alias = `alias.hold=!"${gitConfigPath(process.execPath)}" "${gitConfigPath(script)}" "${gitConfigPath(pidFile)}"`;
		const controller = new AbortController();
		const running = runGit(["-c", alias, "hold"], { cwd: checkout, signal: controller.signal });
		running.catch(() => {});
		for (let waited = 0; !existsSync(pidFile) && waited < 30_000; waited += 20) await sleep(20);
		// #6125: recorded while it holds the file, so neither the assertion nor the cleanup takes a later process for it.
		const held = await recordProcess(Number(readFileSync(pidFile, "utf8")));
		try {
			controller.abort(new Error("stopped"));
			await assert.rejects(running, /stopped/);
			assert.equal(await isGone(held), true, "the process left holding a file in the checkout has ended");
			await renameWithRetry(checkout, sandbox.path("checkout-moved"), { budgetMs: 10_000 });
		} finally {
			await signalRecordedProcess(held, "SIGTERM");
		}
	},
);
