import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, test } from "vitest";
import { parseBlueprintCommand, runBlueprintCommand } from "../src/cli/blueprint-command.js";
import { getExtensionTranspileCacheDir } from "../src/config.js";
import {
	type BlueprintCacheKeys,
	blueprintCacheKeys,
	formatBlueprintCacheKeys,
} from "../src/core/resume/blueprint/cache.js";
import { parseBlueprint } from "../src/core/resume/blueprint/schema.js";
import { objectStorePath } from "../src/core/worktree-snapshot/restore.js";
import { forThisHost } from "./helpers/blueprint-fixtures.js";

const REMOTE = "https://example.com/acme/widgets.git";
const scratch: string[] = [];

afterEach(() => {
	for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "atomic-blueprint-cache-")));
	scratch.push(directory);
	return directory;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

interface Fixture {
	readonly root: string;
	readonly home: string;
	readonly agentDir: string;
	readonly storeDir: string;
}

/** A Git checkout with one commit and an `origin`, plus a separate home, agent directory and store. */
function fixture(blueprint: string | undefined, files: Readonly<Record<string, string>> = {}): Fixture {
	const base = temporaryDirectory();
	const root = join(base, "checkout");
	const home = join(base, "home");
	const agentDir = join(home, ".atomic", "agent");
	mkdirSync(root, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	git(root, "init", "-q");
	git(root, "remote", "add", "origin", REMOTE);
	for (const [path, content] of Object.entries({ "README.md": "widgets\n", ...files })) write(root, path, content);
	if (blueprint !== undefined) write(root, ".atomic/blueprint.yaml", blueprint);
	git(root, "add", "-A");
	git(
		root,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@example.com",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-q",
		"-m",
		"init",
	);
	return { root, home, agentDir, storeDir: join(agentDir, "worktree-snapshots") };
}

function write(root: string, path: string, content: string): void {
	const file = join(root, path);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, content);
}

function keysOf(at: Fixture, options: { platform?: NodeJS.Platform; arch?: string } = {}): Promise<BlueprintCacheKeys> {
	return blueprintCacheKeys(at.root, {
		platform: "linux",
		arch: "x64",
		home: at.home,
		agentDir: at.agentDir,
		storeDir: at.storeDir,
		...options,
	});
}

function entry(keys: BlueprintCacheKeys, name: string) {
	return keys.entries.find((candidate) => candidate.name === name);
}

const STORES = "runs-on: linux\ncache:\n  - path: ~/.npm\n  - path: ~/.cargo/registry\n";

describe("blueprint cache: parsing (#4748)", () => {
	test("reads store and build entries, with string shorthand and key-files (#4748)", () => {
		const parsed = parseBlueprint(
			"cache:\n  - ~/.npm\n  - path: target\n    kind: build\n    key-files: [Cargo.lock, rust-toolchain.toml]\n  - path: ~/.cache/uv\n    key-files: uv.lock\n",
			{ path: "/repo/.atomic/blueprint.yaml", scope: "repository" },
		);
		assert.deepEqual(parsed.documents[0]?.cache, {
			entries: [
				{ path: "~/.npm", kind: "store", keyFiles: undefined },
				{ path: "target", kind: "build", keyFiles: ["Cargo.lock", "rust-toolchain.toml"] },
				{ path: "~/.cache/uv", kind: "store", keyFiles: ["uv.lock"] },
			],
			ignored: [],
		});
	});

	test("an invalid cache entry or section is ignored, never failing the blueprint (#4748)", () => {
		const location = { path: "/repo/.atomic/blueprint.yaml", scope: "repository" as const };
		const parsed = parseBlueprint(
			"maintenance: npm ci\ncache:\n  - path: ~/.npm\n  - path: target\n    kind: artifact\n  - 7\n  - path: x\n    key-files: [../outside]\n  - path: ''\n",
			location,
		);
		const document = parsed.documents[0];
		assert.equal(document?.maintenance.length, 1);
		assert.deepEqual(document?.cache?.entries, [{ path: "~/.npm", kind: "store", keyFiles: undefined }]);
		assert.equal(document?.cache?.ignored.length, 4);
		assert.match(document?.cache?.ignored[0] ?? "", /cache\[1\].*kind/);
		const scalar = parseBlueprint("cache: 5\n", location).documents[0]?.cache;
		assert.deepEqual(scalar?.entries, []);
		assert.equal(scalar?.ignored.length, 1);
	});

	test("the parser keeps ignoring keys it does not know, and a blueprint without cache: has none (#4748)", () => {
		const parsed = parseBlueprint("maintenance: npm ci\nfuture-key:\n  anything: 1\n", {
			path: "/repo/.atomic/blueprint.yaml",
			scope: "repository",
		});
		assert.equal(parsed.documents[0]?.cache, undefined);
		assert.equal(parsed.documents[0]?.maintenance.length, 1);
	});
});

