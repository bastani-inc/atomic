/**
 * The cache contract for runners (#4748): the package stores a repository's lockfiles name, any extra store or build
 * paths its `resume.cache` setting declares, plus Atomic's Git object store and its extension transpile cache, each
 * with an `actions/cache`-style key, a restore prefix and the paths to save. Atomic never uploads or downloads caches;
 * a runner's cache action does, and only a trusted job saves. `.atomic/blueprint.yaml` keeps Devin's format: nothing
 * here is declared in it. Package stores verify what they read, so `"kind": "store"` is the default; build output
 * is opt-in.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse, posix, relative, resolve, sep } from "node:path";
import { getAgentDir, getExtensionTranspileCacheDir, getProjectBlueprintPath, VERSION } from "../../../config.js";
import { SettingsManager } from "../../settings-manager.ts";
import { readRepositoryConfig } from "../../worktree-snapshot/capture.ts";
import { computeEnvironmentHash, sha256Hex } from "../../worktree-snapshot/env-hash.ts";
import { runGit } from "../../worktree-snapshot/git.ts";
import { canonicalizeWorktreePath } from "../../worktree-snapshot/paths.ts";
import { isDeniedSnapshotPath } from "../../worktree-snapshot/policy.ts";
import { repositoryIdOf } from "../../worktree-snapshot/repository-identity.ts";
import { objectStorePath } from "../../worktree-snapshot/restore.ts";
import { seedDirectory, seedManifestPath } from "../../worktree-snapshot/seeds.ts";
import { detectPackageManagerStores } from "./cache-stores.ts";
import { blueprintPlatformOf, parseBlueprint } from "./schema.ts";

/** Bumped when the key derivation changes, so no runner restores an entry keyed the old way. */
const KEY_VERSION = "v1";

export type BlueprintCacheName = "stores" | "build" | "git" | "atomic";

export interface BlueprintCacheKeyEntry {
	readonly name: BlueprintCacheName;
	/** The exact key to save under and restore first, such as `atomic-stores-v1-linux-x64-<hex16>`. */
	readonly key: string;
	/** The prefix to restore the newest older entry by, such as `atomic-stores-v1-linux-x64-`. */
	readonly restorePrefix: string;
	/** Absolute paths, detected stores first, then `resume.cache` paths in declaration order. */
	readonly paths: readonly string[];
}

export interface BlueprintCacheKeys {
	/** `stores` and `build` appear when they keep a path; `git` when the checkout has a remote; `atomic` always. */
	readonly entries: readonly BlueprintCacheKeyEntry[];
	/** Why a path, a `resume.cache` entry or an entry was left out. */
	readonly warnings: readonly string[];
}

export interface BlueprintCacheKeyOptions {
	/** The platform the keys and the detected store locations name. Default: this process's. */
	readonly platform?: NodeJS.Platform;
	/** The architecture the keys name. Default: this process's. */
	readonly arch?: string;
	/** What `~` expands to and where default store locations are. Default: the user's home directory. */
	readonly home?: string;
	/** The environment whose variables move package-manager stores, such as `CARGO_HOME`. Default: this process's. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** The agent directory whose settings and transpile cache are used. Default: the one in effect. */
	readonly agentDir?: string;
	/** The restore store whose Git object store and seeds the entries name. Default: `<agentDir>/worktree-snapshots`. */
	readonly storeDir?: string;
}

/**
 * What a `resume.cache` entry holds: `store` (the default) is a package manager's store outside the worktree; `build`
 * is build output inside the worktree that only a trusted prebuild parks for a cache save.
 */
export type CacheKind = "store" | "build";

/** One path of a `resume.cache` entry, as written. Paths are resolved and checked when the cache keys are computed. */
interface CacheSetting {
	readonly path: string;
	readonly kind: CacheKind;
	/** Root-relative files whose content keys the path; undefined keys it by the environment hash inputs. */
	readonly keyFiles: readonly string[] | undefined;
}

/** One path of the `stores` or `build` entry and what keys it. */
interface CacheMember {
	readonly path: string;
	/** What the key digests besides the key files: how the path was declared or detected. */
	readonly declaration: readonly (string | null | readonly string[])[];
	readonly keyFiles: readonly string[] | undefined;
}

