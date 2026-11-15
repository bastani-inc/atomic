import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";
import { resetSessionTempDirStateForTesting } from "../../packages/coding-agent/src/core/tools/session-temp-dir.ts";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

type Callback = (error: Error | null, stdout?: string) => void;

/** Every process launch is faked: the fake clone only writes inside the per-test temp directory. */
const boundary = vi.hoisted(() => ({ configPath: "", sandbox: "", calls: [] as string[][] }));

vi.mock("node:child_process", () => ({
	execFile: (_command: string, args: string[], _options: object, callback: Callback) => {
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
	},
}));
vi.mock("../../packages/web-access/config-paths.ts", () => ({ findReadableConfigPath: () => boundary.configPath }));

const suiteDirectory = makeTempDirectory("web-gh-default-dir-suite-");
boundary.configPath = join(suiteDirectory, "web-search.json");
const { clearCloneCache, extractGitHub } = await import("../../packages/web-access/github-extract.js");
const { loadGitHubConfig } = await import("../../packages/web-access/github-config.js");

const envKeys = ["TMPDIR", "TEMP", "TMP"] as const;
const savedEnv = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));

afterAll(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	removeTempDirectory(suiteDirectory);
});

beforeEach(() => {
	// A private stand-in for the shared system temp directory; the default clone cache lives below it.
	boundary.sandbox = realpathSync(mkdtempSync(join(suiteDirectory, "tmp-")));
	for (const key of envKeys) process.env[key] = boundary.sandbox;
	boundary.calls = [];
	writeFileSync(boundary.configPath, JSON.stringify({ githubClone: {} }));
	resetSessionTempDirStateForTesting();
	clearCloneCache();
});

/** The default clone path, asserted to be inside this test's temp directory before anything touches it. */
function sandboxedDefaultClonePath(): string {
	const { clonePath } = loadGitHubConfig();
	assert.ok(isInside(boundary.sandbox, clonePath), `${clonePath} must follow the temp directory`);
	return clonePath;
}

afterEach(() => {
	clearCloneCache();
	resetSessionTempDirStateForTesting();
});

function cloneTargets(): string[] {
	return boundary.calls.filter((args) => args[0] === "repo" && args[1] === "clone").map((args) => args[3]!);
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

/** The per-user directory directly below the temp directory that holds the default clone cache. */
function perUserRoot(clonePath: string): string {
	let dir = clonePath;
	while (dirname(dir) !== tmpdir()) dir = dirname(dir);
	return dir;
}

test("the GitHub clone cache defaults to a directory only the current user owns", async () => {
	const clonePath = sandboxedDefaultClonePath();

	const result = await extractGitHub("https://github.com/octo/widgets", undefined, true);
	assert.equal(result?.error, null);
	assert.equal(cloneTargets().length, 1);
	assert.ok(isInside(clonePath, cloneTargets()[0]!));
	if (process.platform !== "win32") {
		for (const dir of [perUserRoot(clonePath), clonePath]) {
			const stat = statSync(dir);
			assert.equal(stat.uid, process.getuid!(), dir);
			assert.equal(stat.mode & 0o077, 0, `${dir} has no group or other access`);
		}
	}
});

test.skipIf(process.platform === "win32")(
	"a symbolic link in place of the default clone cache is refused",
	async () => {
		const clonePath = sandboxedDefaultClonePath();
		const elsewhere = join(boundary.sandbox, "planted");
		mkdirSync(elsewhere, { mode: 0o700 });
		mkdirSync(dirname(clonePath), { recursive: true, mode: 0o700 });
		symlinkSync(elsewhere, clonePath, "dir");

		await extractGitHub("https://github.com/octo/widgets", undefined, true);
		assert.deepEqual(cloneTargets(), []);
	},
);

test.skipIf(process.platform === "win32")("a group-writable default clone cache is refused", async () => {
	const clonePath = sandboxedDefaultClonePath();
	mkdirSync(clonePath, { recursive: true, mode: 0o700 });
	chmodSync(clonePath, 0o770);

	await extractGitHub("https://github.com/octo/widgets", undefined, true);
	assert.deepEqual(cloneTargets(), []);
	assert.equal(statSync(clonePath).mode & 0o777, 0o770);
});
