import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { runGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import {
	captureWorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import {
	loadSnapshotPathPolicy,
	SNAPSHOT_IGNORE_FILE,
} from "../../packages/coding-agent/src/core/worktree-snapshot/policy.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

function omittedBySnapshotIgnore(result: WorktreeSnapshotCapture): string[] {
	assert.equal(result.status, "captured");
	const { snapshot } = result as Extract<WorktreeSnapshotCapture, { status: "captured" }>;
	return snapshot.omitted.flatMap((omission) =>
		"path" in omission && omission.reason === "snapshot-ignore" ? [omission.path] : [],
	);
}

async function cloneWith(ignoreCase: boolean, rules: string): Promise<string> {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	await sandbox.git(clone, "config", "core.ignorecase", String(ignoreCase));
	sandbox.write(join(clone, SNAPSHOT_IGNORE_FILE), rules);
	return clone;
}

describe("snapshot-ignore matches as Git does (#5051)", () => {
	test("a rule matches case-sensitively when core.ignorecase is false (#5051)", async () => {
		const clone = await cloneWith(false, "Notes.txt\n");
		sandbox.write(join(clone, "notes.txt"), "kept\n");
		assert.deepEqual(omittedBySnapshotIgnore(await captureWorktreeSnapshot(clone)), []);
	});

	test("a case-sensitive negation does not re-include SECRET.LOG for `!*.log` (#5051)", async () => {
		const clone = await cloneWith(false, "*\n!*.log\n!.atomic/\n!.atomic/*\n");
		sandbox.write(join(clone, "SECRET.LOG"), "secret\n");
		sandbox.write(join(clone, "app.log"), "log\n");
		assert.deepEqual(omittedBySnapshotIgnore(await captureWorktreeSnapshot(clone)), ["SECRET.LOG"]);
	});

	test("a rule matches case-insensitively when core.ignorecase is true (#5051)", async () => {
		const clone = await cloneWith(true, "Notes.txt\n");
		sandbox.write(join(clone, "notes.txt"), "dropped\n");
		const omitted = omittedBySnapshotIgnore(await captureWorktreeSnapshot(clone));
		assert.deepEqual(omitted, ["notes.txt"]);
	});

	test("trailing spaces are stripped, so `build/ ` matches at any depth (#5051)", async () => {
		const clone = await cloneWith(false, "build/  \n");
		sandbox.write(join(clone, "x", "build", "b.txt"), "built\n");
		sandbox.write(join(clone, "build", "c.txt"), "built\n");
		const omitted = omittedBySnapshotIgnore(await captureWorktreeSnapshot(clone));
		assert.deepEqual(omitted, ["build/c.txt", "x/build/b.txt"]);
	});
});

/** Deterministic PRNG so a differential failure reproduces from its seed. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PATTERNS = [
	"a",
	"A",
	"*",
	"!*",
	"*.log",
	"!*.log",
	"build/",
	"build/ ",
	"build/   ",
	"/build",
	"a/",
	"a/ ",
	"**/b",
	"a/**",
	"a/**/b",
	"**",
	"**/",
	"!a",
	"!build/",
	"\\#e",
	"#e",
	"\\!f",
	"g\\ ",
	"g\\  ",
	"g ",
	"\\ ",
	" a",
	"a\t",
	"\\[h\\]",
	"[h]",
	"\\*i",
	"*i",
	"n\\?",
	"a b",
	"b/*",
	"/a/b",
	"x.log/",
	"*/b",
	"a*/",
	"[a-b]",
	"[!a]",
	"[A-Z]*",
	"x.LOG",
	"Notes.txt",
];
const BASE_NAMES = ["a", "b", "A", "x.log", "X.LOG", "build", "Build", "a b", "#e", "!f", "g ", "[h]", "*i", "n?"];
// Git for Windows reads `\` in a path as a separator, so names holding one are only portable elsewhere.
const NAMES = process.platform === "win32" ? BASE_NAMES : [...BASE_NAMES, "c\\d"];

async function gitIgnored(repo: string, ignoreCase: boolean, paths: readonly string[]): Promise<Set<string>> {
	const { stdout } = await runGit(
		["-c", `core.ignorecase=${ignoreCase}`, "check-ignore", "--no-index", "--stdin", "-z"],
		{ cwd: repo, input: `${paths.join("\0")}\0`, allowExitCodes: [1] },
	);
	return new Set(stdout.toString("utf8").split("\0").filter(Boolean));
}

describe("snapshot-ignore agrees with git check-ignore on random rules and paths (#5051)", () => {
	for (const ignoreCase of [false, true]) {
		test(`core.ignorecase=${ignoreCase} (#5051)`, async () => {
			const random = mulberry32(ignoreCase ? 5051 : 1505);
			const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
			const policyRepo = sandbox.path("policy");
			const gitRepo = sandbox.path("git");
			await sandbox.git(sandbox.root, "init", "-q", policyRepo);
			await sandbox.git(sandbox.root, "init", "-q", gitRepo);
			await sandbox.git(policyRepo, "config", "core.ignorecase", String(ignoreCase));
			const disagreements: string[] = [];
			for (let round = 0; round < 150; round++) {
				const newline = pick(["\n", "\r\n"]);
				const lines = Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(PATTERNS));
				const rules = `${pick(["", "\uFEFF"])}${lines.join(newline)}${newline}`;
				const paths = [
					...new Set(
						Array.from({ length: 8 }, () =>
							Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(NAMES)).join("/"),
						),
					),
				];
				sandbox.write(join(policyRepo, SNAPSHOT_IGNORE_FILE), rules);
				sandbox.write(join(gitRepo, ".gitignore"), rules);
				const expected = await gitIgnored(gitRepo, ignoreCase, paths);
				const policy = await loadSnapshotPathPolicy(policyRepo);
				for (const path of paths) {
					const actual = policy.exclusion(path) === "snapshot-ignore";
					if (actual !== expected.has(path)) {
						disagreements.push(`${JSON.stringify(rules)} ${JSON.stringify(path)}: git ${expected.has(path)}`);
					}
				}
			}
			assert.deepEqual(disagreements, []);
		});
	}
});