describe("blueprintCacheKeys (#4748)", () => {
	test("a blueprint without cache: gives stores-free git and atomic entries (#4748)", async () => {
		const at = fixture("maintenance: npm ci\n");
		const keys = await keysOf(at);
		assert.deepEqual(
			keys.entries.map((candidate) => candidate.name),
			["git", "atomic"],
		);
		const head = git(at.root, "rev-parse", "HEAD");
		const store = objectStorePath(at.storeDir, [REMOTE]);
		const gitEntry = entry(keys, "git");
		const repositoryId = basename(store, ".git");
		assert.deepEqual(gitEntry, {
			name: "git",
			key: `atomic-git-v1-linux-${repositoryId}-${head}`,
			restorePrefix: `atomic-git-v1-linux-${repositoryId}-`,
			paths: [store],
		});
		const atomic = entry(keys, "atomic");
		assert.deepEqual(atomic?.paths, [getExtensionTranspileCacheDir(at.agentDir)]);
		assert.match(atomic?.key ?? "", /^atomic-atomic-v1-linux-x64-[0-9a-f]{16}$/);
		assert.equal(atomic?.restorePrefix, "atomic-atomic-v1-linux-x64-");
		assert.deepEqual(keys.warnings, []);
	});

	test("keys are deterministic and change with each input (#4748)", async () => {
		const at = fixture(STORES, { "package-lock.json": "{}\n" });
		const first = await keysOf(at);
		assert.deepEqual(await keysOf(at), first);
		const stores = entry(first, "stores");
		assert.match(stores?.key ?? "", /^atomic-stores-v1-linux-x64-[0-9a-f]{16}$/);
		assert.equal(stores?.restorePrefix, "atomic-stores-v1-linux-x64-");
		assert.deepEqual(stores?.paths, [join(at.home, ".npm"), join(at.home, ".cargo", "registry")]);

		assert.notEqual(entry(await keysOf(at, { arch: "arm64" }), "stores")?.key, stores?.key);
		const mac = await keysOf(at, { platform: "darwin" });
		assert.equal(entry(mac, "stores"), undefined, "the blueprint has no macOS document");
		assert.match(entry(mac, "atomic")?.key ?? "", /^atomic-atomic-v1-macos-x64-/);
		assert.match(entry(mac, "git")?.key ?? "", /^atomic-git-v1-macos-/);

		write(at.root, "package-lock.json", '{"lockfileVersion":3}\n');
		const lockChanged = await keysOf(at);
		assert.notEqual(entry(lockChanged, "stores")?.key, stores?.key);
		assert.equal(entry(lockChanged, "atomic")?.key, entry(first, "atomic")?.key);

		write(at.root, ".atomic/blueprint.yaml", `${STORES}  - path: ~/.cache/uv\n`);
		assert.notEqual(entry(await keysOf(at), "stores")?.key, entry(lockChanged, "stores")?.key);
	});

	test("declared key-files replace envHash, and a build entry keys and places its seeds apart (#4748)", async () => {
		const blueprint =
			"cache:\n  - path: ~/.cargo/registry\n    key-files: [Cargo.lock]\n  - path: target\n    kind: build\n    key-files: [Cargo.lock]\n";
		const at = fixture(blueprint, { "Cargo.lock": "v1\n", "package-lock.json": "{}\n" });
		const first = await keysOf(at);
		write(at.root, "package-lock.json", '{"changed":true}\n');
		const unrelated = await keysOf(at);
		assert.equal(entry(unrelated, "stores")?.key, entry(first, "stores")?.key);
		assert.equal(entry(unrelated, "build")?.key, entry(first, "build")?.key);
		write(at.root, "Cargo.lock", "v2\n");
		const declared = await keysOf(at);
		assert.notEqual(entry(declared, "stores")?.key, entry(first, "stores")?.key);
		assert.notEqual(entry(declared, "build")?.key, entry(first, "build")?.key);

		const build = entry(first, "build");
		const repositoryId = basename(objectStorePath(at.storeDir, [REMOTE]), ".git");
		assert.match(build?.key ?? "", /^atomic-build-v1-linux-x64-[0-9a-f]{16}$/);
		assert.notEqual(build?.key.slice(-16), entry(first, "stores")?.key.slice(-16));
		assert.deepEqual(build?.paths, [
			join(at.storeDir, "seeds", repositoryId, "target"),
			join(at.storeDir, "seeds", `${repositoryId}.json`),
		]);
	});

	test("a kind: store path inside the worktree is refused with a warning (#4748)", async () => {
		const at = fixture("cache:\n  - path: node_modules\n  - path: ~/.npm\n");
		write(
			at.root,
			".atomic/blueprint.yaml",
			`cache:\n  - path: node_modules\n  - path: ${join(at.root, "dist")}\n  - path: ~/.npm\n`,
		);
		const keys = await keysOf(at);
		assert.deepEqual(entry(keys, "stores")?.paths, [join(at.home, ".npm")]);
		assert.equal(keys.warnings.length, 2);
		for (const warning of keys.warnings) assert.match(warning, /outside the worktree/);
	});

	test("paths that could carry secrets are omitted with a warning (#4748)", async () => {
		const at = fixture(
			'cache:\n  - ~/.cargo\n  - ~/.config/gh\n  - ~/.ssh/known\n  - ~/.npmrc\n  - "~"\n  - ~/.cargo/registry\n  - path: .env.local\n    kind: build\n  - path: target\n    kind: build\n',
		);
		const keys = await keysOf(at);
		assert.deepEqual(entry(keys, "stores")?.paths, [join(at.home, ".cargo", "registry")]);
		assert.equal(entry(keys, "build")?.paths.length, 2, "target and the seed manifest");
		assert.equal(keys.warnings.length, 6);
		for (const warning of keys.warnings) assert.match(warning, /credentials/, keys.warnings.join("\n"));
	});

	test("refusing every store path drops the stores entry, and an invalid blueprint keeps git and atomic (#4748)", async () => {
		const at = fixture("cache:\n  - ~/.ssh\n");
		assert.equal(entry(await keysOf(at), "stores"), undefined);
		write(at.root, ".atomic/blueprint.yaml", "maintenance:\n  - uses: not-a-reference\ncache:\n  - ~/.npm\n");
		const keys = await keysOf(at);
		assert.deepEqual(
			keys.entries.map((candidate) => candidate.name),
			["git", "atomic"],
		);
		assert.match(keys.warnings[0] ?? "", /blueprint/);
	});

	test("a directory without a Git remote omits the git and build entries with a warning (#4748)", async () => {
		const root = temporaryDirectory();
		const home = temporaryDirectory();
		write(root, ".atomic/blueprint.yaml", "cache:\n  - ~/.npm\n  - path: target\n    kind: build\n");
		const keys = await blueprintCacheKeys(root, { platform: "linux", arch: "x64", home, agentDir: home });
		assert.deepEqual(
			keys.entries.map((candidate) => candidate.name),
			["stores", "atomic"],
		);
		assert.match(keys.warnings.join("\n"), /remote/);
	});
});

