import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, test } from "vitest";
import { parseBlueprintCommand, runBlueprintCommand } from "../src/cli/blueprint-command.js";
import { getExtensionTranspileCacheDir } from "../src/config.js";
import {
	type BlueprintCacheKeyOptions,
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

/** The `resume.cache` setting as JSON: a list of `{ paths, kind, keyFiles }` groups. */
type CacheSetting = readonly Readonly<Record<string, string | number | null | readonly (string | number)[]>>[];

/**
 * A Git checkout with one commit and an `origin`, plus a separate home, agent directory and store. `cache` becomes the
 * project's `resume.cache` setting.
 */
function fixture(
	blueprint: string | undefined,
	files: Readonly<Record<string, string>> = {},
	cache?: CacheSetting | string,
): Fixture {
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
	if (cache !== undefined) setCache(root, cache);
	return { root, home, agentDir, storeDir: join(agentDir, "worktree-snapshots") };
}

/** A plain directory (no Git) holding `files`, with a separate home: enough to detect stores. */
function plainDirectory(files: Readonly<Record<string, string>>): Fixture {
	const base = temporaryDirectory();
	const root = join(base, "repo");
	const home = join(base, "home");
	mkdirSync(root, { recursive: true });
	for (const [path, content] of Object.entries(files)) write(root, path, content);
	const agentDir = join(home, ".atomic", "agent");
	return { root, home, agentDir, storeDir: join(agentDir, "worktree-snapshots") };
}

function write(root: string, path: string, content: string): void {
	const file = join(root, path);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, content);
}

function setCache(root: string, cache: CacheSetting | string): void {
	write(root, ".atomic/settings.json", typeof cache === "string" ? cache : JSON.stringify({ resume: { cache } }));
}

function keysOf(at: Fixture, options: Partial<BlueprintCacheKeyOptions> = {}): Promise<BlueprintCacheKeys> {
	return blueprintCacheKeys(at.root, {
		platform: "linux",
		arch: "x64",
		home: at.home,
		agentDir: at.agentDir,
		storeDir: at.storeDir,
		env: {},
		...options,
	});
}

function entry(keys: BlueprintCacheKeys, name: string) {
	return keys.entries.find((candidate) => candidate.name === name);
}

function names(keys: BlueprintCacheKeys): string[] {
	return keys.entries.map((candidate) => candidate.name);
}

const location = { path: "/repo/.atomic/blueprint.yaml", scope: "repository" as const };

describe("blueprint.yaml stays in Devin's format (#4748)", () => {
	test("the parser ignores a cache: key like any unknown key, with a hint to move it (#4748)", () => {
		const parsed = parseBlueprint(
			"maintenance: npm ci\ncache:\n  - ~/.npm\n  - path: target\n    kind: build\n",
			location,
		);
		const document = parsed.documents[0];
		assert.ok(document !== undefined && !("cache" in document));
		assert.equal(document.maintenance.length, 1);
		assert.deepEqual(
			parsed.warnings.map((warning) => warning.code),
			["cache-ignored"],
		);
		assert.match(parsed.warnings[0]?.message ?? "", /'cache' is ignored.*resume\.cache.*\.atomic\/settings\.json/);
		const unknown = parseBlueprint("maintenance: npm ci\nfuture-key:\n  anything: 1\n", location);
		assert.deepEqual(unknown.warnings, []);
		assert.ok(!("cache" in (unknown.documents[0] ?? {})));
	});

	test("a blueprint with cache: no longer changes the cache entries, and cache-key repeats the hint (#4748)", async () => {
		const declared = fixture(
			"maintenance: npm ci\nclone:\n  depth: 1\ncache:\n  - ~/.cargo/registry\n  - path: target\n    kind: build\n",
			{ "package-lock.json": "{}\n" },
		);
		const plain = fixture("maintenance: npm ci\n", { "package-lock.json": "{}\n" });
		const withCache = await keysOf(declared);
		const without = await keysOf(plain);
		assert.deepEqual(names(withCache), ["stores", "git", "atomic"]);
		assert.deepEqual(names(withCache), names(without));
		assert.deepEqual(entry(withCache, "stores")?.paths, [join(declared.home, ".npm")]);
		assert.deepEqual(without.warnings, []);
		assert.equal(withCache.warnings.length, 1);
		assert.match(withCache.warnings[0] ?? "", /'cache' is ignored.*resume\.cache/);
		write(declared.root, ".atomic/blueprint.yaml", "maintenance:\n  - uses: not-a-reference\ncache: [~/.npm]\n");
		const invalid = await keysOf(declared);
		assert.deepEqual(names(invalid), ["stores", "git", "atomic"]);
		assert.deepEqual(invalid.warnings, []);
	});
});