/**
 * Credential locations under the home directory. A path that is one of them, inside one, or contains one is omitted,
 * so `~/.cargo/registry` is kept and `~/.cargo` is not.
 */
const HOME_CREDENTIAL_PATHS: readonly string[] = [
	".aws",
	".azure",
	".cargo/credentials",
	".cargo/credentials.toml",
	".config/gcloud",
	".config/gh",
	".docker/config.json",
	".gem/credentials",
	".git-credentials",
	".gnupg",
	".gradle/gradle.properties",
	".kube",
	".m2/settings.xml",
	".netrc",
	".npmrc",
	".pypirc",
	".ssh",
	".terraform.d/credentials.tfrc.json",
	".yarnrc.yml",
];

/** Root-relative files that commonly carry registry tokens, which a build path may not name. */
const WORKTREE_CREDENTIAL_FILES: ReadonlySet<string> = new Set([".npmrc", ".pypirc", ".yarnrc.yml"]);

/**
 * The cache keys and paths of the repository at `root` (its top level). A pure function of the inputs: the lockfiles
 * at the root and the package-manager stores they name, the `resume.cache` setting, the root blueprint's content, the
 * files that key each entry, the checkout's remotes and HEAD, the Atomic version, `platform` and `arch`. Paths that
 * could carry secrets, store paths inside the worktree and build paths outside it are omitted with a warning; an
 * invalid `resume.cache` entry only warns.
 */
export async function blueprintCacheKeys(
	root: string,
	options: BlueprintCacheKeyOptions = {},
): Promise<BlueprintCacheKeys> {
	const os = blueprintPlatformOf(options.platform ?? process.platform);
	const arch = options.arch ?? process.arch;
	const home = resolve(options.home ?? homedir());
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const storeDir = resolve(options.storeDir ?? join(agentDir, "worktree-snapshots"));
	const warnings: string[] = [];
	const blueprint = await blueprintDigest(root, warnings);
	const detected = await detectPackageManagerStores(root, { os, home, env: options.env ?? process.env });
	const settings = settingsCache(root, agentDir, warnings);
	const remotes = await checkoutRemotes(root);
	const store = remotes.length > 0 ? objectStorePath(storeDir, remotes) : undefined;
	// Normalized, so a runner's HTTPS checkout names the entries a session recorded over SSH names too.
	const repository = repositoryIdOf(remotes);
	if (store === undefined) warnings.push("the checkout has no Git remote; the git and build entries are omitted");

	const stores: CacheMember[] = [];
	const builds: CacheMember[] = [];
	const addStore = (declared: string, member: Omit<CacheMember, "path">) => {
		const refusal = refuseStore(declared, root, home, agentDir);
		const path = storePath(declared, home);
		// A path declared twice is listed once, and every declaration's key inputs still key the entry.
		if (refusal !== undefined) warnings.push(`cache path '${declared}' is omitted: ${refusal}`);
		else stores.push({ ...member, path });
	};
	for (const { manager, keyFiles, paths } of detected) {
		for (const path of paths) addStore(path, { declaration: ["detected", manager], keyFiles });
	}
	for (const setting of settings) {
		const member = {
			declaration: [setting.path, setting.kind, setting.keyFiles ?? null],
			keyFiles: setting.keyFiles,
		};
		if (setting.kind === "store") {
			addStore(setting.path, member);
			continue;
		}
		const refusal = refuseBuild(setting.path);
		if (refusal !== undefined) {
			warnings.push(`cache path '${setting.path}' is omitted: ${refusal}`);
		} else if (store !== undefined) {
			builds.push({ ...member, path: join(seedDirectory(storeDir, repository), ...buildSegments(setting.path)) });
		}
	}

	// The OS and architecture are in each prefix, and the paths, which name the repository for `build`, are part of a
	// cache entry's version, so a digest covers only the blueprint, the declarations and the files that key them.
	const entries: BlueprintCacheKeyEntry[] = [];
	const inputs = new InputDigests(root);
	const prefix = (name: BlueprintCacheName) => `atomic-${name}-${KEY_VERSION}-${os}-${arch}-`;
	for (const [name, members] of [
		["stores", stores],
		["build", builds],
	] as const) {
		if (members.length === 0) continue;
		const restorePrefix = prefix(name);
		const key = `${restorePrefix}${await membersDigest(blueprint, members, inputs)}`;
		const paths = [...new Set(members.map((member) => member.path))];
		// The seed manifest says which commit and environment the parked build output belongs to.
		if (name === "build") paths.push(seedManifestPath(storeDir, repository));
		entries.push({ name, key, restorePrefix, paths });
	}
	if (store !== undefined) {
		// The store is append-only and portable across architectures: a new HEAD saves a new entry, and a restore takes
		// the newest by prefix; fetches fill any gap and every restore verifies its tree.
		const restorePrefix = `atomic-git-${KEY_VERSION}-${os}-${repository}-`;
		entries.push({ name: "git", key: `${restorePrefix}${await headOf(root)}`, restorePrefix, paths: [store] });
	}
	const transpileCache = getExtensionTranspileCacheDir(agentDir);
	entries.push({
		name: "atomic",
		key: `${prefix("atomic")}${hex16(`atomic\n${VERSION}\n${basename(transpileCache)}`)}`,
		restorePrefix: prefix("atomic"),
		paths: [transpileCache],
	});
	return { entries, warnings };
}

