import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { cpSync, existsSync, mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";
import { fileExists, makeTempDirectory, readText, removeTempDirectory } from "../helpers/runtime.js";

/** Junctions need no extra privileges on Windows. */
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

type Callback = (error: Error | null, stdout?: string) => void;

/**
 * Every process launch is faked: nothing here runs `gh` or `git`, and the fake
 * clone only writes inside the per-test sandbox.
 */
const boundary = vi.hoisted(() => ({
	configPath: "",
	sandbox: "",
	calls: [] as string[][],
	files: {} as Record<string, string>,
	failClone: false,
	/** `gh api` output keyed by `<endpoint> <jq filter>`; any other request fails. */
	api: {} as Record<string, string>,
}));

vi.mock("node:child_process", () => ({
	execFile: (_command: string, args: string[], _options: object, callback: Callback) => {
		boundary.calls.push(args);
		queueMicrotask(() => {
			if (args[0] === "--version") return callback(null, "gh version 2");
			if (args[0] === "repo" && args[1] === "clone") {
				const target = args[3]!;
				if (!target.startsWith(`${boundary.sandbox}${sep}`)) return callback(new Error("outside sandbox"));
				for (const [name, content] of Object.entries(boundary.files)) {
					mkdirSync(dirname(join(target, name)), { recursive: true });
					writeFileSync(join(target, name), content);
				}
				return callback(boundary.failClone ? new Error("clone failed") : null, "");
			}
			const output = boundary.api[`${args[1]} ${args[3]}`];
			return output === undefined ? callback(new Error("offline"), "") : callback(null, output);
		});
		return Object.assign(new EventEmitter(), { kill: () => true });
	},
}));
vi.mock("../../packages/web-access/config-paths.ts", () => ({ findReadableConfigPath: () => boundary.configPath }));

// The config path is read once at import, so it must point into a temp directory before the import.
const suiteDirectory = makeTempDirectory("web-gh-confine-suite-");
boundary.configPath = join(suiteDirectory, "web-search.json");
const { clearCloneCache, extractGitHub, parseGitHubUrl } = await import("../../packages/web-access/github-extract.js");
const { checkRepoSize, fetchViaApi } = await import("../../packages/web-access/github-api.js");
const { loadGitHubConfig } = await import("../../packages/web-access/github-config.js");

afterAll(() => removeTempDirectory(suiteDirectory));

let sandbox = "";
let clonePath = "";
let victim = "";

beforeEach(() => {
	sandbox = makeTempDirectory("web-gh-confine-");
	clonePath = join(sandbox, "clones");
	victim = join(sandbox, "victim");
	mkdirSync(clonePath);
	mkdirSync(victim);
	writeFileSync(join(victim, "keep.txt"), "keep");
	boundary.sandbox = sandbox;
	boundary.calls = [];
	boundary.files = { "README.md": "Repository readme", "src/a.ts": "export const a = 1;\n" };
	boundary.failClone = false;
	boundary.api = {};
	writeFileSync(boundary.configPath, JSON.stringify({ githubClone: { clonePath } }));
	clearCloneCache();
	// Never run against the default clone directory.
	assert.equal(loadGitHubConfig().clonePath, clonePath);
});

afterEach(() => {
	clearCloneCache();
	removeTempDirectory(sandbox);
});

function cloneTargets(): string[] {
	return boundary.calls.filter((args) => args[0] === "repo" && args[1] === "clone").map((args) => args[3]!);
}

function apiEndpoints(): string[] {
	return boundary.calls.filter((args) => args[0] === "api").map((args) => args[1]!);
}

function assertInside(root: string, path: string): void {
	const rel = relative(realpathSync(root), resolve(path));
	assert.ok(rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep), `${path} is not inside ${root}`);
}

test("rejects GitHub URLs whose owner, repo or ref escape the clone directory", () => {
	for (const url of [
		"https://github.com/%2E%2E%2Fvictim/repo",
		"https://github.com/..%2F..%2Fvictim/repo",
		"https://github.com/owner/...git",
		"https://github.com/owner/..git",
		"https://github.com/owner/..%2F..%2Fvictim",
		"https://github.com/owner/%2E%2E%2Fvictim",
		"https://github.com/owner/repo/tree/%2E%2E%2Fx",
		"https://github.com/owner/repo/tree/..%2F..%2Fvictim",
		"https://github.com/owner/repo/blob/..%2F..%2Fvictim/README.md",
		"https://github.com/owner/repo/tree/%2Fetc",
		"https://github.com/owner/repo/blob/main/%2E%2E%2F%2E%2E%2Fsecret",
		"https://github.com/owner/repo/blob/main/src/.%2Fsecret",
	]) {
		assert.throws(() => parseGitHubUrl(url), /Invalid GitHub URL/, url);
	}
});

