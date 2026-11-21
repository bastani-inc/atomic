import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { cpSync, existsSync, mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";
import { toJsLiteral } from "../helpers/js-literal.js";
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
	/** Links the fake clone creates: name inside the clone to target (relative targets are kept as written). */
	links: {} as Record<string, { target: string; type: "file" | "dir" | "junction" }>,
	failClone: false,
	cloneScript: "",
	/** The clone command cannot start, as when git or gh is missing; `onCloneSpawn` runs as it is started. */
	cloneSpawnFails: false,
	onCloneSpawn: undefined as (() => void) | undefined,
	/** `gh api` output keyed by `<endpoint> <jq filter>`; any other request fails. */
	api: {} as Record<string, string>,
}));

// The faked `gh` and `git` are found under their own names, as programs on PATH would be.
vi.mock("@bastani/atomic-tui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@bastani/atomic-tui")>()),
	findHelperExecutableAsync: async (name: string) => name,
	helperLaunchAsync: async (name: string) => ({ file: name }),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const execFile = (_command: string, args: string[], _options: object, callback: Callback) => {
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
				for (const [name, link] of Object.entries(boundary.links)) {
					mkdirSync(dirname(join(target, name)), { recursive: true });
					symlinkSync(link.target, join(target, name), link.type);
				}
				return callback(boundary.failClone ? new Error("clone failed") : null, "");
			}
			const output = boundary.api[`${args[1]} ${args[3]}`];
			return output === undefined ? callback(new Error("offline"), "") : callback(null, output);
		});
		return Object.assign(new EventEmitter(), { kill: () => true });
	};
	const spawn = (command: string, args: string[] = [], options: object = {}) => {
		if (args[0] === "repo" && args[1] === "clone" && boundary.cloneSpawnFails) {
			boundary.calls.push(args);
			boundary.onCloneSpawn?.();
			return actual.spawn("atomic-command-that-does-not-exist", [], options);
		}
		if (args[0] === "repo" && args[1] === "clone" && boundary.cloneScript) {
			boundary.calls.push(args);
			return actual.spawn(process.execPath, ["-e", boundary.cloneScript], options);
		}
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

/** When enabled, records what is done to each contained clone; terminating it kills the clone, as ending its job would. */
const containment = vi.hoisted(() => ({ enabled: false, events: [] as string[] }));
vi.mock("../../packages/coding-agent/src/core/process-tree-containment.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../packages/coding-agent/src/core/process-tree-containment.ts")>();
	return {
		...actual,
		containProcessTree: (pid: number) => {
			if (!containment.enabled) return actual.containProcessTree(pid);
			containment.events.push("contain");
			return {
				terminate: () => {
					containment.events.push("terminate");
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
					return true;
				},
				activeProcesses: () => 0,
				release: () => {
					containment.events.push("release");
					return true;
				},
				close: () => {
					containment.events.push("close");
				},
			};
		},
	};
});

// The config path is read once at import, so it must point into a temp directory before the import.
const suiteDirectory = makeTempDirectory("web-gh-confine-suite-");
boundary.configPath = join(suiteDirectory, "web-search.json");
const { clearCloneCache, extractGitHub, parseGitHubUrl } = await import("../../packages/web-access/github-extract.js");
const { checkRepoSize, fetchViaApi } = await import("../../packages/web-access/github-api.js");
const { loadGitHubConfig } = await import("../../packages/web-access/github-config.js");

afterAll(() => removeTempDirectory(suiteDirectory));

/** File symlinks need extra privileges on Windows; tests that create them are skipped where that fails. */
const fileLinksSupported = (() => {
	try {
		writeFileSync(join(suiteDirectory, "link-target"), "");
		symlinkSync(join(suiteDirectory, "link-target"), join(suiteDirectory, "link-probe"), "file");
		return true;
	} catch {
		return false;
	}
})();

let sandbox = "";
let clonePath = "";
let victim = "";

beforeEach(async () => {
	sandbox = makeTempDirectory("web-gh-confine-");
	clonePath = join(sandbox, "clones");
	victim = join(sandbox, "victim");
	mkdirSync(clonePath);
	mkdirSync(victim);
	writeFileSync(join(victim, "keep.txt"), "keep");
	boundary.sandbox = sandbox;
	boundary.calls = [];
	boundary.files = { "README.md": "Repository readme", "src/a.ts": "export const a = 1;\n" };
	boundary.links = {};
	boundary.failClone = false;
	boundary.cloneScript = "";
	boundary.cloneSpawnFails = false;
	boundary.onCloneSpawn = undefined;
	boundary.api = {};
	writeFileSync(boundary.configPath, JSON.stringify({ githubClone: { clonePath } }));
	await clearCloneCache();
	// Never run against the default clone directory.
	assert.equal((await loadGitHubConfig()).clonePath, clonePath);
});