/**
 * A digest of the root blueprint's content, `absent` when there is none. A blueprint that still has the `cache:` key
 * Atomic once read earns the parser's hint to move it to `resume.cache`.
 */
async function blueprintDigest(root: string, warnings: string[]): Promise<string> {
	const path = getProjectBlueprintPath(root);
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return "absent";
		throw error;
	}
	try {
		for (const warning of parseBlueprint(source, { path, scope: "repository" }).warnings) {
			if (warning.code === "cache-ignored") warnings.push(warning.message);
		}
	} catch {
		// An invalid blueprint fails its build, which reports it; its content still keys the entries.
	}
	return sha256Hex(source);
}

/** The `resume.cache` setting, project over global, with each file that could not be read named in `warnings`. */
function settingsCache(root: string, agentDir: string, warnings: string[]): readonly CacheSetting[] {
	// The checkout is the project; its settings are read like its blueprint, and every path they name is checked below.
	const settings = SettingsManager.create(root, agentDir);
	for (const { path, error } of settings.drainErrors()) {
		if (path !== undefined)
			warnings.push(`${path} could not be read, so its resume.cache is ignored: ${error.message}`);
	}
	return readCacheSetting(settings.getSettings().resume?.cache, warnings);
}

/** A path whose text a cache path or key file may not contain: control characters such as a newline. */
const CONTROL_CHARACTER = /\p{Cc}/u;
/**
 * Characters a cache action reads as a glob or an exclusion (`!`), which could match paths the credential checks never
 * saw, such as `~/.ss[h]`. A cache path is a plain path.
 */
const GLOB_CHARACTER = /[*?[\]{}]|^\s*!/u;

const KEY_FILES_RULE = "'keyFiles' must be a list of files relative to the repository root, without '..'";

/**
 * Reads `resume.cache` leniently: an invalid entry or path, or a value that is not a list, is left out with a warning
 * and never fails the command, so a cache never depends on it.
 */
