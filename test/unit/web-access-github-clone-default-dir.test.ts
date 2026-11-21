import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";
import { resetSessionTempDirStateForTesting } from "../../packages/coding-agent/src/core/tools/session-temp-dir.ts";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

type Callback = (error: Error | null, stdout?: string) => void;

/** `gh`/`git` launches are faked: the fake clone only writes inside the per-test directory. */
const boundary = vi.hoisted(() => ({ configPath: "", sandbox: "", calls: [] as string[][] }));

// The faked `gh` and `git` are found under their own names, as programs on PATH would be.
vi.mock("@bastani/atomic-tui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@bastani/atomic-tui")>()),
	findHelperExecutableAsync: async (name: string) => name,
	helperLaunchAsync: async (name: string) => ({ file: name }),
}));

vi.mock("node:child_process", async (importOriginal) => {
	// Everything else stays real (the Windows ownership check reads ACLs through it).
	const actual = await importOriginal<typeof import("node:child_process")>();
	const execFile = (_command: string, args: string[], _options: object, callback: Callback) => {
		boundary.calls.push(args);
		queueMicrotask(() => {
			if (args[0] === "--version") return callback(null, "gh version 2");
			if (args[0] === "repo" && args[1] === "clone") {
				const target = args[3]!;
				if (!target.startsWith(`${boundary.sandbox}${sep}`)) return callback(new Error("outside sandbox"));
				mkdirSync(target, { recursive: true });
				writeFileSync(join(target, "README.md"), "Repository readme");
				return callback(null, "");
			}
			return callback(new Error("offline"), "");
		});
		return Object.assign(new EventEmitter(), { kill: () => true });
	};
	const spawn = (command: string, args: string[] = [], options: object = {}) => {
		if (command !== "gh" && command !== "git") return actual.spawn(command, args, options);
		const child = Object.assign(new EventEmitter(), { kill: () => true });
		execFile(command, args, options, (err) => {
			child.emit("exit", err ? 1 : 0, null);
			child.emit("close", err ? 1 : 0, null);
		});
		return child;
	};
	return { ...actual, execFile, spawn };
});
vi.mock("../../packages/web-access/config-paths.ts", () => ({ findReadableConfigPath: () => boundary.configPath }));

const suiteDirectory = makeTempDirectory("web-gh-default-dir-suite-");
boundary.configPath = join(suiteDirectory, "web-search.json");
const { clearCloneCache, extractGitHub } = await import("../../packages/web-access/github-extract.js");
const { loadGitHubConfig } = await import("../../packages/web-access/github-config.js");

const envKeys = ["TMPDIR", "TEMP", "TMP", "XDG_RUNTIME_DIR", "ATOMIC_CODING_AGENT_DIR"] as const;
const savedEnv = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));
let agentDir = "";

afterAll(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	removeTempDirectory(suiteDirectory);
});

beforeEach(async () => {
	// Stand-ins for the shared temp directory and this account's agent directory; no runtime directory.
	boundary.sandbox = realpathSync(mkdtempSync(join(suiteDirectory, "case-")));
	const shared = join(boundary.sandbox, "tmp");
	mkdirSync(shared);
	for (const key of ["TMPDIR", "TEMP", "TMP"]) process.env[key] = shared;
	agentDir = join(boundary.sandbox, "home", "agent");
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	delete process.env.XDG_RUNTIME_DIR;
	boundary.calls = [];
	writeFileSync(boundary.configPath, JSON.stringify({ githubClone: {} }));
	resetSessionTempDirStateForTesting();
	await clearCloneCache();
});

afterEach(async () => {
	await clearCloneCache();
	resetSessionTempDirStateForTesting();
});

function cloneTargets(): string[] {
	return boundary.calls.filter((args) => args[0] === "repo" && args[1] === "clone").map((args) => args[3]!);
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

/** The default clone path, asserted to be inside this test's directory before anything touches it. */
async function sandboxedDefaultClonePath(): Promise<string> {
	const { clonePath } = await loadGitHubConfig();
	assert.ok(isInside(boundary.sandbox, clonePath), `${clonePath} must stay inside the test directory`);
	return clonePath;
}

test("the GitHub clone cache defaults to a directory only the current user owns", async () => {
	const clonePath = await sandboxedDefaultClonePath();
	assert.ok(isInside(agentDir, clonePath), `${clonePath} is inside the account's agent directory`);

	const result = await extractGitHub("https://github.com/octo/widgets", undefined, true);
	assert.equal(result?.error, null, JSON.stringify({ result, calls: boundary.calls, clonePath }));
	assert.equal(cloneTargets().length, 1);
	assert.ok(isInside(clonePath, cloneTargets()[0]!));
	if (process.platform !== "win32") {
		for (let dir = clonePath; isInside(agentDir, dir); dir = dirname(dir)) {
			const stat = statSync(dir);
			assert.equal(stat.uid, process.getuid!(), dir);
			assert.equal(stat.mode & 0o077, 0, `${dir} has no group or other access`);
		}
	}
});

test.skipIf(process.platform === "win32")(
	"a symbolic link planted at the default clone cache is not followed",
	async () => {
		const elsewhere = join(boundary.sandbox, "planted");
		mkdirSync(elsewhere, { mode: 0o700 });
		mkdirSync(join(agentDir, "cache", "tmp"), { recursive: true, mode: 0o700 });
		chmodSync(join(agentDir, "cache", "tmp"), 0o700);
		symlinkSync(elsewhere, join(agentDir, "cache", "tmp", "github-repos"), "dir");

		const clonePath = await sandboxedDefaultClonePath();
		const result = await extractGitHub("https://github.com/octo/widgets", undefined, true);

		assert.equal(result?.error, null);
		assert.ok(!isInside(join(agentDir, "cache"), clonePath), `${clonePath} avoids the planted link`);
		assert.deepEqual(readdirSync(elsewhere), [], "nothing is cloned through the planted link");
	},
);

test.skipIf(process.platform === "win32")(
	"a default clone cache opened up after it was chosen is refused",
	async () => {
		const clonePath = await sandboxedDefaultClonePath();
		chmodSync(clonePath, 0o770);

		await extractGitHub("https://github.com/octo/widgets", undefined, true);
		assert.deepEqual(cloneTargets(), []);
		assert.equal(statSync(clonePath).mode & 0o777, 0o770);
	},
);