afterEach(async () => {
	containment.enabled = false;
	containment.events = [];
	await clearCloneCache();
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

	await clearCloneCache();
	for (const target of cloneTargets()) assert.equal(existsSync(target), false);
	assert.equal(existsSync(clonePath), true);
});

test("clearing a clone cache yields for deletion and a new clone waits for that deletion", async () => {
	await extractGitHub("https://github.com/octo/widgets", undefined, true);
	const [target] = cloneTargets();
	const clearing = clearCloneCache();
	assert.equal(existsSync(target!), true, "clearing does not delete the checkout on the caller's turn");
	boundary.files = { "README.md": "Fresh checkout after clearing" };
	const replacing = extractGitHub("https://github.com/octo/widgets", undefined, true);
	await clearing;
	const result = await replacing;
	assert.match(result!.content, /Fresh checkout after clearing/);
	assert.equal(await fileExists(join(target!, "README.md")), true);
});

test("a clone left by an earlier run is replaced", async () => {
	await extractGitHub("https://github.com/octo/widgets/tree/main", undefined, true);
	const [first] = cloneTargets();
	const directory = dirname(first!);
	const leftover = join(sandbox, "leftover");
	writeFileSync(join(first!, "stale.txt"), "stale");
	cpSync(directory, leftover, { recursive: true });
	await clearCloneCache();
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
	await clearCloneCache();
	assert.equal(existsSync(target!), false);

	mkdirSync(target!, { recursive: true });
	writeFileSync(join(target!, "keep.txt"), "user data");
	boundary.calls = [];
	await extractGitHub("https://github.com/octo/widgets", undefined, true);
	await clearCloneCache();
	assert.equal(await readText(join(target!, "keep.txt")), "user data");
	assert.deepEqual(cloneTargets(), []);
});

test("a symlinked clone directory that escapes the clone directory is refused", async () => {
	mkdirSync(join(victim, "widgets"));
	writeFileSync(join(victim, "widgets", "keep.txt"), "keep");
	symlinkSync(victim, join(clonePath, "octo"), LINK_TYPE);

	await extractGitHub("https://github.com/octo/widgets", undefined, true);
	await clearCloneCache();
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
	await clearCloneCache();
	assert.equal(existsSync(directory), false);
	symlinkSync(outside, directory, LINK_TYPE);
	boundary.calls = [];
	await extractGitHub("https://github.com/octo/widgets", undefined, true);
	await clearCloneCache();
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
	await clearCloneCache();
	assert.equal(
		await readText(join(outside, relative(join(clonePath, "octo"), target!), "README.md")),
		"Repository readme",
	);
});

const OUTSIDE_TEXT = "text kept outside the clone";