describe("cache-key formats and CLI (#4748)", () => {
	const keys: BlueprintCacheKeys = {
		entries: [
			{
				name: "stores",
				key: "atomic-stores-v1-linux-x64-0123456789abcdef",
				restorePrefix: "atomic-stores-v1-linux-x64-",
				paths: ["/h/.npm", "/h/.cache/uv"],
			},
			{ name: "git", key: "atomic-git-v1-linux-r-h", restorePrefix: "atomic-git-v1-linux-r-", paths: ["/s/r.git"] },
		],
		warnings: ["w"],
	};

	test("github-output writes key, restore-prefix and paths lines for $GITHUB_OUTPUT (#4748)", () => {
		const text = formatBlueprintCacheKeys(keys, "github-output");
		const lines = text.split("\n");
		assert.ok(lines.includes("stores-key=atomic-stores-v1-linux-x64-0123456789abcdef"));
		assert.ok(lines.includes("stores-restore-prefix=atomic-stores-v1-linux-x64-"));
		const open = lines.findIndex((line) => line.startsWith("stores-paths<<"));
		const delimiter = lines[open]?.slice("stores-paths<<".length) ?? "";
		assert.match(delimiter, /^ATOMIC_[0-9a-f]{16}$/);
		assert.deepEqual(lines.slice(open + 1, open + 4), ["/h/.npm", "/h/.cache/uv", delimiter]);
		assert.ok(lines.includes("git-key=atomic-git-v1-linux-r-h"));
		assert.ok(lines.includes("git-paths=/s/r.git"));
		assert.ok(!text.includes("w\n"));
		assert.deepEqual(JSON.parse(formatBlueprintCacheKeys(keys, "json")), keys);
		assert.match(formatBlueprintCacheKeys(keys, "text"), /^stores\n {2}key: +atomic-stores-v1/m);
	});

	test("parses cache-key arguments and rejects unknown ones (#4748)", () => {
		assert.deepEqual(parseBlueprintCommand(["cache-key"]), { kind: "cache-key", dir: undefined, format: "text" });
		assert.deepEqual(parseBlueprintCommand(["cache-key", "repo", "--format", "github-output"]), {
			kind: "cache-key",
			dir: "repo",
			format: "github-output",
		});
		assert.deepEqual(parseBlueprintCommand(["cache-key", "--format=json"]), {
			kind: "cache-key",
			dir: undefined,
			format: "json",
		});
		assert.deepEqual(parseBlueprintCommand(["--help"]), { kind: "help" });
		assert.equal(parseBlueprintCommand(["cache-key", "--format", "yaml"]).kind, "error");
		assert.equal(parseBlueprintCommand(["cache-key", "a", "b"]).kind, "error");
		assert.equal(parseBlueprintCommand(["prebuilt"]).kind, "error");
		assert.equal(parseBlueprintCommand(["cache-key", "--park"]).kind, "error");
		assert.equal(parseBlueprintCommand(["prebuild", "--format=json"]).kind, "error");
		assert.deepEqual(parseBlueprintCommand(["prebuild", "dir", "--park", "-a"]), {
			kind: "prebuild",
			dir: "dir",
			park: true,
			approve: true,
		});
		assert.deepEqual(parseBlueprintCommand(["prebuild", "--approve"]), {
			kind: "prebuild",
			dir: undefined,
			park: false,
			approve: true,
		});
	});

	test("atomic blueprint cache-key prints github-output for a subdirectory of a checkout (#4748)", async () => {
		const at = fixture(forThisHost("cache:\n  - path: ~/.npm\n"));
		mkdirSync(join(at.root, "src"));
		const out: string[] = [];
		const err: string[] = [];
		const code = await runBlueprintCommand(["cache-key", "src", "--format", "github-output"], {
			cwd: at.root,
			agentDir: at.agentDir,
			home: at.home,
			stdout: (text) => out.push(text),
			stderr: (text) => err.push(text),
		});
		assert.equal(code, 0);
		const printed = out.join("");
		assert.match(printed, /^stores-key=atomic-stores-v1-/m);
		assert.match(
			printed,
			new RegExp(
				`^git-paths=${objectStorePath(join(at.agentDir, "worktree-snapshots"), [REMOTE]).replaceAll("\\", "\\\\")}$`,
				"m",
			),
		);
		assert.deepEqual(err, []);
		assert.equal(
			await runBlueprintCommand(["cache-key", "--format", "yaml"], {
				cwd: at.root,
				agentDir: at.agentDir,
				stdout: () => {},
				stderr: (text) => err.push(text),
			}),
			2,
		);
		assert.match(err.join(""), /--format/);
	});
});