function readCacheSetting(value: unknown, warnings: string[]): CacheSetting[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		warnings.push("resume.cache must be a list of { paths, kind, keyFiles } entries; ignored");
		return [];
	}
	const settings: CacheSetting[] = [];
	for (const [index, item] of value.entries()) {
		const name = `resume.cache[${index}]`;
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			warnings.push(`${name}: an entry must be a { paths, kind, keyFiles } object; entry ignored`);
			continue;
		}
		const { paths, kind, keyFiles } = item as { paths?: unknown; kind?: unknown; keyFiles?: unknown };
		const resolvedKind = kind === undefined || kind === null ? "store" : kind;
		if (resolvedKind !== "store" && resolvedKind !== "build") {
			warnings.push(`${name}: 'kind' must be 'store' or 'build'; entry ignored`);
			continue;
		}
		if (!Array.isArray(paths)) {
			warnings.push(`${name}: 'paths' must be a list of paths; entry ignored`);
			continue;
		}
		let files: string[] | undefined;
		if (keyFiles !== undefined && keyFiles !== null) {
			if (!Array.isArray(keyFiles) || keyFiles.length === 0 || !keyFiles.every(isRelativeFile)) {
				warnings.push(`${name}: ${KEY_FILES_RULE}; entry ignored`);
				continue;
			}
			files = keyFiles.map((file) => file.replaceAll("\\", "/"));
		}
		for (const [position, path] of paths.entries()) {
			if (typeof path !== "string" || path.trim() === "" || CONTROL_CHARACTER.test(path)) {
				warnings.push(`${name}.paths[${position}]: a path must be a non-empty single-line string; ignored`);
			} else if (GLOB_CHARACTER.test(path)) {
				warnings.push(
					`${name}.paths[${position}]: '${path}' must be a plain path, without glob characters or a leading '!'; ignored`,
				);
			} else {
				settings.push({ path: path.trim(), kind: resolvedKind, keyFiles: files });
			}
		}
	}
	return settings;
}

function isRelativeFile(value: unknown): value is string {
	if (typeof value !== "string" || value === "" || CONTROL_CHARACTER.test(value)) return false;
	const normalized = value.replaceAll("\\", "/");
	return !posix.isAbsolute(normalized) && !/^[A-Za-z]:/.test(value) && !normalized.split("/").includes("..");
}

export type BlueprintCacheKeyFormat = "text" | "json" | "github-output";

/**
 * `keys` printed as `format`. `github-output` writes `<name>-key`, `<name>-restore-prefix` and `<name>-paths` lines
 * for `$GITHUB_OUTPUT`, several paths in a heredoc whose delimiter is derived from them. Warnings are not included.
 */
