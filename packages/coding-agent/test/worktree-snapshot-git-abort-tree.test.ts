import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "vitest";
import { sleep } from "../../../test/helpers/runtime.js";
import { GitSandbox, gitConfigPath } from "../../../test/helpers/worktree-snapshot.js";
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
const { openSync, writeFileSync } = require("node:fs");
const [script, pidFile, role] = process.argv.slice(1);
if (role === "held") {
	openSync("held.txt", "w");
	writeFileSync(pidFile, String(process.pid));
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
		const held = Number(readFileSync(pidFile, "utf8"));
		try {
			controller.abort(new Error("stopped"));
			await assert.rejects(running, /stopped/);
			assert.throws(() => process.kill(held, 0), "the process left holding a file in the checkout has ended");
			renameSync(checkout, sandbox.path("checkout-moved"));
		} finally {
			try {
				process.kill(held);
			} catch {}
		}
	},
);
