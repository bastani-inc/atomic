import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterAll, beforeEach, test } from "vitest";
import { resetSessionTempDirStateForTesting } from "../../packages/coding-agent/src/core/tools/session-temp-dir.ts";
import { getArtifactsDir } from "../../packages/subagents/src/shared/artifacts.js";

const envKeys = ["TMPDIR", "TEMP", "TMP", "XDG_RUNTIME_DIR", "ATOMIC_CODING_AGENT_DIR"] as const;
const savedEnv = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-subagents-private-")));
let agentDir = "";

beforeEach(() => {
	// Stand-ins for the shared temp directory and this account's agent directory; no runtime directory.
	const scratch = mkdtempSync(join(sandbox, "case-"));
	for (const key of ["TMPDIR", "TEMP", "TMP"]) process.env[key] = scratch;
	agentDir = join(scratch, "home", "agent");
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	delete process.env.XDG_RUNTIME_DIR;
	resetSessionTempDirStateForTesting();
});

afterAll(() => {
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

test.skipIf(process.platform === "win32")(
	"session-less subagent artifacts use a directory only the current user owns",
	async () => {
		const dir = await getArtifactsDir(null);

		assert.ok(isInside(agentDir, dir), `${dir} is inside the account's agent directory`);
		for (let current = dir; isInside(join(agentDir, "cache"), current); current = dirname(current)) {
			const stat = lstatSync(current);
			assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), current);
			assert.equal(stat.uid, process.getuid!(), current);
			assert.equal(stat.mode & 0o077, 0, `${current} has no group or other access`);
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a symbolic link planted at the session-less artifact directory is not followed",
	async () => {
		const elsewhere = join(sandbox, `planted-${Date.now()}`);
		mkdirSync(elsewhere, { mode: 0o700 });
		mkdirSync(join(agentDir, "cache", "tmp", "subagents"), { recursive: true, mode: 0o700 });
		symlinkSync(elsewhere, join(agentDir, "cache", "tmp", "subagents", "artifacts"), "dir");

		const dir = await getArtifactsDir(null);

		assert.ok(!isInside(join(agentDir, "cache"), dir), `${dir} avoids the planted link`);
		assert.ok(lstatSync(dir).isDirectory());
		assert.deepEqual(readdirSync(elsewhere), [], "nothing is created through the planted link");
	},
);