test("accepts owners, repos and refs that GitHub and git allow", () => {
	assert.deepEqual(parseGitHubUrl("https://github.com/octo-org/widgets.js_2.git"), {
		owner: "octo-org",
		repo: "widgets.js_2",
		refIsFullSha: false,
		type: "root",
	});
	assert.deepEqual(parseGitHubUrl("https://github.com/octo/widgets/tree/feature%2Fx/src/lib"), {
		owner: "octo",
		repo: "widgets",
		ref: "feature/x",
		refIsFullSha: false,
		path: "src/lib",
		type: "tree",
	});
	assert.equal(parseGitHubUrl("https://github.com/octo/widgets/blob/v1.2.3/a.ts")?.ref, "v1.2.3");
	assert.equal(parseGitHubUrl("https://github.com/octo/widgets/tree/a%40b")?.ref, "a@b");
	assert.equal(parseGitHubUrl(`https://github.com/${"a".repeat(39)}/${"r".repeat(100)}`)?.repo, "r".repeat(100));
	assert.equal(parseGitHubUrl(`https://github.com/a/r/tree/${"x".repeat(255)}`)?.ref, "x".repeat(255));
	assert.equal(parseGitHubUrl("https://github.com/A1/B")?.owner, "A1");
	assert.equal(parseGitHubUrl("https://github.com/o/r/blob/main/..a/b..")?.path, "..a/b..");
	assert.equal(parseGitHubUrl("https://github.com/o/r/issues/1"), null);
	assert.equal(parseGitHubUrl("https://gitlab.com/o/r"), null);
});

test("rejects owners, repos and refs that GitHub and git do not allow", () => {
	const invalid = [
		"-octo/r",
		"octo-/r",
		"oc_to/r",
		"oc.to/r",
		"oc%20to/r",
		`${"a".repeat(40)}/r`,
		"o/r%20x",
		"o/r%2Fx",
		`o/${"r".repeat(101)}`,
		"o/.git",
		...[
			"a..b",
			"%2Fa",
			"a%2F",
			"a%2F%2Fb",
			"a%01b",
			"a%7Fb",
			"a@%7Bb",
			"a.lock",
			"a%2F.b",
			".a",
			"a.",
			"%40",
			"a%20b",
			"a~b",
			"a%5Eb",
			"a:b",
			"a%3Fb",
			"a*b",
			"a[b",
			"a%5Cb",
			"-a",
			`${"x".repeat(256)}`,
			"a%2Fb.lock%2Fc",
		].map((ref) => `o/r/tree/${ref}`),
	];
	for (const path of invalid) {
		assert.throws(() => parseGitHubUrl(`https://github.com/${path}`), /Invalid GitHub URL/, path);
	}
});

test("an escaping GitHub URL reports an error and removes nothing outside the clone directory", async () => {
	const sibling = join(sandbox, "sibling");
	mkdirSync(sibling);
	writeFileSync(join(sibling, "keep.txt"), "keep");
	for (const url of [
		// Each of these resolves to the victim or sibling directory when joined unvalidated.
		"https://github.com/owner/..%2F..%2Fvictim",
		"https://github.com/x%2F..%2F../sibling",
		"https://github.com/owner/repo/tree/..%2F..%2F..%2F..%2Fvictim",
	]) {
		const result = await extractGitHub(url, undefined, true);
		assert.deepEqual({ ...result, error: "" }, { url, title: "", content: "", error: "" }, url);
		assert.match(result?.error ?? "", /^Invalid GitHub URL: /, url);
	}
	assert.equal(await readText(join(victim, "keep.txt")), "keep");
	assert.equal(await readText(join(sibling, "keep.txt")), "keep");
	assert.equal(existsSync(clonePath), true);
	assert.deepEqual(cloneTargets(), []);
});

