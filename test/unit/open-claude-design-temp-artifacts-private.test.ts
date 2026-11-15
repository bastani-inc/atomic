import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { resetSessionTempDirStateForTesting } from "../../packages/coding-agent/src/core/tools/session-temp-dir.ts";
import { prepareArtifactDir } from "../../packages/workflows/builtin/open-claude-design-utils.js";

const envKeys = ["TMPDIR", "TEMP", "TMP", "XDG_RUNTIME_DIR", "ATOMIC_CODING_AGENT_DIR"] as const;
const savedEnv = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));
let sandbox = "";

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-ocd-private-")));
	for (const key of ["TMPDIR", "TEMP", "TMP"]) process.env[key] = sandbox;
	// This account's agent directory stand-in; no runtime directory.
	process.env.ATOMIC_CODING_AGENT_DIR = join(sandbox, "home", "agent");
	delete process.env.XDG_RUNTIME_DIR;
	resetSessionTempDirStateForTesting();
});

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetSessionTempDirStateForTesting();
	rmSync(sandbox, { recursive: true, force: true });
});

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

test.skipIf(process.platform === "win32")("temp design artifacts use a directory only the current user owns", () => {
	const { artifactDir } = prepareArtifactDir(sandbox);
	assert.ok(isInside(sandbox, artifactDir), `${artifactDir} is inside the temp directory`);
	for (let dir = dirname(artifactDir); isInside(sandbox, dir); dir = dirname(dir)) {
		const stat = statSync(dir);
		assert.equal(stat.uid, process.getuid!(), dir);
		assert.equal(stat.mode & 0o077, 0, `${dir} has no group or other access`);
	}
});

test.skipIf(process.platform === "win32")(
	"a symbolic link in place of the temp design directory is not written through",
	() => {
		const { artifactDir: probe } = prepareArtifactDir(sandbox);
		const base = dirname(probe);
		rmSync(base, { recursive: true, force: true });
		const elsewhere = join(sandbox, "planted");
		mkdirSync(elsewhere, { mode: 0o700 });
		symlinkSync(elsewhere, base, "dir");

		prepareArtifactDir(sandbox);
		assert.deepEqual(readdirSync(elsewhere), [], "nothing is created through the planted link");
	},
);