export function formatBlueprintCacheKeys(keys: BlueprintCacheKeys, format: BlueprintCacheKeyFormat): string {
	if (format === "json") return `${JSON.stringify(keys, null, 2)}\n`;
	const lines: string[] = [];
	for (const entry of keys.entries) {
		if (format === "text") {
			lines.push(entry.name, `  key:            ${entry.key}`, `  restore prefix: ${entry.restorePrefix}`);
			for (const [index, path] of entry.paths.entries())
				lines.push(`  ${index === 0 ? "paths:" : "      "}          ${path}`);
			continue;
		}
		lines.push(`${entry.name}-key=${entry.key}`, `${entry.name}-restore-prefix=${entry.restorePrefix}`);
		if (entry.paths.length === 1) {
			lines.push(`${entry.name}-paths=${entry.paths[0]}`);
		} else {
			const delimiter = `ATOMIC_${hex16(entry.paths.join("\n"))}`;
			lines.push(`${entry.name}-paths<<${delimiter}`, ...entry.paths, delimiter);
		}
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function hex16(text: string): string {
	return sha256Hex(text).slice(0, 16);
}

async function checkoutRemotes(root: string): Promise<readonly string[]> {
	try {
		return (await readRepositoryConfig(root)).remotes;
	} catch {
		return [];
	}
}

async function headOf(root: string): Promise<string> {
	const { stdout } = await runGit(["rev-parse", "--verify", "-q", "HEAD"], { cwd: root, allowExitCodes: [1] });
	return stdout.toString("utf8").trim() || "unborn";
}

/** The digests that key entries, read once each. */
class InputDigests {
	#environment: Promise<string> | undefined;
	readonly root: string;
	constructor(root: string) {
		this.root = root;
	}

	/** The paths and contents of `files` (absent files named as such). */
	async files(files: readonly string[]): Promise<string> {
		const hash = createHash("sha256");
		for (const file of files) {
			try {
				hash.update(`${file}\0${sha256Hex(await readFile(join(this.root, file)))}\n`);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EISDIR") throw error;
				hash.update(`${file}\0absent\n`);
			}
		}
		return `files:${hash.digest("hex")}`;
	}

	/** A setting's key files, else the environment hash, which covers every lockfile and toolchain file. */
	async of(member: CacheMember): Promise<string> {
		if (member.keyFiles !== undefined) return this.files(member.keyFiles);
		this.#environment ??= computeEnvironmentHash(this.root);
		return `env:${await this.#environment}`;
	}
}

/** A digest of the root blueprint, the members as declared or detected, and each member's key inputs. */
async function membersDigest(
	blueprint: string,
	members: readonly CacheMember[],
	inputs: InputDigests,
): Promise<string> {
	const lines = [`atomic-cache-${KEY_VERSION}`, `blueprint:${blueprint}`];
	for (const member of members) lines.push(JSON.stringify(member.declaration), await inputs.of(member));
	return hex16(lines.join("\n"));
}

function expandsHome(path: string): boolean {
	return path === "~" || path.startsWith("~/") || path.startsWith("~\\");
}

function storePath(path: string, home: string): string {
	return expandsHome(path) ? resolve(home, path.slice(2)) : resolve(path);
}

/** `child` is `parent` or below it. */
function within(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || !escapes(path);
}

/** `path`, relative, leaves its base: `..` or `../…`, not a child named like `..keys`; or it is absolute (another drive). */
function escapes(path: string): boolean {
	return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

/**
 * `path` as the credential checks compare it: every symbolic link in its existing part resolved, then lower-cased, so
 * `~/.SSH` on a case-insensitive filesystem and a link to `~/.ssh` both compare equal to `~/.ssh`.
 */
function comparable(path: string): string {
	return canonicalizeWorktreePath(path).toLowerCase();
}

/** Why the store path `declared` is refused, if it is. */
function refuseStore(declared: string, root: string, home: string, agentDir: string): string | undefined {
	// `resume.cache` paths were checked as they were read; a detected store comes from an environment variable.
	if (CONTROL_CHARACTER.test(declared) || GLOB_CHARACTER.test(declared)) {
		return "a cache path must be a plain single-line path, without glob characters or a leading '!'";
	}
	if (!expandsHome(declared) && !isAbsolute(declared)) {
		return 'a store path must be outside the worktree (absolute or under ~); declare build output with "kind": "build"';
	}
	const path = storePath(declared, home);
	if (within(path, root) || within(root, path)) return "a store path must be outside the worktree";
	const credentials = [...HOME_CREDENTIAL_PATHS.map((entry) => join(home, entry)), join(agentDir, "auth.json")];
	let candidates: string[];
	let locations: string[];
	try {
		candidates = [path.toLowerCase(), comparable(path)];
		locations = credentials.flatMap((credential) => [credential.toLowerCase(), comparable(credential)]);
	} catch {
		return "it cannot be resolved to check it for credentials";
	}
	const denied = candidates.some((candidate) => {
		const fromFilesystemRoot = candidate.slice(parse(candidate).root.length).split(sep).join("/");
		return fromFilesystemRoot !== "" && isDeniedSnapshotPath(fromFilesystemRoot);
	});
	if (
		denied ||
		candidates.some((candidate) =>
			locations.some((credential) => within(credential, candidate) || within(candidate, credential)),
		)
	) {
		return "it is, holds or is inside a location that keeps credentials";
	}
	return undefined;
}

function buildSegments(declared: string): string[] {
	return declared
		.replaceAll("\\", "/")
		.split("/")
		.filter((segment) => segment !== "" && segment !== ".");
}

/** Why the build path `declared` is refused, if it is. */
function refuseBuild(declared: string): string | undefined {
	const normalized = declared.replaceAll("\\", "/");
	const segments = buildSegments(declared);
	if (expandsHome(declared) || posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
		return "a build path must be relative to the repository root";
	}
	if (segments.length === 0 || segments.includes("..") || segments[0] === ".git") {
		return "a build path must be a directory inside the worktree, outside .git";
	}
	const path = segments.join("/").toLowerCase();
	if (isDeniedSnapshotPath(path) || WORKTREE_CREDENTIAL_FILES.has(path)) {
		return "it is or is inside a file that keeps credentials";
	}
	return undefined;
}
