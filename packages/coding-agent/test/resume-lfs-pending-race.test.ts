/**
 * Two processes that finish one worktree's pending LFS download at once (#5099, #5193), as two resumes of one restored
 * worktree do once the process downloading into it died. Real processes; each is held at one point through the file
 * system calls of the module that finishes the download.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { thisProcess } from "../src/core/worktree-snapshot/process-holder.js";

const RESTORE = fileURLToPath(new URL("../src/core/worktree-snapshot/restore.ts", import.meta.url));
/** How long another process may take to start, pause or report. */
const CHILD_TIMEOUT_MS = 60_000;

let sandbox: GitSandbox;
const children: ChildProcess[] = [];

beforeEach(() => {
	sandbox = new GitSandbox();
});

afterEach(() => {
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
	sandbox.dispose();
});

/** The id of a process that has exited. */
function exitedPid(): number {
	const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
		encoding: "utf8",
	});
	return Number(exited.stdout);
}

const log = () => sandbox.path("events.log");
const events = () => (existsSync(log()) ? readFileSync(log(), "utf8").trim().split("\n") : []);

/** Where another process finishing the download is held. */
type HoldAt =
	/** Having read the mark, as it judges whether the process it names still runs. */
	| "judging"
	/** Once it named itself in the mark, while its Git holds `index.lock`, as the Git steps of a download do. */
	| "downloading";

interface Finisher {
	paused(): boolean;
	resume(): void;
	/** The files that still hold pointers once its download finished, or how it failed. */
	outcome(): string | undefined;
}

/**
 * Starts another process that finishes the download pending in `clone`, held at `holdAt`. It logs `<name> reads`
 * each time it reads the mark, `<name> names itself` when it writes the mark, and `<name> removes <lock>` for each of
 * Git's locks it removes.
 */