describe("store detection (#4748)", () => {
	const cases: readonly { files: readonly string[]; stores: readonly string[] }[] = [
		{ files: ["package-lock.json"], stores: [".npm"] },
		{ files: ["npm-shrinkwrap.json"], stores: [".npm"] },
		{ files: ["pnpm-lock.yaml"], stores: [".local/share/pnpm/store"] },
		{ files: ["yarn.lock"], stores: [".cache/yarn"] },
		{ files: ["yarn.lock", ".yarnrc.yml"], stores: [".yarn/berry/cache"] },
		{ files: ["bun.lock"], stores: [".bun/install/cache"] },
		{ files: ["bun.lockb"], stores: [".bun/install/cache"] },
		{ files: ["Cargo.lock"], stores: [".cargo/registry", ".cargo/git"] },
		{ files: ["uv.lock"], stores: [".cache/uv"] },
		{ files: ["requirements.txt"], stores: [".cache/pip"] },
		{ files: ["Pipfile.lock"], stores: [".cache/pip"] },
		{ files: ["poetry.lock"], stores: [".cache/pypoetry"] },
		{ files: ["go.sum"], stores: ["go/pkg/mod", ".cache/go-build"] },
		{ files: ["build.gradle.kts"], stores: [".gradle/caches", ".gradle/wrapper"] },
		{ files: ["gradle/wrapper/gradle-wrapper.properties"], stores: [".gradle/caches", ".gradle/wrapper"] },
		{ files: ["build.gradle"], stores: [".gradle/caches", ".gradle/wrapper"] },
		{ files: ["settings.gradle.kts"], stores: [".gradle/caches", ".gradle/wrapper"] },
		{ files: ["gradle.lockfile"], stores: [".gradle/caches", ".gradle/wrapper"] },
		{ files: ["pom.xml"], stores: [".m2/repository"] },
	];

	test("each package manager's store is detected from its lockfile at its standard location (#4748)", async () => {
		for (const { files, stores } of cases) {
			const at = plainDirectory(Object.fromEntries(files.map((file) => [file, "x\n"])));
			const keys = await keysOf(at);
			assert.deepEqual(
				entry(keys, "stores")?.paths,
				stores.map((store) => join(at.home, ...store.split("/"))),
				files.join(", "),
			);
			assert.match(entry(keys, "stores")?.key ?? "", /^atomic-stores-v1-linux-x64-[0-9a-f]{16}$/);
		}
		const none = await keysOf(plainDirectory({ "README.md": "x\n", "package.json": "{}\n" }));
		assert.deepEqual(names(none), ["atomic"]);
	});

	test("store locations follow macOS and Windows defaults (#4748)", async () => {
		const at = plainDirectory({
			"package-lock.json": "{}\n",
			"pnpm-lock.yaml": "x\n",
			"yarn.lock": "x\n",
			"uv.lock": "x\n",
			"requirements.txt": "x\n",
			"poetry.lock": "x\n",
			"go.sum": "x\n",
		});
		const under = (...segments: string[]) => join(at.home, ...segments);
		assert.deepEqual(entry(await keysOf(at, { platform: "darwin" }), "stores")?.paths, [
			under(".npm"),
			under("Library", "pnpm", "store"),
			under("Library", "Caches", "Yarn"),
			under(".cache", "uv"),
			under("Library", "Caches", "pip"),
			under("Library", "Caches", "pypoetry"),
			under("go", "pkg", "mod"),
			under("Library", "Caches", "go-build"),
		]);
		const local = under("AppData", "Local");
		const windows = await keysOf(at, { platform: "win32" });
		assert.deepEqual(entry(windows, "stores")?.paths, [
			join(local, "npm-cache"),
			join(local, "pnpm", "store"),
			join(local, "Yarn", "Cache"),
			join(local, "uv", "cache"),
			join(local, "pip", "Cache"),
			join(local, "pypoetry", "Cache"),
			under("go", "pkg", "mod"),
			join(local, "go-build"),
		]);
		assert.match(entry(windows, "stores")?.key ?? "", /^atomic-stores-v1-windows-x64-/);
		const moved = await keysOf(at, { platform: "win32", env: { LOCALAPPDATA: join(at.home, "Local") } });
		assert.equal(entry(moved, "stores")?.paths[0], join(at.home, "Local", "npm-cache"));
	});

	test("store locations follow each package manager's environment variables (#4748)", async () => {
		const at = plainDirectory({
			"package-lock.json": "{}\n",
			"pnpm-lock.yaml": "x\n",
			"yarn.lock": "x\n",
			"bun.lock": "x\n",
			"Cargo.lock": "x\n",
			"uv.lock": "x\n",
			"requirements.txt": "x\n",
			"poetry.lock": "x\n",
			"go.sum": "x\n",
			"settings.gradle": "x\n",
		});
		const outside = (...segments: string[]) => join(at.home, "..", "ci", ...segments);
		const env = {
			npm_config_cache: outside("npm"),
			npm_config_store_dir: outside("pnpm"),
			YARN_CACHE_FOLDER: outside("yarn"),
			BUN_INSTALL_CACHE_DIR: outside("bun"),
			CARGO_HOME: outside("cargo"),
			UV_CACHE_DIR: outside("uv"),
			PIP_CACHE_DIR: outside("pip"),
			POETRY_CACHE_DIR: outside("poetry"),
			GOMODCACHE: outside("gomod"),
			GOCACHE: outside("gobuild"),
			GRADLE_USER_HOME: outside("gradle"),
		};
		assert.deepEqual(entry(await keysOf(at, { env }), "stores")?.paths, [
			outside("npm"),
			outside("pnpm"),
			outside("yarn"),
			outside("bun"),
			outside("cargo", "registry"),
			outside("cargo", "git"),
			outside("uv"),
			outside("pip"),
			outside("poetry"),
			outside("gomod"),
			outside("gobuild"),
			outside("gradle", "caches"),
			outside("gradle", "wrapper"),
		]);
		const xdg = {
			XDG_CACHE_HOME: outside("xdg-cache"),
			XDG_DATA_HOME: outside("xdg-data"),
			PNPM_HOME: undefined,
			BUN_INSTALL: outside("bun-home"),
			GOPATH: outside("gopath"),
		};
		assert.deepEqual(entry(await keysOf(at, { env: xdg }), "stores")?.paths, [
			join(at.home, ".npm"),
			outside("xdg-data", "pnpm", "store"),
			outside("xdg-cache", "yarn"),
			outside("bun-home", "install", "cache"),
			join(at.home, ".cargo", "registry"),
			join(at.home, ".cargo", "git"),
			outside("xdg-cache", "uv"),
			outside("xdg-cache", "pip"),
			outside("xdg-cache", "pypoetry"),
			outside("gopath", "pkg", "mod"),
			outside("xdg-cache", "go-build"),
			join(at.home, ".gradle", "caches"),
			join(at.home, ".gradle", "wrapper"),
		]);
		const empty = await keysOf(at, { env: { npm_config_cache: "", CARGO_HOME: "" } });
		assert.equal(entry(empty, "stores")?.paths[0], join(at.home, ".npm"));
		const berry = await keysOf(plainDirectory({ "yarn.lock": "x\n", ".yarnrc.yml": "x\n" }), {
			env: { YARN_GLOBAL_FOLDER: outside("berry"), YARN_CACHE_FOLDER: outside("yarn") },
		});
		assert.deepEqual(entry(berry, "stores")?.paths, [outside("berry", "cache")]);
		const pnpmHome = await keysOf(plainDirectory({ "pnpm-lock.yaml": "x\n" }), {
			env: { PNPM_HOME: outside("pnpm-home") },
		});
		assert.deepEqual(entry(pnpmHome, "stores")?.paths, [outside("pnpm-home", "store")]);
	});

	test("detected store keys follow their lockfiles and the blueprint, not unrelated files (#4748)", async () => {
		const at = fixture("maintenance: npm ci\n", { "package-lock.json": "{}\n" });
		const first = await keysOf(at);
		assert.deepEqual(await keysOf(at), first);
		write(at.root, "src/index.js", "changed\n");
		assert.equal(entry(await keysOf(at), "stores")?.key, entry(first, "stores")?.key);
		write(at.root, "package-lock.json", '{"lockfileVersion":3}\n');
		const lockChanged = await keysOf(at);
		assert.notEqual(entry(lockChanged, "stores")?.key, entry(first, "stores")?.key);
		assert.equal(entry(lockChanged, "atomic")?.key, entry(first, "atomic")?.key);
		write(at.root, ".atomic/blueprint.yaml", "maintenance: npm ci --prefer-offline\n");
		assert.notEqual(entry(await keysOf(at), "stores")?.key, entry(lockChanged, "stores")?.key);
		assert.notEqual(entry(await keysOf(at, { arch: "arm64" }), "stores")?.key, entry(lockChanged, "stores")?.key);
	});

	test("detected store keys are stable across machines and releases, and an unreadable blueprint counts as absent (#4748)", async () => {
		const files = { "package-lock.json": "{}\n", "Cargo.lock": "x\n", "pom.xml": "<project/>\n" };
		const at = plainDirectory(files);
		const pinned = "atomic-stores-v1-linux-x64-1b46d9e12987cc07";
		assert.equal(entry(await keysOf(at), "stores")?.key, pinned);
		const elsewhere = plainDirectory(files);
		assert.equal(
			entry(await keysOf(elsewhere, { env: { CARGO_HOME: join(elsewhere.home, "cargo") } }), "stores")?.key,
			pinned,
		);
		mkdirSync(join(at.root, ".atomic", "blueprint.yaml"), { recursive: true });
		assert.equal(entry(await keysOf(at), "stores")?.key, pinned);
		write(elsewhere.root, ".atomic", "not a directory\n");
		assert.equal(entry(await keysOf(elsewhere), "stores")?.key, pinned);
	});

	test("a store an environment variable points at credentials or into the worktree is refused (#4748)", async () => {
		const at = plainDirectory({ "package-lock.json": "{}\n", "Cargo.lock": "x\n", "uv.lock": "x\n" });
		const keys = await keysOf(at, {
			env: {
				npm_config_cache: join(at.home, ".ssh", "npm"),
				CARGO_HOME: at.home,
				UV_CACHE_DIR: join(at.root, "uv"),
			},
		});
		assert.deepEqual(entry(keys, "stores")?.paths, [join(at.home, "registry"), join(at.home, "git")]);
		assert.equal(keys.warnings.filter((warning) => warning.startsWith("cache path")).length, 2);
		assert.match(keys.warnings.join("\n"), /\.ssh.*credentials/);
		assert.match(keys.warnings.join("\n"), /uv'.*outside the worktree/);
		const patterns = await keysOf(at, {
			env: {
				npm_config_cache: join(at.home, ".ss[h]"),
				CARGO_HOME: join(at.home, "cargo\nx"),
				UV_CACHE_DIR: "/opt/uv",
			},
		});
		assert.deepEqual(entry(patterns, "stores")?.paths, [resolve("/opt/uv")]);
		const omitted = patterns.warnings.filter((warning) => warning.startsWith("cache path"));
		assert.equal(omitted.length, 3, patterns.warnings.join("\n"));
		for (const warning of omitted) assert.match(warning, /plain single-line path/);
	});
});

describe("resume.cache settings overrides (#4748)", () => {
	test("a checkout without lockfiles or resume.cache gives only the git and atomic entries (#4748)", async () => {
		const at = fixture("maintenance: npm ci\n");
		const keys = await keysOf(at);
		assert.deepEqual(names(keys), ["git", "atomic"]);
		const head = git(at.root, "rev-parse", "HEAD");
		const store = objectStorePath(at.storeDir, [REMOTE]);
		const repositoryId = basename(store, ".git");
		assert.deepEqual(entry(keys, "git"), {
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

	test("resume.cache adds stores after the detected ones, once each, keyed by each input (#4748)", async () => {
		const at = fixture(undefined, { "package-lock.json": "{}\n" }, [{ paths: ["~/.npm", "~/.cache/custom"] }]);
		const first = await keysOf(at);
		const stores = entry(first, "stores");
		assert.deepEqual(stores?.paths, [join(at.home, ".npm"), join(at.home, ".cache", "custom")]);
		assert.equal(stores?.restorePrefix, "atomic-stores-v1-linux-x64-");
		const mac = await keysOf(at, { platform: "darwin" });
		assert.deepEqual(entry(mac, "stores")?.paths, stores?.paths);
		assert.match(entry(mac, "stores")?.key ?? "", /^atomic-stores-v1-macos-x64-/);
		assert.match(entry(mac, "git")?.key ?? "", /^atomic-git-v1-macos-/);
		setCache(at.root, [{ paths: ["~/.npm", "~/.cache/custom", "~/.cache/other"] }]);
		assert.notEqual(entry(await keysOf(at), "stores")?.key, stores?.key);
	});

	test("a path both detected and declared is listed once and keyed by every declaration's inputs (#4748)", async () => {
		const at = fixture(undefined, { "Cargo.lock": "x\n", "rust-toolchain.toml": "1\n" }, [
			{ paths: ["~/.cargo/registry"], keyFiles: ["Cargo.lock", "rust-toolchain.toml"] },
		]);
		const first = entry(await keysOf(at), "stores");
		assert.deepEqual(first?.paths, [join(at.home, ".cargo", "registry"), join(at.home, ".cargo", "git")]);
		write(at.root, "rust-toolchain.toml", "2\n");
		assert.notEqual(entry(await keysOf(at), "stores")?.key, first?.key);
	});

	test("global settings declare resume.cache too, and the project's replaces it (#4748)", async () => {
		const at = fixture(undefined);
		write(at.agentDir, "settings.json", JSON.stringify({ resume: { cache: [{ paths: ["/opt/global"] }] } }));
		assert.deepEqual(entry(await keysOf(at), "stores")?.paths, [resolve("/opt/global")]);
		setCache(at.root, [{ paths: ["/opt/project"] }]);
		assert.deepEqual(entry(await keysOf(at), "stores")?.paths, [resolve("/opt/project")]);
	});

	test("keyFiles replace the environment hash, and a build entry keys and places its seeds apart (#4748)", async () => {
		const at = fixture(undefined, { "Cargo.lock": "v1\n", "package-lock.json": "{}\n" }, [
			{ paths: ["/opt/registry"], keyFiles: ["Cargo.lock"] },
			{ paths: ["target"], kind: "build", keyFiles: ["Cargo.lock"] },
		]);
		const unkeyed = fixture(undefined, { "Cargo.lock": "v1\n" }, [{ paths: ["target"], kind: "build" }]);
		const first = await keysOf(at);
		const firstUnkeyed = await keysOf(unkeyed);
		write(at.root, "package-lock.json", '{"changed":true}\n');
		const unrelated = await keysOf(at);
		assert.equal(entry(unrelated, "build")?.key, entry(first, "build")?.key);
		write(at.root, "Cargo.lock", "v2\n");
		write(unkeyed.root, "Cargo.lock", "v2\n");
		const declared = await keysOf(at);
		assert.notEqual(entry(declared, "build")?.key, entry(first, "build")?.key);
		assert.notEqual(entry(await keysOf(unkeyed), "build")?.key, entry(firstUnkeyed, "build")?.key);

		const build = entry(first, "build");
		const repositoryId = basename(objectStorePath(at.storeDir, [REMOTE]), ".git");
		assert.match(build?.key ?? "", /^atomic-build-v1-linux-x64-[0-9a-f]{16}$/);
		assert.notEqual(build?.key.slice(-16), entry(first, "stores")?.key.slice(-16));
		assert.deepEqual(build?.paths, [
			join(at.storeDir, "seeds", repositoryId, "target"),
			join(at.storeDir, "seeds", `${repositoryId}.json`),
		]);
	});

	test("a wrong-typed resume setting is ignored with its own warning, not as an unreadable file (#4902)", async () => {
		const at = fixture(undefined);
		write(at.agentDir, "settings.json", JSON.stringify({ resume: "cache everything", extensions: "./x.ts" }));
		const keys = await keysOf(at);
		assert.deepEqual(names(keys), ["git", "atomic"]);
		assert.deepEqual(keys.warnings, [
			`${join(at.agentDir, "settings.json")}: "resume" must be object, not string; ignoring it.`,
		]);
	});

	test("a store path inside the worktree is refused with a warning (#4748)", async () => {
		const at = fixture(undefined);
		setCache(at.root, [{ paths: ["node_modules", join(at.root, "dist"), "~/.npm"] }]);
		const keys = await keysOf(at);
		assert.deepEqual(entry(keys, "stores")?.paths, [join(at.home, ".npm")]);
		assert.equal(keys.warnings.length, 2);
		for (const warning of keys.warnings) assert.match(warning, /outside the worktree/);
	});

	test("paths that could carry secrets are omitted with a warning (#4748)", async () => {
		const at = fixture(undefined, {}, [
			{ paths: ["~/.cargo", "~/.config/gh", "~/.ssh/known", "~/.npmrc", "~", "~/.cargo/registry"] },
			{ paths: [".env.local", "target"], kind: "build" },
		]);
		const keys = await keysOf(at);
		assert.deepEqual(entry(keys, "stores")?.paths, [join(at.home, ".cargo", "registry")]);
		assert.equal(entry(keys, "build")?.paths.length, 2, "target and the seed manifest");
		assert.equal(keys.warnings.length, 6);
		for (const warning of keys.warnings) assert.match(warning, /credentials/, keys.warnings.join("\n"));
	});

	test("refusing every store path drops the stores entry (#4748)", async () => {
		const at = fixture(undefined, {}, [{ paths: ["~/.ssh"] }]);
		const keys = await keysOf(at);
		assert.deepEqual(names(keys), ["git", "atomic"]);
		assert.match(keys.warnings[0] ?? "", /credentials/);
	});

	test("a directory without a Git remote omits the git and build entries with a warning (#4748)", async () => {
		const root = temporaryDirectory();
		const home = temporaryDirectory();
		setCache(root, [{ paths: ["~/.npm"] }, { paths: ["target"], kind: "build" }]);
		const keys = await blueprintCacheKeys(root, { platform: "linux", arch: "x64", home, agentDir: home, env: {} });
		assert.deepEqual(names(keys), ["stores", "atomic"]);
		assert.match(keys.warnings.join("\n"), /remote/);
	});

	test("resume.cache entries are trimmed and normalized, and each malformed field is named (#4748)", async () => {
		const at = fixture(undefined, {}, [
			{ paths: ["  /opt/a  ", "a\nb", 5, "", "   "] },
			{ paths: ["/opt/uv"], kind: null, keyFiles: null },
			{ paths: ["/opt/x"], kind: "artifact" },
			{ kind: "build" },
			{ paths: "/opt/x" },
			{ paths: ["/opt/x"], keyFiles: [] },
			{ paths: ["/opt/x"], keyFiles: "x.lock" },
			{ paths: ["/opt/x"], keyFiles: ["/abs.lock"] },
			{ paths: ["/opt/x"], keyFiles: ["C:/x.lock"] },
			{ paths: ["/opt/x"], keyFiles: ["ok.lock", "../x.lock"] },
			{ paths: ["/opt/x"], keyFiles: ["..\\x.lock"] },
			{ paths: ["/opt/x"], keyFiles: [""] },
			{ paths: ["/opt/x"], keyFiles: [5] },
		]);
		const keys = await keysOf(at);
		assert.deepEqual(entry(keys, "stores")?.paths, [resolve("/opt/a"), resolve("/opt/uv")]);
		assert.equal(keys.warnings.length, 15, keys.warnings.join("\n"));
		for (const warning of keys.warnings.slice(0, 4)) assert.match(warning, /^resume\.cache\[0\]\.paths\[\d\]:.*path/);
		assert.match(keys.warnings[4] ?? "", /^resume\.cache\[2\]: 'kind' must be 'store' or 'build'/);
		assert.match(keys.warnings[5] ?? "", /^resume\.cache\[3\]: 'paths' must be a list/);
		assert.match(keys.warnings[6] ?? "", /^resume\.cache\[4\]: 'paths' must be a list/);
		for (const warning of keys.warnings.slice(7)) assert.match(warning, /'keyFiles' must be a list/);

		for (const [setting, pattern] of [
			['{"resume":{"cache":5}}', /^resume\.cache must be a list/],
			['{"resume":{"cache":{"paths":["/opt/single"]}}}', /^resume\.cache must be a list/],
			['{"resume":{"cache":[7]}}', /^resume\.cache\[0\]: an entry must be/],
			['{"resume":{"cache":[null]}}', /^resume\.cache\[0\]: an entry must be/],
		] as const) {
			setCache(at.root, setting);
			const invalid = await keysOf(at);
			assert.deepEqual(names(invalid), ["git", "atomic"]);
			assert.match(invalid.warnings[0] ?? "", pattern);
		}
		for (const setting of ['{"resume":{"cache":null}}', '{"compaction":{"background":"yes"}}']) {
			setCache(at.root, setting);
			assert.deepEqual((await keysOf(at)).warnings, [], setting);
		}
	});

	test("keyFiles written with backslashes name the same root-relative file (#4748)", async () => {
		const at = fixture(undefined, { "locks/uv.lock": "1\n" }, [{ paths: ["/opt/uv"], keyFiles: ["locks\\uv.lock"] }]);
		const first = entry(await keysOf(at), "stores")?.key;
		write(at.root, "locks/uv.lock", "2\n");
		assert.notEqual(entry(await keysOf(at), "stores")?.key, first);
	});

	test("a cache path with glob characters or a leading ! is ignored, so it cannot match credentials (#4748)", async () => {
		const at = fixture(undefined, {}, [
			{ paths: ["~/.ss[h]/*", "~/.npm/**", "!~/.npm", " !~/.npm", "~/{a,b}", "~/x?", "~/.npm", "~/a!b"] },
			{ paths: ["targe[t]"], kind: "build" },
		]);
		const keys = await keysOf(at);
		assert.deepEqual(entry(keys, "stores")?.paths, [join(at.home, ".npm"), join(at.home, "a!b")]);
		assert.equal(entry(keys, "build"), undefined);
		assert.equal(keys.warnings.length, 7);
		for (const warning of keys.warnings) assert.match(warning, /glob characters/);
	});

	test("build paths must stay inside the worktree, outside .git, and off credential files (#4748)", async () => {
		const at = fixture(undefined, {}, [
			{
				paths: ["/abs/out", "~/out", "C:/out", "../out", ".git/hooks", ".", ".npmrc", "./dist/"],
				kind: "build",
			},
		]);
		const keys = await keysOf(at);
		const seeds = join(at.storeDir, "seeds", basename(objectStorePath(at.storeDir, [REMOTE]), ".git"));
		assert.deepEqual(entry(keys, "build")?.paths, [join(seeds, "dist"), `${seeds}.json`]);
		assert.equal(keys.warnings.length, 7);
		for (const warning of keys.warnings.slice(0, 3)) assert.match(warning, /relative to the repository root/);
		for (const warning of keys.warnings.slice(3, 6)) assert.match(warning, /inside the worktree, outside \.git/);
		assert.match(keys.warnings[6] ?? "", /'\.npmrc'.*credentials/);
	});

	test("store paths expand ~ either way and refuse the worktree's ancestors and Atomic's credentials (#4748)", async () => {
		const at = fixture(undefined);
		const outside = join(at.home, "..", "shared-cache");
		setCache(at.root, [{ paths: ["~\\.npm", outside, "/", join(at.root, ".."), "~/.atomic"] }]);
		const keys = await keysOf(at);
		assert.deepEqual(entry(keys, "stores")?.paths, [join(at.home, ".npm"), resolve(outside)]);
		assert.equal(keys.warnings.length, 3);
		assert.match(keys.warnings[0] ?? "", /'\/'.*outside the worktree/);
		assert.match(keys.warnings[1] ?? "", /outside the worktree/);
		assert.match(keys.warnings[2] ?? "", /'~\/\.atomic'.*credentials/);
	});

	test("a child named like '..keys' is inside its parent, so credential locations stay refused (#4748)", async () => {
		const at = fixture(undefined, {}, [
			{ paths: ["~/.ssh/..keys", "~/.ssh/keys", "~/..ssh-like", "~/.cargo/..credentials"] },
		]);
		const keys = await keysOf(at);
		assert.deepEqual(entry(keys, "stores")?.paths, [
			join(at.home, "..ssh-like"),
			join(at.home, ".cargo", "..credentials"),
		]);
		assert.equal(keys.warnings.length, 2, keys.warnings.join("\n"));
		assert.match(keys.warnings[0] ?? "", /'~\/\.ssh\/\.\.keys'.*credentials/);
		assert.match(keys.warnings[1] ?? "", /'~\/\.ssh\/keys'.*credentials/);
	});

	test("a worktree or store named like '..repo' is still seen inside the other (#4748)", async () => {
		const base = temporaryDirectory();
		const root = join(base, "..repo");
		const home = join(base, "home", "user");
		mkdirSync(root, { recursive: true });
		setCache(root, [{ paths: [base, join(root, "..cache"), join(base, "..sibling")] }]);
		const keys = await blueprintCacheKeys(root, {
			platform: "linux",
			arch: "x64",
			home,
			agentDir: join(home, "agent"),
			env: {},
		});
		assert.deepEqual(entry(keys, "stores")?.paths, [join(base, "..sibling")]);
		const omitted = keys.warnings.filter((warning) => warning.startsWith("cache path"));
		assert.equal(omitted.length, 2, keys.warnings.join("\n"));
		for (const warning of omitted) assert.match(warning, /outside the worktree/);
	});

	test("credential checks fold case and follow symbolic links (#4748)", async () => {
		const at = fixture(undefined);
		mkdirSync(join(at.home, ".ssh"), { recursive: true });
		mkdirSync(join(at.home, "tools"), { recursive: true });
		const link = process.platform === "win32" ? "junction" : "dir";
		symlinkSync(join(at.home, ".ssh"), join(at.home, "keys"), link);
		symlinkSync(at.home, join(at.home, "tools", "home"), link);
		setCache(at.root, [
			{ paths: ["~/.SSH", "~/.Config/GH/hosts", "~/.NPMRC", "~/keys", "~/tools/home", "~/", "~/tools"] },
			{ paths: [".ENV.local", ".NPMRC"], kind: "build" },
		]);
		const keys = await keysOf(at);
		assert.deepEqual(entry(keys, "stores")?.paths, [join(at.home, "tools")]);
		assert.equal(keys.warnings.length, 8, keys.warnings.join("\n"));
		for (const warning of keys.warnings) assert.match(warning, /credentials/);
	});

	test("a missing or directory key file counts as absent, and keys are stable across releases (#4748)", async () => {
		const at = fixture(undefined, {}, [{ paths: ["/opt/store"], keyFiles: ["deps.lock", "deps", "README.md/x"] }]);
		mkdirSync(join(at.root, "deps"));
		const absent = entry(await keysOf(at), "stores")?.key;
		assert.equal(absent, "atomic-stores-v1-linux-x64-a602ebfba426fb26");
		write(at.root, "deps.lock", "1\n");
		assert.equal(entry(await keysOf(at), "stores")?.key, "atomic-stores-v1-linux-x64-c50ad7a1f30a90e3");
	});

	test("an unparseable settings file is left out with a warning (#4748)", async () => {
		const at = fixture(undefined, { "package-lock.json": "{}\n" }, "{ not json");
		const keys = await keysOf(at);
		assert.deepEqual(entry(keys, "stores")?.paths, [join(at.home, ".npm")]);
		assert.match(keys.warnings.join("\n"), /settings\.json.*resume\.cache is ignored/);
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
		const at = fixture(forThisHost("maintenance: npm ci\n"), { "package-lock.json": "{}\n" });
		mkdirSync(join(at.root, "src"));
		const out: string[] = [];
		const err: string[] = [];
		const code = await runBlueprintCommand(["cache-key", "src", "--format", "github-output"], {
			cwd: at.root,
			agentDir: at.agentDir,
			home: at.home,
			env: {},
			stdout: (text) => out.push(text),
			stderr: (text) => err.push(text),
		});
		assert.equal(code, 0);
		const printed = out.join("");
		assert.match(printed, /^stores-key=atomic-stores-v1-/m);
		// The CLI keys this host's platform: npm keeps its store in %LOCALAPPDATA%\npm-cache on Windows, ~/.npm elsewhere.
		const npmStore =
			process.platform === "win32" ? join(at.home, "AppData", "Local", "npm-cache") : join(at.home, ".npm");
		assert.ok(printed.split("\n").includes(`stores-paths=${npmStore}`), printed);
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

	test("an unborn HEAD and a missing directory still give keys (#4748)", async () => {
		const base = temporaryDirectory();
		const root = join(base, "empty");
		mkdirSync(root);
		git(root, "init", "-q");
		git(root, "remote", "add", "origin", REMOTE);
		const options = { platform: "linux" as const, arch: "x64", home: base, agentDir: join(base, "agent"), env: {} };
		const unborn = await blueprintCacheKeys(root, options);
		assert.match(entry(unborn, "git")?.key ?? "", /-unborn$/);
		const missing = await blueprintCacheKeys(join(base, "missing"), options);
		assert.deepEqual(names(missing), ["atomic"]);
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
				env: {},
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

		setCache(directory, [{ paths: ["~/.npm", "~/.ssh"] }]);
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
