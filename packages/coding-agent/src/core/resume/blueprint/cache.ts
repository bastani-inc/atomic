/**
 * The blueprint cache contract for runners (#4748): the cache entries a repository's `cache:` section declares, plus
 * Atomic's Git object store and its extension transpile cache, each with an `actions/cache`-style key, a restore
 * prefix and the paths to save. Atomic never uploads or downloads caches; a runner's cache action does, and only a
 * trusted job saves. Package stores verify what they read, so `kind: store` is the default; build output is opt-in.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse, posix, relative, resolve, sep } from "node:path";
import { getAgentDir, getExtensionTranspileCacheDir, getProjectBlueprintPath, VERSION } from "../../../config.js";
import { readRepositoryConfig } from "../../worktree-snapshot/capture.ts";
import { computeEnvironmentHash, sha256Hex } from "../../worktree-snapshot/env-hash.ts";
import { runGit } from "../../worktree-snapshot/git.ts";
import { canonicalizeWorktreePath } from "../../worktree-snapshot/paths.ts";
import { isDeniedSnapshotPath } from "../../worktree-snapshot/policy.ts";
import { objectStorePath } from "../../worktree-snapshot/restore.ts";
import { blueprintPlatformOf, parseBlueprint, selectDocument } from "./schema.ts";
import type { BlueprintCacheEntry, BlueprintPlatform } from "./types.ts";

/** Bumped when the key derivation changes, so no runner restores an entry keyed the old way. */
const KEY_VERSION = "v1";

export type BlueprintCacheName = "stores" | "build" | "git" | "atomic";

export interface BlueprintCacheKeyEntry {
	readonly name: BlueprintCacheName;
	/** The exact key to save under and restore first, such as `atomic-stores-v1-linux-x64-<hex16>`. */
	readonly key: string;
	/** The prefix to restore the newest older entry by, such as `atomic-stores-v1-linux-x64-`. */
	readonly restorePrefix: string;
	/** Absolute paths, in declaration order. */
	readonly paths: readonly string[];
}

export interface BlueprintCacheKeys {
	/** `stores` and `build` appear when they keep a path; `git` when the checkout has a remote; `atomic` always. */
	readonly entries: readonly BlueprintCacheKeyEntry[];
	/** Why a declared path, the `cache:` section or an entry was left out. */
	readonly warnings: readonly string[];
}

export interface BlueprintCacheKeyOptions {
	/** The platform the keys name. Default: this process's. */
	readonly platform?: NodeJS.Platform;
	/** The architecture the keys name. Default: this process's. */
	readonly arch?: string;
	/** What `~` expands to. Default: the user's home directory. */
	readonly home?: string;
	/** The agent directory whose transpile cache the `atomic` entry names. Default: the one in effect. */
	readonly agentDir?: string;
	/** The restore store whose Git object store and seeds the entries name. Default: `<agentDir>/worktree-snapshots`. */
	readonly storeDir?: string;
}

/**
 * Credential locations under the home directory. A declared path that is one of them, inside one, or contains one is
 * omitted, so `~/.cargo/registry` is kept and `~/.cargo` is not.
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

/** Root-relative files that commonly carry registry tokens, which a `kind: build` path may not name. */
const WORKTREE_CREDENTIAL_FILES: ReadonlySet<string> = new Set([".npmrc", ".pypirc", ".yarnrc.yml"]);