function finisher(
	name: string,
	clone: string,
	paths: { readonly mark: string; readonly indexLock: string },
	holdAt: HoldAt,
): Finisher {
	const base = sandbox.path(`${name}-${randomUUID()}`);
	const shim = `${base}.fs.mjs`;
	writeFileSync(
		shim,
		`
		import * as fs from "node:fs/promises";
		import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
		import { basename, resolve } from "node:path";
		export * from "node:fs/promises";
		const mark = ${JSON.stringify(paths.mark)};
		const indexLock = ${JSON.stringify(paths.indexLock)};
		const event = (what) => appendFileSync(${JSON.stringify(log())}, ${JSON.stringify(name)} + " " + what + "\\n");
		let held = false;
		const hold = (at) => {
			if (held || at !== ${JSON.stringify(holdAt)}) return false;
			held = true;
			writeFileSync(${JSON.stringify(`${base}.paused`)}, at);
			while (!existsSync(${JSON.stringify(`${base}.go`)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			return true;
		};
		const isMark = (path) => resolve(String(path)) === mark;
		// The mark is written beside it and renamed over it.
		const isPartialMark = (path) => resolve(String(path)).startsWith(mark + ".");
		const namingItself = new Set();
		const named = () => {
			event("names itself");
			if (held || ${JSON.stringify(holdAt)} !== "downloading") return;
			writeFileSync(indexLock, "");
			hold("downloading");
			rmSync(indexLock, { force: true });
		};
		export const readFile = async (path, ...rest) => {
			if (isMark(path)) event("reads");
			return fs.readFile(path, ...rest);
		};
		export const stat = async (path, ...rest) => {
			if (isMark(path)) hold("judging");
			return fs.stat(path, ...rest);
		};
		export const writeFile = async (path, data, ...rest) => {
			await fs.writeFile(path, data, ...rest);
			if (!(isMark(path) || isPartialMark(path)) || JSON.parse(String(data)).holder?.pid !== process.pid) return;
			if (isMark(path)) named();
			else namingItself.add(resolve(String(path)));
		};
		export const rename = async (from, to, ...rest) => {
			await fs.rename(from, to, ...rest);
			if (isMark(to) && namingItself.delete(resolve(String(from)))) named();
		};
		export const rm = async (path, ...rest) => {
			if (/(HEAD|index)\\.lock$/.test(String(path))) event("removes " + basename(String(path)));
			return fs.rm(path, ...rest);
		};
		export default { ...fs, readFile, stat, writeFile, rename, rm };
	`,
	);
	const script = `
		import { readFileSync, renameSync, writeFileSync } from "node:fs";
		Bun.plugin({
			setup(build) {
				build.onLoad({ filter: /[\\\\/](worktree-snapshot[\\\\/]restore|rename-retry)\\.ts$/ }, (args) => ({
					loader: "ts",
					contents: readFileSync(args.path, "utf8").replaceAll('from "node:fs/promises"', ${JSON.stringify(`from ${JSON.stringify(pathToFileURL(shim).href)}`)}),
				}));
			},
		});
		let outcome;
		try {
			const { pendingLfsDownload } = await import(${JSON.stringify(RESTORE)});
			const pull = await pendingLfsDownload(${JSON.stringify(clone)});
			outcome = JSON.stringify(pull === undefined ? "nothing pending" : await pull());
		} catch (error) {
			outcome = String(error?.message ?? error);
		}
		// Whole or not at all: a report read while it is being written would read as empty or partial text.
		writeFileSync(${JSON.stringify(`${base}.json.tmp`)}, outcome);
		renameSync(${JSON.stringify(`${base}.json.tmp`)}, ${JSON.stringify(`${base}.json`)});
	`;
	children.push(
		spawn("bun", ["--eval", script], { stdio: "ignore", env: { ...process.env, ...sandbox.executable.env } }),
	);
	return {
		paused: () => existsSync(`${base}.paused`),
		resume: () => writeFileSync(`${base}.go`, ""),
		outcome: () => (existsSync(`${base}.json`) ? readFileSync(`${base}.json`, "utf8") : undefined),
	};
}

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + CHILD_TIMEOUT_MS;
	while (!condition()) {
		assert.ok(Date.now() < deadline, `${what}; events: ${JSON.stringify(events())}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("two processes finishing one pending LFS download (#5193)", () => {
	test(
		"a process that judged the dead holder stopped leaves the download, and Git's locks, to the process that took it over first",
		async () => {
			const { clone, remote } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
			const gitPath = async (name: string) =>
				resolve(clone, await sandbox.git(clone, "rev-parse", "--path-format=absolute", "--git-path", name));
			const head = await sandbox.git(clone, "rev-parse", "HEAD");
			const tree = await sandbox.git(clone, "rev-parse", "HEAD^{tree}");
			const paths = { mark: await gitPath("atomic-lfs-pending.json"), indexLock: await gitPath("index.lock") };
			// The process downloading died during its Git steps, leaving their locks.
			const holder = { ...(await thisProcess()), pid: exitedPid() };
			writeFileSync(paths.mark, JSON.stringify({ head, tree, remotes: [remote], holder }));
			writeFileSync(paths.indexLock, "");
			writeFileSync(await gitPath("HEAD.lock"), "");

			const late = finisher("late", clone, paths, "judging");
			await until(() => late.paused(), "the late process read the mark naming the dead holder");
			const first = finisher("first", clone, paths, "downloading");
			await until(() => first.paused(), "the first process took the download over and its Git holds index.lock");
			const before = events().length;
			late.resume();
			// Either it takes the download over too, naming itself, or it reads the mark again, waiting.
			await until(
				() =>
					events()
						.slice(before)
						.some((event) => event === "late names itself" || event === "late reads"),
				"the late process went on",
			);
			assert.equal(existsSync(paths.indexLock), true, "the lock the first process's Git holds is left to it");
			assert.deepEqual(
				events().filter((event) => event.startsWith("late removes") || event === "late names itself"),
				[],
				"the late process takes nothing over",
			);

			first.resume();
			await until(() => first.outcome() !== undefined && late.outcome() !== undefined, "both processes finished");
			assert.deepEqual([first.outcome(), late.outcome()], ["[]", "[]"]);
			assert.equal(existsSync(paths.mark), false, "nothing is pending once the download finished");
			assert.equal(await sandbox.git(clone, "rev-parse", "HEAD"), head);
		},
		3 * CHILD_TIMEOUT_MS,
	);
});