test.skipIf(!fileLinksSupported)(
	"a repository README that links to an absolute path outside the clone is not read",
	async () => {
		writeFileSync(join(victim, "notes.txt"), OUTSIDE_TEXT);
		// `README` is the next candidate; `readme.md` would collide with `README.md` on case-insensitive filesystems.
		boundary.files = { README: "Second readme" };
		boundary.links = { "README.md": { target: join(victim, "notes.txt"), type: "file" } };
		const root = await extractGitHub("https://github.com/octo/widgets", undefined, true);
		assert.equal(root?.error, null);
		assert.doesNotMatch(root!.content, new RegExp(OUTSIDE_TEXT));
		assert.match(root!.content, /## README.md\nSecond readme/);
	},
);

test.skipIf(!fileLinksSupported)(
	"a repository README that links through ../ outside the clone is not read",
	async () => {
		writeFileSync(join(victim, "notes.txt"), OUTSIDE_TEXT);
		boundary.files = {};
		// The checkout is <clones>/octo/widgets/widgets, so four levels up is the sandbox.
		boundary.links = { "README.md": { target: "../../../../victim/notes.txt", type: "file" } };
		const root = await extractGitHub("https://github.com/octo/widgets", undefined, true);
		assert.equal(root?.error, null);
		assert.equal(await readText(join(cloneTargets()[0]!, "README.md")), OUTSIDE_TEXT);
		assert.doesNotMatch(root!.content, new RegExp(OUTSIDE_TEXT));
		assert.doesNotMatch(root!.content, /## README.md/);
	},
);

test("a directory in the repository that links outside the clone is not listed or read", async () => {
	writeFileSync(join(victim, "notes.txt"), OUTSIDE_TEXT);
	boundary.links = { docs: { target: victim, type: LINK_TYPE } };
	const tree = await extractGitHub("https://github.com/octo/widgets/tree/main/docs", undefined, true);
	assert.equal(tree?.error, null);
	assert.match(tree!.content, /Path `docs` not found in clone/);
	assert.doesNotMatch(tree!.content, /notes\.txt|keep\.txt/);
	assert.match(tree!.content, /docs {2}\[outside repo skipped\]/);
	const blob = await extractGitHub("https://github.com/octo/widgets/blob/main/docs/notes.txt", undefined, true);
	assert.doesNotMatch(blob!.content, new RegExp(OUTSIDE_TEXT));
	const root = await extractGitHub("https://github.com/octo/widgets/tree/main", undefined, true);
	assert.match(root!.content, /\n {2}docs {2}\(outside repo\)/);
	assert.doesNotMatch(root!.content, /notes\.txt|keep\.txt/);
});

test("a dangling link that points outside the clone is not followed", async () => {
	const missing = join(victim, "created-later");
	boundary.links = { docs: { target: missing, type: LINK_TYPE } };
	const tree = await extractGitHub("https://github.com/octo/widgets/tree/main/docs/sub", undefined, true);
	assert.match(tree!.content, /Path `docs\/sub` not found in clone/);

	// A clone directory reached through a dangling link outside the clone directory is refused.
	await clearCloneCache();
	boundary.calls = [];
	symlinkSync(join(victim, "elsewhere"), join(clonePath, "other"), LINK_TYPE);
	await extractGitHub("https://github.com/other/widgets", undefined, true);
	assert.deepEqual(cloneTargets(), []);
	assert.equal(existsSync(join(victim, "elsewhere")), false);
});

test.skipIf(!fileLinksSupported)("links that stay inside the repository are still read", async () => {
	boundary.files = { "docs/intro.md": "Linked readme", "src/a.ts": "export const a = 1;\n" };
	boundary.links = {
		"README.md": { target: join("docs", "intro.md"), type: "file" },
		lib: { target: "src", type: "dir" },
	};
	const root = await extractGitHub("https://github.com/octo/widgets", undefined, true);
	assert.match(root!.content, /## README.md\nLinked readme/);
	assert.match(root!.content, /\nlib\/\nlib\/a\.ts\n/);
	const blob = await extractGitHub("https://github.com/octo/widgets/blob/main/lib/a.ts", undefined, true);
	assert.match(blob!.content, /## lib\/a\.ts\nexport const a = 1;/);
});

test.skipIf(!fileLinksSupported)("a link to the repository root is listed as a directory", async () => {
	boundary.links = { self: { target: ".", type: "dir" } };
	const tree = await extractGitHub("https://github.com/octo/widgets/tree/main", undefined, true);
	assert.match(tree!.content, /\n {2}self\/\n/);
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

test("aborting or clearing a clone with a background grandchild holding stdio settles promptly (#5377)", async () => {
	const pidFile = join(sandbox, "grandchild.pid");
	boundary.cloneScript = `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); process.on('SIGTERM', () => {}); const g = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 2500);"], { stdio: 'inherit' }); writeFileSync(${toJsLiteral(pidFile)}, String(g.pid)); setTimeout(() => {}, 2500);`;
	const within = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("clone hung on grandchild pipe")), ms);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};
	const waitForPidFile = async (): Promise<number> => {
		for (let i = 0; i < 40; i++) {
			if (existsSync(pidFile)) {
				const pid = Number((await readText(pidFile)).trim());
				if (Number.isInteger(pid) && pid > 0) return pid;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("grandchild pid file not written");
	};
	const waitForProcessExit = async (pid: number): Promise<void> => {
		if (process.platform === "win32") return;
		for (let i = 0; i < 50; i++) {
			try {
				process.kill(pid, 0);
			} catch {
				return;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		}
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	};
	const controller = new AbortController();
	const abortClone = extractGitHub("https://github.com/octo/widgets", controller.signal, true);
	const firstGrandchildPid = await waitForPidFile();
	controller.abort();
	assert.equal(await within(abortClone, 800), null);
	await waitForProcessExit(firstGrandchildPid);

	writeFileSync(pidFile, "");
	const pendingClone = extractGitHub("https://github.com/octo/widgets", undefined, true);
	const secondGrandchildPid = await waitForPidFile();
	await within(clearCloneCache(), 800);
	assert.equal(await within(pendingClone, 800), null);
	await waitForProcessExit(secondGrandchildPid);
});

test("aborting a clone terminates its process tree once, also when the clone's exit follows (#5601)", async () => {
	boundary.cloneScript = "setTimeout(() => {}, 30000);";
	containment.enabled = true;
	const controller = new AbortController();
	const clone = extractGitHub("https://github.com/octo/widgets", controller.signal, true);
	for (let i = 0; i < 2000 && !containment.events.includes("contain"); i++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	assert.deepEqual(containment.events, ["contain"], "the clone started in its own process tree");
	controller.abort();
	assert.equal(await clone, null);
	assert.deepEqual(containment.events, ["contain", "terminate", "close"]);
});

test("a clone aborted as it starts, whose command cannot start, ends without a clone instead of failing (#5601)", async () => {
	const controller = new AbortController();
	boundary.cloneSpawnFails = true;
	// The abort lands while the clone command is being started, so the clone stops a child that never started.
	boundary.onCloneSpawn = () => controller.abort();
	assert.equal(await extractGitHub("https://github.com/octo/widgets", controller.signal, true), null);
	assert.equal(cloneTargets().length, 1, "the clone was started");
});
