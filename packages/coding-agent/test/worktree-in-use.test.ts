import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { processesWorkIn } from "../src/core/worktree-snapshot/in-use.ts";

let dir: string;
let path: string | undefined;

beforeEach(() => {
	// The real path, as lsof lists it: on macOS the temporary directory is under /var, a link to /private/var.
	dir = realpathSync(mkdtempSync(join(tmpdir(), "atomic-in-use-")));
	mkdirSync(join(dir, "worktree"));
	mkdirSync(join(dir, "bin"));
	path = process.env.PATH;
});

afterEach(() => {
	process.env.PATH = path;
	rmSync(dir, { recursive: true, force: true });
});

const worktree = () => join(dir, "worktree");

/** An `lsof` first on PATH that prints `output` and exits with `status`, as macOS's would list the user's open files. */
function lsofListing(output: string, status = 0): void {
	const listing = join(dir, "listing.txt");
	writeFileSync(listing, output);
	const lsof = join(dir, "bin", "lsof");
	writeFileSync(lsof, `#!/bin/sh\ncat '${listing}'\nexit ${status}\n`);
	chmodSync(lsof, 0o755);
	process.env.PATH = `${join(dir, "bin")}${delimiter}${path ?? ""}`;
}

describe.skipIf(process.platform === "win32")(
	"whether a process works in a set-aside worktree on macOS (#5379)",
	() => {
		test("a process whose working directory is inside it keeps it (#5379)", async () => {
			lsofListing(`p101\nfcwd\nn${worktree()}\nf3\nn/dev/null\n`);
			assert.equal(await processesWorkIn(worktree(), "darwin"), true);
		});

		test("a complete listing with nothing inside it lets it go (#5379)", async () => {
			lsofListing(`p101\nfcwd\nn${dir}\nf3\nn/dev/null\n`);
			assert.equal(await processesWorkIn(worktree(), "darwin"), false);
		});

		test("a listing that ends with an error counts as in use, whatever it lists (#5379)", async () => {
			lsofListing(`p101\nfcwd\nn${dir}\n`, 1);
			assert.equal(await processesWorkIn(worktree(), "darwin"), true);
		});

		for (const unreadable of [
			"cwd|rtd info error: Operation not permitted",
			"FD info error: Operation not permitted",
		]) {
			test(`a process whose files cannot be read (${unreadable.split(" info")[0]}) counts as in use (#5379)`, async () => {
				lsofListing(`p101\nfcwd\nn${dir}\np202\nfNOFD\nn${unreadable}\n`);
				assert.equal(await processesWorkIn(worktree(), "darwin"), true);
			});
		}
	},
);

const python = spawnSync("python3", ["-c", "import ctypes"], { stdio: "ignore" }).status === 0;

describe.skipIf(process.platform !== "linux" || !python)(
	"whether a process works in a set-aside worktree on Linux (#5379)",
	() => {
		test("a process of this user that cannot be read keeps it, however long before the cancelled build it started (#5379)", async () => {
			const ready = join(dir, "ready");
			// A process that makes itself non-dumpable, so its working directory and open files cannot be read, then waits there.
			const child = spawn(
				"python3",
				[
					"-c",
					`import ctypes, time, pathlib\nctypes.CDLL(None).prctl(4, 0, 0, 0, 0)\npathlib.Path(${JSON.stringify(ready)}).write_text("")\ntime.sleep(60)`,
				],
				{ cwd: worktree(), stdio: "ignore" },
			);
			try {
				while (!existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 20));
				await new Promise((resolve) => setTimeout(resolve, 2_200));
				assert.equal(await processesWorkIn(worktree()), true);
			} finally {
				child.kill("SIGKILL");
			}
		});
	},
);