describe("blueprint cache: edge cases (#4748)", () => {
	const location = { path: "/repo/.atomic/blueprint.yaml", scope: "repository" as const };

	test("cache entries are trimmed and normalized, and each malformed field is named (#4748)", () => {
		const document = parseBlueprint(
			[
				"cache:",
				"  - '  ~/.npm  '",
				"  - path: ~/.cache/uv",
				"    kind: null",
				"    key-files: 'locks\\uv.lock'",
				'  - "a\\nb"',
				"  - path: 5",
				"  - kind: build",
				"  - path: x",
				"    key-files: []",
				"  - path: x",
				"    key-files: [/abs.lock]",
				"  - path: x",
				"    key-files: ['C:/x.lock']",
				"  - path: x",
				"    key-files: [5]",
				"",
			].join("\n"),
			location,
		).documents[0];
		assert.deepEqual(document?.cache?.entries, [
			{ path: "~/.npm", kind: "store", keyFiles: undefined },
			{ path: "~/.cache/uv", kind: "store", keyFiles: ["locks/uv.lock"] },
		]);
		const ignored = document?.cache?.ignored ?? [];
		assert.equal(ignored.length, 7);
		for (const message of ignored.slice(0, 3)) assert.match(message, /'path'/);
		for (const message of ignored.slice(3)) assert.match(message, /'key-files'/);
		assert.ok(!("cache" in (parseBlueprint("maintenance: npm ci\n", location).documents[0] ?? {})));
		assert.deepEqual(parseBlueprint("cache: []\n", location).documents[0]?.cache, { entries: [], ignored: [] });
	});

	test("a cache path with glob characters or a leading ! is ignored, so it cannot match credentials (#4748)", () => {
		const document = parseBlueprint(
			"cache:\n  - '~/.ss[h]/*'\n  - ~/.npm/**\n  - '!~/.npm'\n  - '~/{a,b}'\n  - ~/x?\n  - path: 'targe[t]'\n    kind: build\n  - ~/.npm\n",
			location,
		).documents[0];
		assert.deepEqual(document?.cache?.entries, [{ path: "~/.npm", kind: "store", keyFiles: undefined }]);
		assert.equal(document?.cache?.ignored.length, 6);
		for (const message of document?.cache?.ignored ?? []) assert.match(message, /glob characters/);
	});

	test("kind: build paths must stay inside the worktree, outside .git, and off credential files (#4748)", async () => {
		const at = fixture(
			"cache:\n  - {path: /abs/out, kind: build}\n  - {path: ~/out, kind: build}\n  - {path: 'C:/out', kind: build}\n  - {path: ../out, kind: build}\n  - {path: .git/hooks, kind: build}\n  - {path: ., kind: build}\n  - {path: .npmrc, kind: build}\n  - {path: ./dist/, kind: build}\n",
		);
		const keys = await keysOf(at);
		const seeds = join(at.storeDir, "seeds", basename(objectStorePath(at.storeDir, [REMOTE]), ".git"));
		assert.deepEqual(entry(keys, "build")?.paths, [join(seeds, "dist"), `${seeds}.json`]);
		assert.equal(keys.warnings.length, 7);
		for (const warning of keys.warnings.slice(0, 3)) assert.match(warning, /relative to the repository root/);
		for (const warning of keys.warnings.slice(3, 6)) assert.match(warning, /inside the worktree, outside \.git/);
		assert.match(keys.warnings[6] ?? "", /'\.npmrc'.*credentials/);
	});

	test("kind: store paths expand ~ either way and refuse the worktree's ancestors and Atomic's credentials (#4748)", async () => {
		const at = fixture("cache: []\n");
		const outside = join(at.home, "..", "shared-cache");
		write(
			at.root,
			".atomic/blueprint.yaml",
			`cache:\n  - '~\\.npm'\n  - ${outside}\n  - /\n  - ${join(at.root, "..")}\n  - ~/.atomic\n`,
		);
		const keys = await keysOf(at);
		assert.deepEqual(entry(keys, "stores")?.paths, [join(at.home, ".npm"), resolve(outside)]);
		assert.equal(keys.warnings.length, 3);
		assert.match(keys.warnings[0] ?? "", /'\/'.*outside the worktree/);
		assert.match(keys.warnings[1] ?? "", /outside the worktree/);
		assert.match(keys.warnings[2] ?? "", /'~\/\.atomic'.*credentials/);
	});

	test("credential checks fold case and follow symbolic links (#4748)", async () => {
		const at = fixture("cache: []\n");
		mkdirSync(join(at.home, ".ssh"), { recursive: true });
		mkdirSync(join(at.home, "tools"), { recursive: true });
		const link = process.platform === "win32" ? "junction" : "dir";
		symlinkSync(join(at.home, ".ssh"), join(at.home, "keys"), link);
		symlinkSync(at.home, join(at.home, "tools", "home"), link);
		write(
			at.root,
			".atomic/blueprint.yaml",
			"cache:\n  - ~/.SSH\n  - ~/.Config/GH/hosts\n  - ~/.NPMRC\n  - ~/keys\n  - ~/tools/home\n  - ~/\n  - ~/tools\n  - path: .ENV.local\n    kind: build\n  - path: .NPMRC\n    kind: build\n",
		);
		const keys = await keysOf(at);
		assert.deepEqual(entry(keys, "stores")?.paths, [join(at.home, "tools")]);
		assert.equal(keys.warnings.length, 8, keys.warnings.join("\n"));
		for (const warning of keys.warnings) assert.match(warning, /credentials/);
	});

	test("an unreadable blueprint or an invalid entry only warns (#4748)", async () => {
		const at = fixture("cache:\n  - path: ~/.npm\n    kind: artifact\n  - ~/.npm\n");
		const keys = await keysOf(at);
		assert.deepEqual(entry(keys, "stores")?.paths, [join(at.home, ".npm")]);
		assert.deepEqual(keys.warnings, ["cache[0]: 'kind' must be 'store' or 'build'; entry ignored"]);
		rmSync(join(at.root, ".atomic", "blueprint.yaml"));
		mkdirSync(join(at.root, ".atomic", "blueprint.yaml"));
		const unreadable = await keysOf(at);
		assert.deepEqual(
			unreadable.entries.map((candidate) => candidate.name),
			["git", "atomic"],
		);
		assert.match(unreadable.warnings[0] ?? "", /could not be read/);
	});

	test("a missing or directory key file counts as absent, and keys are stable across releases (#4748)", async () => {
		const at = fixture("cache:\n  - path: /opt/store\n    key-files: [deps.lock, deps]\n");
		mkdirSync(join(at.root, "deps"));
		const absent = entry(await keysOf(at), "stores")?.key;
		assert.equal(absent, "atomic-stores-v1-linux-x64-d6cfbb79dbf8e538");
		write(at.root, "deps.lock", "1\n");
		assert.equal(entry(await keysOf(at), "stores")?.key, "atomic-stores-v1-linux-x64-8b01d1f8abd1edb3");
	});

	test("an unborn HEAD and a missing directory still give keys (#4748)", async () => {
		const base = temporaryDirectory();
		const root = join(base, "empty");
		mkdirSync(root);
		git(root, "init", "-q");
		git(root, "remote", "add", "origin", REMOTE);
		const options = { platform: "linux" as const, arch: "x64", home: base, agentDir: join(base, "agent") };
		const unborn = await blueprintCacheKeys(root, options);
		assert.match(entry(unborn, "git")?.key ?? "", /-unborn$/);
		const missing = await blueprintCacheKeys(join(base, "missing"), options);
		assert.deepEqual(
			missing.entries.map((candidate) => candidate.name),
			["atomic"],
		);
	});

	test("text lists every path under its entry, and nothing prints for no entries (#4748)", () => {
		const text = formatBlueprintCacheKeys(
			{ entries: [{ name: "stores", key: "k", restorePrefix: "p", paths: ["/a", "/b"] }], warnings: [] },
			"text",
		);
		assert.equal(
			text,
			"stores\n  key:            k\n  restore prefix: p\n  paths:          /a\n                  /b\n",
		);
		assert.equal(formatBlueprintCacheKeys({ entries: [], warnings: [] }, "github-output"), "");
	});

	test("the CLI prints help, usage errors, warnings, and failures on the right stream (#4748)", async () => {
		const run = async (args: string[], cwd: string, home?: string) => {
			const out: string[] = [];
			const err: string[] = [];
			const code = await runBlueprintCommand(args, {
				cwd,
				agentDir: join(cwd, "agent"),
				...(home === undefined ? {} : { home }),
				stdout: (text) => out.push(text),
				stderr: (text) => err.push(text),
			});
			return { code, out: out.join(""), err: err.join("") };
		};
		const directory = temporaryDirectory();
		for (const args of [[], ["help"], ["-h"], ["cache-key", "--help"]]) {
			const help = await run(args, directory);
			assert.equal(help.code, 0);
			assert.match(help.out, /^Usage:\n {2}\S+ blueprint cache-key/);
		}
		const unknown = await run(["prebuilt"], directory);
		assert.deepEqual([unknown.code, unknown.out], [2, ""]);
		assert.match(
			unknown.err,
			/^Error: Unknown command "prebuilt"\. Use cache-key or prebuild\. Use "\S+ blueprint --help"/,
		);
		assert.match((await run(["cache-key", "--json=1"], directory)).err, /Unknown option --json\./);
		assert.match((await run(["cache-key", "--format"], directory)).err, /--format must be/);
		assert.match((await run(["cache-key", "a", "b"], directory)).err, /at most one directory/);

		write(directory, ".atomic/blueprint.yaml", forThisHost("cache:\n  - ~/.npm\n  - ~/.ssh\n"));
		const plain = await run(["cache-key", "--format", "json"], directory, join(directory, "..", "home"));
		assert.equal(plain.code, 0);
		const printed = JSON.parse(plain.out) as BlueprintCacheKeys;
		assert.deepEqual(entry(printed, "stores")?.paths, [resolve(directory, "..", "home", ".npm")]);
		assert.equal(entry(printed, "git"), undefined);
		assert.match(plain.err, /^Warning: cache path '~\/\.ssh' is omitted/m);
		const defaultHome = await run(["cache-key", "--format", "json"], directory);
		assert.deepEqual(entry(JSON.parse(defaultHome.out) as BlueprintCacheKeys, "stores")?.paths, [
			join(homedir(), ".npm"),
		]);

		const failed = await run(["cache-key", "missing"], directory);
		assert.deepEqual([failed.code, failed.out], [1, ""]);
		assert.match(failed.err, /^Error: /);
	});
});