/**
 * The cache keys and paths of the repository at `root` (its top level). A pure function of the inputs: the root
 * blueprint's `cache:` section for `platform`, the files that key each entry, the checkout's remotes and HEAD, the
 * Atomic version, `platform` and `arch`. Paths that could carry secrets, `kind: store` paths inside the worktree and
 * `kind: build` paths outside it are omitted with a warning; an invalid blueprint or `cache:` section only warns.
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
	const declared = await declaredCache(root, os, warnings);
	const remotes = await checkoutRemotes(root);
	const store = remotes.length > 0 ? objectStorePath(storeDir, remotes) : undefined;
	if (store === undefined) warnings.push("the checkout has no Git remote; the git and build entries are omitted");

	const stores: { declared: BlueprintCacheEntry; path: string }[] = [];
	const builds: { declared: BlueprintCacheEntry; path: string }[] = [];
	for (const entry of declared) {
		const refusal = entry.kind === "store" ? refuseStore(entry.path, root, home, agentDir) : refuseBuild(entry.path);
		if (refusal !== undefined) {
			warnings.push(`cache path '${entry.path}' is omitted: ${refusal}`);
		} else if (entry.kind === "store") {
			stores.push({ declared: entry, path: storePath(entry.path, home) });
		} else if (store !== undefined) {
			const seeds = join(storeDir, "seeds", basename(store, ".git"));
			builds.push({ declared: entry, path: join(seeds, ...buildSegments(entry.path)) });
		}
	}

	// The OS and architecture are in each prefix, and the paths, which name the repository for `build`, are part of a
	// cache entry's version, so a digest covers only the declaration and the files that key it.
	const entries: BlueprintCacheKeyEntry[] = [];
	const inputs = new InputDigests(root);
	const prefix = (name: BlueprintCacheName) => `atomic-${name}-${KEY_VERSION}-${os}-${arch}-`;
	for (const [name, members] of [
		["stores", stores],
		["build", builds],
	] as const) {
		if (members.length === 0) continue;
		const restorePrefix = prefix(name);
		const key = `${restorePrefix}${await declarationDigest(members, inputs)}`;
		entries.push({ name, key, restorePrefix, paths: members.map((member) => member.path) });
	}
	if (store !== undefined) {
		// The store is append-only and portable across architectures: a new HEAD saves a new entry, and a restore takes
		// the newest by prefix; fetches fill any gap and every restore verifies its tree.
		const restorePrefix = `atomic-git-${KEY_VERSION}-${os}-${basename(store, ".git")}-`;
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

/** The root blueprint's `cache:` entries for `os`; a missing, unreadable or invalid blueprint has none. */
async function declaredCache(
	root: string,
	os: BlueprintPlatform,
	warnings: string[],
): Promise<readonly BlueprintCacheEntry[]> {
	const path = getProjectBlueprintPath(root);
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") warnings.push(`${path} could not be read; its cache: is ignored`);
		return [];
	}
	try {
		const document = selectDocument(parseBlueprint(source, { path, scope: "repository" }), os);
		for (const message of document?.cache?.ignored ?? []) warnings.push(message);
		return document?.cache?.entries ?? [];
	} catch (error) {
		warnings.push(`the blueprint is invalid, so its cache: is ignored: ${(error as Error).message}`);
		return [];
	}
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

	/** The declared key files' paths and contents (absent files skipped), else the environment hash. */
	async of(entry: BlueprintCacheEntry): Promise<string> {
		if (entry.keyFiles === undefined) {
			this.#environment ??= computeEnvironmentHash(this.root);
			return `env:${await this.#environment}`;
		}
		const hash = createHash("sha256");
		for (const file of entry.keyFiles) {
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
}

/** A digest of the declared entries, as written, and of each entry's key inputs. */
async function declarationDigest(
	members: readonly { declared: BlueprintCacheEntry }[],
	inputs: InputDigests,
): Promise<string> {
	const lines = [`atomic-cache-${KEY_VERSION}`];
	for (const { declared } of members) {
		lines.push(JSON.stringify([declared.path, declared.kind, declared.keyFiles ?? null]), await inputs.of(declared));
	}
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
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/**
 * `path` as the credential checks compare it: every symbolic link in its existing part resolved, then lower-cased, so
 * `~/.SSH` on a case-insensitive filesystem and a link to `~/.ssh` both compare equal to `~/.ssh`.
 */
function comparable(path: string): string {
	return canonicalizeWorktreePath(path).toLowerCase();
}

/** Why the `kind: store` path `declared` is refused, if it is. */
function refuseStore(declared: string, root: string, home: string, agentDir: string): string | undefined {
	if (!expandsHome(declared) && !isAbsolute(declared)) {
		return "a kind: store path must be outside the worktree (absolute or under ~); declare build output as kind: build";
	}
	const path = storePath(declared, home);
	if (within(path, root) || within(root, path)) return "a kind: store path must be outside the worktree";
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

/** Why the `kind: build` path `declared` is refused, if it is. */
function refuseBuild(declared: string): string | undefined {
	const normalized = declared.replaceAll("\\", "/");
	const segments = buildSegments(declared);
	if (expandsHome(declared) || posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
		return "a kind: build path must be relative to the repository root";
	}
	if (segments.length === 0 || segments.includes("..") || segments[0] === ".git") {
		return "a kind: build path must be a directory inside the worktree, outside .git";
	}
	const path = segments.join("/").toLowerCase();
	if (isDeniedSnapshotPath(path) || WORKTREE_CREDENTIAL_FILES.has(path)) {
		return "it is or is inside a file that keeps credentials";
	}
	return undefined;
}