test("normal tree and blob URLs, including refs with slashes, clone inside the clone directory", async () => {
	const tree = await extractGitHub("https://github.com/octo/widgets/tree/feature%2Fx/src", undefined, true);
	assert.equal(tree?.error, null);
	assert.match(tree!.content, /## src\n {2}a\.ts/);
	const blob = await extractGitHub("https://github.com/octo/widgets/blob/main/README.md", undefined, true);
	assert.match(blob!.content, /## README.md\nRepository readme/);
	const root = await extractGitHub("https://github.com/octo/widgets", undefined, true);
	assert.match(root!.content, /## README.md\nRepository readme/);

	const clones = boundary.calls.filter((args) => args[0] === "repo" && args[1] === "clone");
	assert.equal(clones.length, 3);
	assert.deepEqual(clones[0]!.slice(-2), ["--branch", "feature/x"]);
	assert.deepEqual(clones[1]!.slice(-2), ["--branch", "main"]);
	assert.equal(new Set(cloneTargets()).size, 3);
	for (const target of cloneTargets()) assertInside(clonePath, target);
	assert.match(
		tree!.content,
		new RegExp(`Repository cloned to: ${cloneTargets()[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
	);

	clearCloneCache();
	for (const target of cloneTargets()) assert.equal(existsSync(target), false);
	assert.equal(existsSync(clonePath), true);
});

test("a clone left by an earlier run is replaced", async () => {
	await extractGitHub("https://github.com/octo/widgets/tree/main", undefined, true);
	const [first] = cloneTargets();
	const directory = dirname(first!);
	const leftover = join(sandbox, "leftover");
	writeFileSync(join(first!, "stale.txt"), "stale");
	cpSync(directory, leftover, { recursive: true });
	clearCloneCache();
	assert.equal(existsSync(first!), false);
	cpSync(leftover, directory, { recursive: true });
	boundary.calls = [];
	await extractGitHub("https://github.com/octo/widgets/tree/main", undefined, true);
	assert.deepEqual(cloneTargets(), [first]);
	assert.equal(await fileExists(join(first!, "stale.txt")), false);
	assert.equal(await fileExists(join(first!, "README.md")), true);
});

test("a directory the tool did not create is never removed", async () => {
	await extractGitHub("https://github.com/octo/widgets", undefined, true);
	const [target] = cloneTargets();
	clearCloneCache();
	assert.equal(existsSync(target!), false);

	mkdirSync(target!, { recursive: true });
	writeFileSync(join(target!, "keep.txt"), "user data");
	boundary.calls = [];
	await extractGitHub("https://github.com/octo/widgets", undefined, true);
	clearCloneCache();
	assert.equal(await readText(join(target!, "keep.txt")), "user data");
	assert.deepEqual(cloneTargets(), []);
});

test("a symlinked clone directory that escapes the clone directory is refused", async () => {
	mkdirSync(join(victim, "widgets"));
	writeFileSync(join(victim, "widgets", "keep.txt"), "keep");
	symlinkSync(victim, join(clonePath, "octo"), LINK_TYPE);

	await extractGitHub("https://github.com/octo/widgets", undefined, true);
	clearCloneCache();
	assert.equal(await readText(join(victim, "widgets", "keep.txt")), "keep");
	assert.equal(await readText(join(victim, "keep.txt")), "keep");
	assert.deepEqual(cloneTargets(), []);
});

test("a clone directory symlinked outside the clone directory is refused", async () => {
	await extractGitHub("https://github.com/octo/widgets", undefined, true);
	const [target] = cloneTargets();
	const directory = dirname(target!);
	// A real clone directory, moved outside the clone directory and linked back in.
	const outside = join(sandbox, "outside-clone");
	cpSync(directory, outside, { recursive: true });
	clearCloneCache();
	assert.equal(existsSync(directory), false);
	symlinkSync(outside, directory, LINK_TYPE);
	boundary.calls = [];
	await extractGitHub("https://github.com/octo/widgets", undefined, true);
	clearCloneCache();
	assert.equal(await readText(join(outside, relative(directory, target!), "README.md")), "Repository readme");
	assert.deepEqual(cloneTargets(), []);
});

test("GitHub API requests validate and encode owner, repo, ref and path", async () => {
	const info = {
		owner: "octo",
		repo: "widgets",
		ref: "feature/x",
		refIsFullSha: false,
		type: "tree" as const,
		path: "",
	};
	await fetchViaApi("https://github.com/octo/widgets", "octo", "widgets", info);
	assert.deepEqual(apiEndpoints().sort(), [
		"repos/octo/widgets/git/trees/feature%2Fx?recursive=1",
		"repos/octo/widgets/readme?ref=feature%2Fx",
	]);

	boundary.calls = [];
	await fetchViaApi("https://github.com/octo/widgets", "octo", "widgets", {
		...info,
		type: "blob",
		ref: "main",
		path: "docs/a b#c.md",
	});
	assert.deepEqual(apiEndpoints(), ["repos/octo/widgets/contents/docs/a%20b%23c.md?ref=main"]);

	boundary.calls = [];
	await fetchViaApi("https://github.com/octo/widgets", "octo", "widgets", { ...info, ref: undefined });
	assert.deepEqual(apiEndpoints(), ["repos/octo/widgets"]);

	for (const [owner, repo, ref, path] of [
		["..", "widgets", "main", ""],
		["octo", "..", "main", ""],
		["octo", "widgets", "../../user", ""],
		["octo", "widgets", "main", "../../../user"],
	] as const) {
		boundary.calls = [];
		const result = await fetchViaApi("https://github.com/x/y", owner, repo, { ...info, type: "blob", ref, path });
		assert.equal(result, null);
		assert.deepEqual(apiEndpoints(), [], `${owner}/${repo}@${ref}:${path}`);
	}
});

test("a default branch the API returns is validated before use", async () => {
	boundary.api["repos/octo/widgets .default_branch"] = "../../escape";
	const info = { owner: "octo", repo: "widgets", refIsFullSha: false, type: "root" as const };
	assert.equal(await fetchViaApi("https://github.com/octo/widgets", "octo", "widgets", info), null);
	assert.deepEqual(apiEndpoints(), ["repos/octo/widgets"]);
});

test("an oversized repository is shown through the GitHub API", async () => {
	boundary.api = {
		"repos/octo/widgets .size": "1048576",
		"repos/octo/widgets .default_branch": "release/1.x",
		"repos/octo/widgets/git/trees/release%2F1.x?recursive=1 .tree[].path": "README.md\nsrc/a.ts",
		"repos/octo/widgets/readme?ref=release%2F1.x .content": Buffer.from("Readme via API").toString("base64"),
	};
	const result = await extractGitHub("https://github.com/octo/widgets");
	assert.match(result!.content, /^Note: Repository is 1024MB/);
	assert.match(result!.content, /## Structure\nREADME\.md\nsrc\/a\.ts\n\n## README\.md\nReadme via API/);
	assert.deepEqual(cloneTargets(), []);
});

test("a file is read through the GitHub API with its path encoded", async () => {
	boundary.api["repos/octo/widgets/contents/docs/a%20b%23c.md?ref=main .content"] =
		Buffer.from("File via API").toString("base64");
	const info = {
		owner: "octo",
		repo: "widgets",
		ref: "main",
		refIsFullSha: false,
		type: "blob" as const,
		path: "docs/a b#c.md",
	};
	const result = await fetchViaApi("https://github.com/octo/widgets", "octo", "widgets", info);
	assert.equal(result?.content, "## docs/a b#c.md\nFile via API");
});

test("a repository size is only requested for valid owner and repo names", async () => {
	boundary.api["repos/octo/widgets .size"] = "42";
	assert.equal(await checkRepoSize("octo", "widgets"), 42);
	boundary.calls = [];
	assert.equal(await checkRepoSize("..", "widgets"), null);
	assert.equal(await checkRepoSize("octo", ".."), null);
	assert.deepEqual(apiEndpoints(), []);
});

test("a file in the way of the clone directory refuses the clone", async () => {
	writeFileSync(join(clonePath, "octo"), "not a directory");
	assert.equal(await extractGitHub("https://github.com/octo/widgets", undefined, true), null);
	assert.deepEqual(cloneTargets(), []);
	assert.equal(await readText(join(clonePath, "octo")), "not a directory");
});

test("a failed clone leaves nothing behind", async () => {
	boundary.failClone = true;
	assert.equal(await extractGitHub("https://github.com/octo/widgets", undefined, true), null);
	const [target] = cloneTargets();
	assert.ok(target);
	assert.equal(existsSync(dirname(target)), false);
	assert.equal(existsSync(join(clonePath, "octo")), true);
});

test("clearing the cache leaves a clone moved outside the clone directory alone", async () => {
	await extractGitHub("https://github.com/octo/widgets", undefined, true);
	const [target] = cloneTargets();
	const outside = join(sandbox, "outside-owner");
	renameSync(join(clonePath, "octo"), outside);
	symlinkSync(outside, join(clonePath, "octo"), LINK_TYPE);
	clearCloneCache();
	assert.equal(
		await readText(join(outside, relative(join(clonePath, "octo"), target!), "README.md")),
		"Repository readme",
	);
});

test("invalid GitHub URLs name the part that was rejected", () => {
	assert.throws(
		() => parseGitHubUrl("https://github.com/-octo/r"),
		/^Error: Invalid GitHub URL: unsupported owner "-octo"$/,
	);
	assert.throws(
		() => parseGitHubUrl("https://github.com/o/r%20x"),
		/^Error: Invalid GitHub URL: unsupported repository "r x"$/,
	);
	assert.throws(
		() => parseGitHubUrl("https://github.com/o/r/tree/a..b"),
		/^Error: Invalid GitHub URL: unsupported ref "a..b"$/,
	);
	assert.throws(
		() => parseGitHubUrl("https://github.com/o/r/blob/main/a%2F..%2Fb"),
		/^Error: Invalid GitHub URL: unsupported path "a\/..\/b"$/,
	);
});
