import assert from "node:assert/strict";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, test } from "vitest";

// The session-less artifact directory is fixed at import from the temp directory, so point it at a sandbox first.
const savedEnv = new Map(["TMPDIR", "TEMP", "TMP"].map((key) => [key, process.env[key]]));
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-subagents-private-")));
for (const key of savedEnv.keys()) process.env[key] = sandbox;
const { ensureArtifactsDir, getArtifactsDir } = await import("../../packages/subagents/src/shared/artifacts.js");
/** The per-user default, resolved before any test tampers with it. */
const defaultDir = getArtifactsDir(null);

afterAll(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(sandbox, { recursive: true, force: true });
});

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

test.skipIf(process.platform === "win32")(
	"session-less subagent artifacts use a directory only the current user owns",
	() => {
		const dir = defaultDir;
		assert.ok(isInside(sandbox, dir), `${dir} is inside the temp directory`);

		ensureArtifactsDir(dir);
		for (let current = dir; isInside(sandbox, current); current = join(current, "..")) {
			const stat = lstatSync(current);
			assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), current);
			assert.equal(stat.uid, process.getuid!(), current);
			assert.equal(stat.mode & 0o077, 0, `${current} has no group or other access`);
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a symbolic link in place of the session-less artifact directory is refused",
	() => {
		const dir = defaultDir;
		rmSync(dir, { recursive: true, force: true });
		const elsewhere = join(sandbox, "planted");
		mkdirSync(elsewhere, { mode: 0o700 });
		writeFileSync(join(elsewhere, "keep.txt"), "keep");
		symlinkSync(elsewhere, dir, "dir");

		assert.throws(() => ensureArtifactsDir(dir), /symbolic link/);
		assert.equal(statSync(join(elsewhere, "keep.txt")).isFile(), true);
	},
);

test.skipIf(process.platform === "win32")(
	"a shared session-less artifact directory is replaced by a fresh private one",
	() => {
		const dir = defaultDir;
		chmodSync(dir, 0o775);

		const used = getArtifactsDir(null);
		assert.notEqual(used, dir);
		assert.equal(statSync(used).uid, process.getuid!());
		assert.equal(statSync(used).mode & 0o077, 0);
		assert.equal(statSync(dir).mode & 0o777, 0o775, "the refused directory is left as found");
		rmSync(used, { recursive: true, force: true });
	},
);
