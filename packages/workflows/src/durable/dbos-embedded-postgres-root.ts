/**
 * Root-execution support for the embedded DBOS Postgres.
 *
 * PostgreSQL categorically refuses to run `initdb`/`postgres` as UID 0, so a
 * root Atomic process (common in containers, CI sandboxes, and eval harnesses)
 * cannot provision the embedded cluster directly. On Linux we instead resolve
 * an unprivileged system account, keep the cluster under a root-safe base
 * directory (`/root` is mode 0700 and untraversable by that account), and run
 * every Postgres command with dropped privileges.
 *
 * Privilege dropping is strategy-probed at runtime because subprocess
 * implementations can differ in how completely they apply `uid`/`gid` spawn
 * options. Every candidate must prove the target uid, primary gid, and safe
 * supplementary groups before it can run any owner command. Incomplete
 * candidates fall back to `setpriv`, `runuser`, or `su`.
 *
 * Every managed cluster launches from a complete immutable runtime generation
 * in its retained runtime cache, never directly from a package/worktree.
 * Root-owned generations remain executable by a drop-privilege server account.
 */

import { createHash, type Hash } from "node:crypto";
import type { Stats } from "node:fs";
import {
	chmod,
	chown,
	cp,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { type LocalCommandOptions, type LocalCommandResult, runLocalCommand } from "./local-command.js";

export interface EmbeddedPostgresOwner {
	readonly uid: number;
	readonly gid: number;
	readonly name: string;
}

export interface EmbeddedPostgresRunContext {
	/** Directory that holds the cluster, log file, and setup locks. */
	readonly baseDir: string;
	/** Present only when commands must drop privileges (Linux root). */
	readonly owner?: EmbeddedPostgresOwner;
	/** Runs a command as the owner; identity pass-through when no owner. */
	readonly runAsOwner: LocalCommandRunner;
}

export interface EmbeddedPostgresBinaryPaths {
	readonly pg_ctl: string;
	readonly initdb: string;
	readonly postgres: string;
}
export interface EmbeddedPostgresPreparedBinaries extends EmbeddedPostgresBinaryPaths {
	readonly sealedIdentity: string;
}

export type LocalCommandRunner = (
	command: string,
	args: readonly string[],
	options?: LocalCommandOptions,
) => Promise<LocalCommandResult>;

/** Root-safe cluster location: system path, traversable by system accounts. */
export const ROOT_EMBEDDED_BASE_DIR = "/var/lib/atomic-postgres";

/** Unprivileged accounts tried in order; `postgres` wins when present. */
const OWNER_CANDIDATES = ["postgres", "nobody", "daemon"] as const;

export function defaultEmbeddedBaseDir(): string {
	return join(homedir(), ".atomic", "postgres");
}

/**
 * Resolve where and as whom the embedded cluster should run. Non-root (and
 * every non-Linux platform) keeps the historical home-directory layout. Linux
 * root without a resolvable unprivileged account, or without any working
 * privilege-drop mechanism, also falls through to the default context so
 * PostgreSQL's own root refusal surfaces with full detail.
 */
export async function resolveEmbeddedRunContext(
	runner: LocalCommandRunner = runLocalCommand,
	euid: number | undefined = process.getuid?.(),
	platform: NodeJS.Platform = process.platform,
): Promise<EmbeddedPostgresRunContext> {
	if (platform !== "linux" || euid !== 0) {
		return { baseDir: defaultEmbeddedBaseDir(), runAsOwner: runner };
	}
	for (const name of OWNER_CANDIDATES) {
		const owner = await lookupOwner(runner, name);
		if (owner === undefined) continue;
		const runAsOwner = await resolvePrivilegeDrop(runner, owner);
		if (runAsOwner === undefined) continue;
		return { baseDir: ROOT_EMBEDDED_BASE_DIR, owner, runAsOwner };
	}
	return { baseDir: defaultEmbeddedBaseDir(), runAsOwner: runner };
}

/**
 * Return a runner that verifiably executes commands as the owner, or
 * `undefined` when no drop mechanism works. Each candidate proves its complete
 * effective identity through its own runner before it can be selected.
 */
export async function resolvePrivilegeDrop(
	runner: LocalCommandRunner,
	owner: EmbeddedPostgresOwner,
): Promise<LocalCommandRunner | undefined> {
	const strategies: readonly LocalCommandRunner[] = [
		(command, args, options) => runner(command, args, { ...options, uid: owner.uid, gid: owner.gid }),
		(command, args, options) =>
			runner(
				"setpriv",
				[`--reuid=${owner.uid}`, `--regid=${owner.gid}`, "--clear-groups", "--", command, ...args],
				options,
			),
		(command, args, options) => runner("runuser", ["-u", owner.name, "--", command, ...args], options),
		(command, args, options) =>
			runner("su", ["-s", "/bin/sh", "-c", shellCommand(command, args), owner.name], options),
	];
	for (const strategy of strategies) {
		if (await provesOwnerIdentity(strategy, owner)) return strategy;
	}
	return undefined;
}

async function provesOwnerIdentity(strategy: LocalCommandRunner, owner: EmbeddedPostgresOwner): Promise<boolean> {
	try {
		const uid = parseIdentityNumber(await strategy("id", ["-u"]));
		if (uid !== owner.uid) return false;
		const gid = parseIdentityNumber(await strategy("id", ["-g"]));
		if (gid !== owner.gid) return false;
		const groups = parseIdentityGroups(await strategy("id", ["-G"]));
		return groups?.has(owner.gid) === true && (owner.uid === 0 || !groups.has(0));
	} catch {
		return false;
	}
}

function parseIdentityNumber(result: LocalCommandResult): number | undefined {
	if (result.exitCode !== 0 || result.stdoutTruncated === true) return undefined;
	const match = /^(0|[1-9]\d*)\r?\n?$/.exec(result.stdout);
	if (match === null) return undefined;
	const value = Number(match[1]);
	return Number.isSafeInteger(value) ? value : undefined;
}

function parseIdentityGroups(result: LocalCommandResult): ReadonlySet<number> | undefined {
	if (
		result.exitCode !== 0 ||
		result.stdoutTruncated === true ||
		!/^(0|[1-9]\d*)(?:[ \t]+(0|[1-9]\d*))*\r?\n?$/.test(result.stdout)
	) {
		return undefined;
	}
	const values = result.stdout
		.trimEnd()
		.split(/[ \t]+/)
		.map(Number);
	if (values.some((value) => !Number.isSafeInteger(value))) return undefined;
	const groups = new Set(values);
	return groups.size === values.length ? groups : undefined;
}

export interface RuntimePublicationLease {
	/** Unique setup-lock owner token persisted beside unpublished stage work. */
	readonly ownerToken: string;
	/** Refresh ownership now; false means stale takeover displaced this publisher. */
	readonly refresh: () => boolean;
	/** In-memory loss detected by the independent lease heartbeat. */
	readonly isLost?: () => boolean;
}

export interface RuntimePreparationOptions {
	readonly publicationLease?: RuntimePublicationLease;
	/** Test seam immediately after the first exact source snapshot. */
	readonly afterInitialSourceSnapshot?: () => void | Promise<void>;
	/** Test seam at the sealed validation/publication boundary. */
	readonly beforePublish?: (stagedRuntime: string) => void | Promise<void>;
	/** Test seam immediately after the atomic publication rename. */
	readonly afterPublish?: (publishedRuntime: string) => void | Promise<void>;
	/** Test seam after published content/source validation but before final lease selection. */
	readonly afterPublishValidation?: (publishedRuntime: string) => void | Promise<void>;
	readonly renameStage?: (source: string, destination: string) => Promise<void>;
	/** Test seam for deterministic event-loop cooperation without real delays. */
	readonly yieldToEventLoop?: () => Promise<void>;
	readonly onContentRead?: (path: string) => void;
	readonly onSourceStatPass?: () => void;
	readonly onValidation?: () => void;
	readonly repairCorruptGeneration?: boolean;
	/** Refresh source metadata when selecting a replacement; ordinary startup may retain the package fast path. */
	readonly refreshSourceSnapshot?: boolean;
	readonly fullValidation?: boolean;
	readonly memoizedValidation?: boolean;
	readonly quickValidation?: boolean;
	readonly reservedGeneration?: string;
	readonly reuseOnly?: boolean;
}

const STAGE_OWNER_FILE = ".atomic-stage-owner";
const STAGE_PAYLOAD_DIR = "runtime";
const RUNTIME_MARKER = ".atomic-runtime-complete.json";
const MAX_RUNTIME_REPAIR_GENERATIONS = 8;
const TRAVERSAL_OPERATIONS_PER_YIELD = 16;
const HASH_CHUNK_BYTES = 64 * 1024;
type RuntimeEntry = readonly [
	string,
	"directory" | "file" | "link",
	number,
	number,
	number,
	string?,
	(readonly [number, number, number])?,
];
interface RuntimeManifest {
	readonly version: 1;
	readonly sealedIdentity: string;
	readonly entries: readonly RuntimeEntry[];
}
interface SourceIndexEntry {
	readonly signature: string;
	readonly packageSignature?: string;
	readonly snapshot: SourceRuntimeSnapshot;
	readonly indexWrittenAt: number;
}
const sourceMemo = new Map<string, SourceIndexEntry>();
const legacyMemo = new Map<string, RuntimeManifest>();
const validatedMemo = new Map<string, { marker: string; identity: string }>();
const corruptGenerationMemo = new Map<string, { identity: string; reason: string }>();

function runtimeGenerationIdentity(rootStat: Stats, markerStat: Stats | undefined): string {
	const identity = (stat: Stats | undefined) =>
		stat === undefined
			? null
			: [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs];
	return JSON.stringify([identity(rootStat), identity(markerStat)]);
}

async function candidateIdentity(candidate: string, rootStat: Stats): Promise<string> {
	return runtimeGenerationIdentity(rootStat, await lstatOrUndefined(join(candidate, RUNTIME_MARKER)));
}

export async function prepareBinariesForOwner(
	binaries: EmbeddedPostgresBinaryPaths,
	context: EmbeddedPostgresRunContext,
	runner: LocalCommandRunner = runLocalCommand,
	options: RuntimePreparationOptions = {},
): Promise<EmbeddedPostgresPreparedBinaries> {
	// `<packageRoot>/native/bin/initdb` → copy the whole `native` tree so the
	// binaries keep their relative `../lib` runtime library references. Do not
	// resolve or rewrite the configured caller paths or any relative link text.
	const sourceNativeDir = dirname(dirname(binaries.initdb));
	const override = process.env.ATOMIC_POSTGRES_RUNTIME_CACHE_DIR;
	if (override !== undefined && !isAbsolute(override))
		throw new Error(`Embedded Postgres runtime cache override must be absolute: ${override}`);
	const copiedRuntimeDir = override === undefined ? join(context.baseDir, "pg-runtime") : normalize(override);
	const publisher = publisherIdentity();
	const progress = runtimeProgress(options);
	await ensureRuntimeCacheDirectory(copiedRuntimeDir, publisher, context.owner !== undefined, context.owner);
	const sourceSnapshot = await memoizedSourceSnapshot(sourceNativeDir, copiedRuntimeDir, publisher, progress, options);
	await options.afterInitialSourceSnapshot?.();
	const copiedNativeDir = await findOrCreateRuntimeGeneration(
		binaries,
		sourceNativeDir,
		sourceSnapshot,
		copiedRuntimeDir,
		publisher,
		runner,
		progress,
		options,
		context.owner !== undefined,
	);
	return {
		pg_ctl: join(copiedNativeDir, "bin", basename(binaries.pg_ctl)),
		initdb: join(copiedNativeDir, "bin", basename(binaries.initdb)),
		postgres: join(copiedNativeDir, "bin", basename(binaries.postgres)),
		sealedIdentity: sourceSnapshot.sealedIdentity,
	};
}
export async function fingerprintPreparedRuntime(
	binaries: EmbeddedPostgresBinaryPaths,
	options: RuntimePreparationOptions = {},
): Promise<string> {
	return validatePreparedRuntime(
		dirname(dirname(binaries.postgres)),
		binaries,
		runtimeProgress(options),
		undefined,
		options,
	);
}

/**
 * Reap only stages whose setup owner was both displaced and proven dead.
 * A stale heartbeat alone is not abandonment: a live process can have been
 * scheduler-starved, and deleting its stage would race in-flight copy/hash I/O.
 * Legacy untagged stages remain finite migration evidence and are not guessed at.
 */
export async function cleanupAbandonedRuntimeStages(
	baseDir: string,
	abandonedOwnerTokens: ReadonlySet<string> = new Set(),
): Promise<void> {
	if (abandonedOwnerTokens.size === 0) return;
	const copiedRuntimeDir = join(baseDir, "pg-runtime");
	let entries: string[];
	try {
		entries = await readdir(copiedRuntimeDir);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.startsWith(".native-staged-")) continue;
		const stage = join(copiedRuntimeDir, entry);
		let ownerToken: string;
		try {
			ownerToken = await readSmallFile(join(stage, STAGE_OWNER_FILE));
		} catch {
			continue;
		}
		if (abandonedOwnerTokens.has(ownerToken)) await rm(stage, { recursive: true, force: true });
	}
}

interface PublisherIdentity {
	readonly uid: number;
	readonly gid: number;
}

interface SourceRuntimeSnapshot {
	readonly sourceIdentity: string;
	readonly sealedIdentity: string;
}

type RuntimeProgress = (() => Promise<void>) & { readonly onContentRead?: (path: string) => void };

/**
 * One exact source identity owns one deterministic path. If that path is
 * externally corrupted it is retained (it may be executing) and setup fails
 * closed; repeated calls neither append repair generations nor scan legacy
 * unique generations, selected `native`, or `.native-retired-*` evidence.
 */
async function findOrCreateRuntimeGeneration(
	binaries: EmbeddedPostgresBinaryPaths,
	sourceNativeDir: string,
	sourceSnapshot: SourceRuntimeSnapshot,
	copiedRuntimeDir: string,
	publisher: PublisherIdentity,
	runner: LocalCommandRunner,
	progress: RuntimeProgress,
	options: RuntimePreparationOptions,
	needsPrivilegeDrop: boolean,
): Promise<string> {
	await ensureRuntimeCacheDirectory(copiedRuntimeDir, publisher, needsPrivilegeDrop);
	const canonical = join(copiedRuntimeDir, `native-${sourceSnapshot.sourceIdentity}`);
	if (options.repairCorruptGeneration && !options.publicationLease?.refresh()) {
		throw new RuntimePublicationLeaseLostError("Embedded Postgres runtime repair requires its setup lease.");
	}
	let generationNativeDir: string | undefined;
	for (let repair = 0; repair <= MAX_RUNTIME_REPAIR_GENERATIONS; repair++) {
		const candidate = repair === 0 ? canonical : `${canonical}-repair-${repair}`;
		let candidateFingerprint: string | undefined;
		try {
			const existing = await lstatOrUndefined(candidate);
			if (existing === undefined) {
				if (candidate === options.reservedGeneration) continue;
				generationNativeDir ??= candidate;
				if (!options.repairCorruptGeneration) break;
				continue;
			}
			candidateFingerprint = await candidateIdentity(candidate, existing);
			const knownCorrupt = corruptGenerationMemo.get(candidate);
			if (knownCorrupt?.identity === candidateFingerprint)
				throw new CorruptRuntimeGenerationError(knownCorrupt.reason);
			const identity = await validatePreparedRuntime(
				candidate,
				{
					pg_ctl: join(candidate, "bin", basename(binaries.pg_ctl)),
					initdb: join(candidate, "bin", basename(binaries.initdb)),
					postgres: join(candidate, "bin", basename(binaries.postgres)),
				},
				progress,
				sourceSnapshot.sealedIdentity,
				options,
			);
			if (identity !== sourceSnapshot.sealedIdentity)
				throw new CorruptRuntimeGenerationError("sealed identity mismatch");
		} catch (error) {
			if (error instanceof RuntimePublicationLeaseLostError) throw error;
			if (!isCorruptRuntimeGeneration(error, candidate)) throw error;
			if (candidateFingerprint !== undefined) {
				const current = await lstatOrUndefined(candidate);
				if (current && (await candidateIdentity(candidate, current)) === candidateFingerprint)
					corruptGenerationMemo.set(candidate, {
						identity: candidateFingerprint,
						reason: error instanceof Error ? error.message : String(error),
					});
			}
			if (!options.repairCorruptGeneration) {
				const detail = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Embedded Postgres runtime generation is corrupt and cannot be replaced while it may be in use (${candidate}): ${detail}`,
				);
			}
			if (!options.publicationLease?.refresh())
				throw new RuntimePublicationLeaseLostError("Embedded Postgres runtime repair lost its setup lease.");
			continue;
		}
		await assertSourceSnapshotUnchanged(
			sourceNativeDir,
			sourceSnapshot,
			publisher,
			progress,
			"Embedded Postgres source package changed while selecting an existing generation.",
		);
		return candidate;
	}
	if (generationNativeDir === undefined)
		throw new Error("Embedded Postgres runtime repair slots are exhausted; preserve the existing generations.");

	if (options.reuseOnly) throw new RuntimeGenerationMissingError();
	const stageOwner = options.publicationLease?.ownerToken ?? `unmanaged-${process.pid}-${crypto.randomUUID()}`;
	const stagedRoot = join(copiedRuntimeDir, `.native-staged-${process.pid}-${crypto.randomUUID()}`);
	const stagedNativeDir = join(stagedRoot, STAGE_PAYLOAD_DIR);
	await mkdir(stagedRoot, { mode: 0o700 });
	await writeFile(join(stagedRoot, STAGE_OWNER_FILE), stageOwner, { mode: 0o600, flag: "wx" });
	try {
		await progress();
		await cp(sourceNativeDir, stagedNativeDir, { recursive: true, verbatimSymlinks: true });
		await assertSourceSnapshotUnchanged(
			sourceNativeDir,
			sourceSnapshot,
			publisher,
			progress,
			"Embedded Postgres source package changed while preparing a generation.",
		);
		await sealRuntimeForPublisher(stagedNativeDir, publisher, runner, progress, needsPrivilegeDrop);
		await options.beforePublish?.(stagedNativeDir);
		await assertSourceSnapshotUnchanged(
			sourceNativeDir,
			sourceSnapshot,
			publisher,
			progress,
			"Embedded Postgres source package changed while preparing a generation.",
		);
		const manifest = await snapshotSealedManifest(stagedNativeDir, progress);
		if (manifest.sealedIdentity !== sourceSnapshot.sealedIdentity)
			throw new Error("Embedded Postgres runtime changed after sealed validation and before publication.");
		await writeFile(join(stagedNativeDir, RUNTIME_MARKER), JSON.stringify(manifest), { mode: 0o444, flag: "wx" });
		await chmod(join(stagedNativeDir, RUNTIME_MARKER), 0o444);
		await assertSourceSnapshotUnchanged(
			sourceNativeDir,
			sourceSnapshot,
			publisher,
			progress,
			"Embedded Postgres source package changed while preparing a generation.",
		);
		await progress();
		assertPublicationLease(options, "Embedded Postgres runtime publication lost its setup lease.");
		// The stage is publisher-owned and has no write bit for any uid before
		// this single same-parent rename. The Postgres uid therefore has no
		// validation-to-publication mutation window.
		try {
			await (options.renameStage ?? rename)(stagedNativeDir, generationNativeDir);
			assertPublicationLease(options, "Embedded Postgres runtime lost its setup lease after publication.");
			legacyMemo.delete(generationNativeDir);
			corruptGenerationMemo.delete(generationNativeDir);
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (
				!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(String(code)) ||
				!(await lstatOrUndefined(generationNativeDir))
			)
				throw error;
			if (
				(await validatePreparedRuntime(
					generationNativeDir,
					{
						pg_ctl: join(generationNativeDir, "bin", basename(binaries.pg_ctl)),
						initdb: join(generationNativeDir, "bin", basename(binaries.initdb)),
						postgres: join(generationNativeDir, "bin", basename(binaries.postgres)),
					},
					progress,
					sourceSnapshot.sealedIdentity,
				)) !== sourceSnapshot.sealedIdentity
			)
				throw new CorruptRuntimeGenerationError("Concurrent runtime publication disagrees with its source.");
			assertPublicationLease(options, "Embedded Postgres runtime publication lost its setup lease.");
			return generationNativeDir;
		}
		await options.afterPublish?.(generationNativeDir);
		try {
			if (
				(await validatePreparedRuntime(
					generationNativeDir,
					{
						pg_ctl: join(generationNativeDir, "bin", basename(binaries.pg_ctl)),
						initdb: join(generationNativeDir, "bin", basename(binaries.initdb)),
						postgres: join(generationNativeDir, "bin", basename(binaries.postgres)),
					},
					progress,
					sourceSnapshot.sealedIdentity,
				)) !== sourceSnapshot.sealedIdentity
			)
				throw new CorruptRuntimeGenerationError("sealed identity mismatch");
		} catch (error) {
			if (error instanceof CorruptRuntimeGenerationError)
				throw new Error(`Embedded Postgres published runtime changed during publication: ${error.message}`, {
					cause: error,
				});
			throw error;
		}
		await assertSourceSnapshotUnchanged(
			sourceNativeDir,
			sourceSnapshot,
			publisher,
			progress,
			"Embedded Postgres source package changed during publication.",
		);
		await options.afterPublishValidation?.(generationNativeDir);
		assertPublicationLease(options, "Embedded Postgres runtime lost its setup lease after publication.");
		return generationNativeDir;
	} finally {
		await makeUnpublishedStageRemovable(stagedNativeDir).catch(() => {});
		await rm(stagedRoot, { recursive: true, force: true });
	}
}
export async function ensureRuntimeCacheDirectory(
	path: string,
	publisher: PublisherIdentity = publisherIdentity(),
	needsPrivilegeDrop = false,
	owner?: EmbeddedPostgresOwner,
	inspect: (path: string) => Promise<Stats> = lstat,
): Promise<void> {
	if (!isAbsolute(path)) throw new Error(`Embedded Postgres runtime cache override must be absolute: ${path}`);
	await mkdir(path, { recursive: true, mode: 0o755 });
	const stat = await inspect(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid !== undefined && stat.uid !== publisher.uid))
		throw new Error(`Untrusted embedded Postgres runtime cache directory: ${path}`);
	let ancestor = await realpath(path);
	while (true) {
		const info = await inspect(ancestor);
		if (
			!info.isDirectory() ||
			(process.platform !== "win32" &&
				((info.uid !== 0 && info.uid !== publisher.uid) ||
					((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)))
		)
			throw new Error(`Untrusted embedded Postgres runtime cache directory ancestor: ${ancestor}`);
		if (needsPrivilegeDrop && owner && publisher.uid === 0 && process.platform !== "win32") {
			const execute = info.uid === owner.uid ? 0o100 : info.gid === owner.gid ? 0o010 : 0o001;
			if ((info.mode & execute) === 0)
				throw new Error(`Embedded Postgres dropped owner cannot traverse runtime cache directory: ${ancestor}`);
		}
		const parent = dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	if (needsPrivilegeDrop) await chown(path, publisher.uid, publisher.gid);
	await chmod(path, 0o755);
}
class SourceRuntimeChangedError extends Error {}
class RuntimePublicationLeaseLostError extends Error {}
class CorruptRuntimeGenerationError extends Error {}
export class RuntimeGenerationMissingError extends Error {}

export function isCorruptRuntimeGeneration(error: unknown, candidate: string): boolean {
	if (error instanceof CorruptRuntimeGenerationError) return true;
	if (!(error instanceof Error)) return false;
	const code = "code" in error ? error.code : undefined;
	const path = "path" in error ? error.path : undefined;
	return (
		(code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "EACCES") &&
		typeof path === "string" &&
		(path === candidate || path.startsWith(`${candidate}${sep}`))
	);
}

async function assertSourceSnapshotUnchanged(
	sourceNativeDir: string,
	expected: SourceRuntimeSnapshot,
	publisher: PublisherIdentity,
	progress: RuntimeProgress,
	message: string,
): Promise<void> {
	const current = await memoizedSourceSnapshot(
		sourceNativeDir,
		process.env.ATOMIC_POSTGRES_RUNTIME_CACHE_DIR ?? "",
		publisher,
		progress,
	);
	if (current.sourceIdentity !== expected.sourceIdentity || current.sealedIdentity !== expected.sealedIdentity) {
		throw new SourceRuntimeChangedError(message);
	}
}

function assertPublicationLease(options: RuntimePreparationOptions, message: string): void {
	if (options.publicationLease !== undefined && !options.publicationLease.refresh())
		throw new RuntimePublicationLeaseLostError(message);
}
function runtimeProgress(options: RuntimePreparationOptions): RuntimeProgress {
	let operations = 0;
	const yieldToEventLoop = options.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
	return Object.assign(
		async () => {
			if (options.publicationLease?.isLost?.())
				throw new RuntimePublicationLeaseLostError("Embedded Postgres runtime publication lost its setup lease.");
			if (operations > 0 && operations % TRAVERSAL_OPERATIONS_PER_YIELD === 0) {
				await yieldToEventLoop();
				if (options.publicationLease?.isLost?.())
					throw new RuntimePublicationLeaseLostError(
						"Embedded Postgres runtime publication lost its setup lease.",
					);
			}
			operations += 1;
		},
		{ onContentRead: options.onContentRead },
	);
}

/** Hash source bytes/raw link text/modes and its exact sealed projection. */
async function snapshotSourceRuntime(
	root: string,
	publisher: PublisherIdentity,
	progress: RuntimeProgress,
): Promise<SourceRuntimeSnapshot> {
	const rootStat = await lstat(root);
	assertRuntimeRoot(root, rootStat);
	const rootRealPath = await realpath(root);
	const sourceHash = createHash("sha256");
	const sealedHash = createHash("sha256");
	await hashSourceEntry(sourceHash, sealedHash, root, ".", rootRealPath, publisher, progress);
	return { sourceIdentity: sourceHash.digest("hex"), sealedIdentity: sealedHash.digest("hex") };
}

async function hashSourceEntry(
	sourceHash: Hash,
	sealedHash: Hash,
	path: string,
	relativePath: string,
	rootRealPath: string,
	publisher: PublisherIdentity,
	progress: RuntimeProgress,
): Promise<void> {
	await progress();
	const stat = await lstat(path);
	if (stat.isSymbolicLink()) {
		const target = await validatedLinkTarget(path, relativePath, rootRealPath);
		hashField(sourceHash, "link", relativePath, target);
		hashField(sealedHash, "link", relativePath, String(publisher.uid), String(publisher.gid), target);
		return;
	}
	if (stat.isDirectory()) {
		hashField(sourceHash, "directory", relativePath, String(stat.mode & 0o777));
		hashField(
			sealedHash,
			"directory",
			relativePath,
			String(sealedDirectoryMode(relativePath === ".")),
			String(publisher.uid),
			String(publisher.gid),
		);
		for (const entry of (await readdir(path)).sort()) {
			await hashSourceEntry(
				sourceHash,
				sealedHash,
				join(path, entry),
				relativePath === "." ? entry : join(relativePath, entry),
				rootRealPath,
				publisher,
				progress,
			);
		}
		return;
	}
	if (stat.isFile()) {
		hashField(sourceHash, "file", relativePath, String(stat.mode & 0o777), String(stat.size));
		hashField(
			sealedHash,
			"file",
			relativePath,
			String(sealedFileMode(stat.mode)),
			String(publisher.uid),
			String(publisher.gid),
			String(stat.size),
		);
		await hashFileInto([sourceHash, sealedHash], path, progress);
		return;
	}
	throw new CorruptRuntimeGenerationError(`Embedded Postgres runtime contains an unsupported entry: ${relativePath}`);
}

async function memoizedSourceSnapshot(
	root: string,
	cacheDir: string,
	publisher: PublisherIdentity,
	progress: RuntimeProgress,
	options: RuntimePreparationOptions = {},
): Promise<SourceRuntimeSnapshot> {
	const realRoot = await realpath(root);
	const key = `${publisher.uid}:${publisher.gid}:${realRoot}`;
	const packageSignature = await installedPackageSignature(realRoot);
	const indexPath = cacheDir ? join(cacheDir, ".atomic-source-index.json") : undefined;
	const cached = sourceMemo.get(key);
	const refreshSource = options.refreshSourceSnapshot ?? options.repairCorruptGeneration === true;
	if (
		!refreshSource &&
		packageSignature !== undefined &&
		cached !== undefined &&
		(cached.packageSignature ?? cached.signature) === packageSignature
	)
		return cached.snapshot;
	let index: Record<string, SourceIndexEntry> = {};
	if (indexPath) {
		try {
			const stat = await lstat(indexPath);
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				(process.getuid !== undefined && stat.uid !== publisher.uid) ||
				(process.platform !== "win32" && (stat.mode & 0o022) !== 0)
			)
				throw new Error("Untrusted source index");
			index = JSON.parse(await readFile(indexPath, "utf8")) as typeof index;
			if (!index || typeof index !== "object" || Array.isArray(index)) throw new Error("Invalid source index");
			const entry = index[key];
			if (
				!refreshSource &&
				packageSignature !== undefined &&
				(entry?.packageSignature ?? entry?.signature) === packageSignature &&
				/^[a-f0-9]{64}$/.test(entry.snapshot?.sourceIdentity) &&
				/^[a-f0-9]{64}$/.test(entry.snapshot?.sealedIdentity)
			) {
				sourceMemo.set(key, entry);
				return entry.snapshot;
			}
		} catch {
			index = {};
		}
	}
	options.onSourceStatPass?.();
	const entries = await statRuntimeEntries(root, progress, true);
	const signature = JSON.stringify([realRoot, entries]);
	if (
		!refreshSource &&
		cached?.signature === signature &&
		(packageSignature === undefined || cached.packageSignature === packageSignature) &&
		!sourceEntriesRacy(entries, cached.indexWrittenAt)
	)
		return cached.snapshot;
	const entry = index[key];
	if (
		entry?.signature === signature &&
		(packageSignature === undefined || entry.packageSignature === packageSignature) &&
		!sourceEntriesRacy(entries, entry.indexWrittenAt) &&
		/^[a-f0-9]{64}$/.test(entry.snapshot?.sourceIdentity) &&
		/^[a-f0-9]{64}$/.test(entry.snapshot?.sealedIdentity)
	) {
		sourceMemo.set(key, entry);
		return entry.snapshot;
	}
	// A repaired package can retain its version and integrity; discard its stale fast-path mapping.
	if (refreshSource) sourceMemo.delete(key);
	const snapshot = await snapshotSourceRuntime(root, publisher, progress);
	options.onSourceStatPass?.();
	if (signature !== JSON.stringify([await realpath(root), await statRuntimeEntries(root, progress, true)]))
		throw new SourceRuntimeChangedError("Embedded Postgres source package changed during snapshot.");
	const indexed = { snapshot, signature, packageSignature, indexWrittenAt: Date.now() };
	sourceMemo.set(key, indexed);
	if (indexPath) {
		await ensureRuntimeCacheDirectory(cacheDir, publisher);
		const temporary = `${indexPath}.${process.pid}-${crypto.randomUUID()}`;
		try {
			await writeFile(temporary, JSON.stringify({ ...index, [key]: indexed }), { mode: 0o600, flag: "wx" });
			await rename(temporary, indexPath);
		} catch {
			return snapshot;
		} finally {
			await rm(temporary, { force: true });
		}
	}
	return snapshot;
}

async function installedPackageSignature(realRoot: string): Promise<string | undefined> {
	if (
		process.env.ATOMIC_POSTGRES_RUNTIME_DIR !== undefined ||
		!["native", "postgres-runtime"].includes(basename(realRoot))
	)
		return undefined;
	const packageRoot = dirname(realRoot);
	const nodeModules = packageRoot.lastIndexOf(`${sep}node_modules${sep}`);
	if (nodeModules < 0) return undefined;
	try {
		const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
			name?: string;
			version?: string;
		};
		if (!manifest.name || !manifest.version) return undefined;
		const lockRoot = packageRoot.slice(0, nodeModules + `${sep}node_modules`.length);
		let installed: { version?: string; integrity?: string; resolved?: string } | undefined;
		try {
			const lock = JSON.parse(await readFile(join(lockRoot, ".package-lock.json"), "utf8")) as {
				packages?: Record<string, { version?: string; integrity?: string; resolved?: string }>;
			};
			const lockKey = `node_modules/${relative(lockRoot, packageRoot).split(sep).join("/")}`;
			installed = lock.packages?.[lockKey];
		} catch {
			installed = undefined;
		}
		if (installed?.version !== undefined && installed.version !== manifest.version) return undefined;
		return JSON.stringify([
			await realpath(packageRoot),
			manifest.name,
			manifest.version,
			installed?.integrity,
			installed?.resolved,
		]);
	} catch {
		return undefined;
	}
}
function sourceEntriesRacy(entries: readonly RuntimeEntry[], indexWrittenAt: number): boolean {
	if (!Number.isFinite(indexWrittenAt)) return true;
	return entries.some((entry) => {
		const fields = entry[5]?.split(":");
		if (!fields || fields.length < 7) return true;
		return Number(fields.at(-5)) >= indexWrittenAt - 2000 || Number(fields.at(-4)) >= indexWrittenAt - 2000;
	});
}

async function validatePreparedRuntime(
	root: string,
	binaries: EmbeddedPostgresBinaryPaths,
	progress: RuntimeProgress,
	expected?: string,
	options: RuntimePreparationOptions = {},
): Promise<string> {
	const marker = join(root, RUNTIME_MARKER);
	await requiredRuntimeFiles(root, binaries);
	const markerStat = await lstatOrUndefined(marker);
	const markerIdentity =
		markerStat &&
		`${markerStat.dev}:${markerStat.ino}:${markerStat.size}:${markerStat.mtimeMs}:${markerStat.ctimeMs}`;
	if (options.fullValidation) validatedMemo.delete(root);
	const cached = validatedMemo.get(root);
	if (options.quickValidation && markerStat?.isFile() && (markerStat.mode & 0o222) === 0) {
		let manifest: RuntimeManifest;
		try {
			manifest = JSON.parse(await readFile(marker, "utf8")) as RuntimeManifest;
		} catch {
			throw new CorruptRuntimeGenerationError("invalid runtime completion marker");
		}
		if (manifest.version !== 1 || !Array.isArray(manifest.entries) || !/^[a-f0-9]{64}$/.test(manifest.sealedIdentity))
			throw new CorruptRuntimeGenerationError("invalid runtime completion marker");
		return manifest.sealedIdentity;
	}
	if (
		options.memoizedValidation &&
		!options.fullValidation &&
		markerIdentity &&
		cached?.marker === markerIdentity &&
		(expected === undefined || expected === cached.identity)
	) {
		return cached.identity;
	}
	let manifest: RuntimeManifest;
	try {
		const markerStat = await lstat(marker);
		if (!markerStat.isFile() || (markerStat.mode & 0o222) !== 0)
			throw new CorruptRuntimeGenerationError("untrusted runtime completion marker");
		const text = await readFile(marker, "utf8");
		manifest = JSON.parse(text) as RuntimeManifest;
		if (manifest.version !== 1 || !Array.isArray(manifest.entries) || !/^[a-f0-9]{64}$/.test(manifest.sealedIdentity))
			throw new CorruptRuntimeGenerationError("invalid runtime completion marker");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
			if (error instanceof CorruptRuntimeGenerationError) throw error;
			throw new CorruptRuntimeGenerationError("invalid runtime completion marker");
		}
		const cached = legacyMemo.get(root);
		if (cached !== undefined) manifest = cached;
		else {
			manifest = await snapshotSealedManifest(root, progress);
			if (expected !== undefined && manifest.sealedIdentity !== expected)
				throw new CorruptRuntimeGenerationError("legacy sealed identity mismatch");
			legacyMemo.set(root, manifest);
		}
	}
	options.onValidation?.();
	const entries = await statRuntimeEntries(root, progress, false);
	const metadataChanged =
		JSON.stringify(entries.map((entry) => (entry[0] === "." ? entry.slice(0, 6) : entry))) !==
		JSON.stringify(manifest.entries.map((entry) => (entry[0] === "." ? entry.slice(0, 6) : entry)));
	if (metadataChanged) {
		if (
			JSON.stringify(entries.map((entry) => entry.slice(0, 6))) !==
			JSON.stringify(manifest.entries.map((entry) => entry.slice(0, 6)))
		)
			throw new CorruptRuntimeGenerationError("runtime completion manifest mismatch");
		if ((await snapshotSealedManifest(root, progress)).sealedIdentity !== manifest.sealedIdentity)
			throw new CorruptRuntimeGenerationError("runtime completion manifest mismatch");
	}
	for (const binary of [binaries.pg_ctl, binaries.initdb, binaries.postgres]) {
		if (!entries.some(([name, kind]) => name === relative(root, binary) && kind === "file"))
			throw new CorruptRuntimeGenerationError("required Postgres executable missing");
	}
	const timezone = join(
		"share",
		...(binaries.postgres.endsWith(".exe") ? [] : ["postgresql"]),
		"timezonesets",
		"Default",
	);
	if (
		entries.some(([name]) => name === "share") &&
		!entries.some(([name, kind]) => name === timezone && kind === "file")
	)
		throw new CorruptRuntimeGenerationError("required Postgres timezone data missing");
	if (markerIdentity) validatedMemo.set(root, { marker: markerIdentity, identity: manifest.sealedIdentity });
	return manifest.sealedIdentity;
}

async function requiredRuntimeFiles(root: string, binaries: EmbeddedPostgresBinaryPaths): Promise<void> {
	for (const binary of [binaries.postgres, binaries.pg_ctl, binaries.initdb]) {
		if (!(await lstatOrUndefined(binary))?.isFile())
			throw new CorruptRuntimeGenerationError("required Postgres executable missing");
	}
	const share = join(root, "share");
	if (await lstatOrUndefined(share)) {
		const timezone = join(
			share,
			...(binaries.postgres.endsWith(".exe") ? [] : ["postgresql"]),
			"timezonesets",
			"Default",
		);
		if (!(await lstatOrUndefined(timezone))?.isFile())
			throw new CorruptRuntimeGenerationError("required Postgres timezone data missing");
	}
}
async function statRuntimeEntries(root: string, progress: RuntimeProgress, source: boolean): Promise<RuntimeEntry[]> {
	const entries: RuntimeEntry[] = [];
	const rootStat = await lstat(root);
	assertRuntimeRoot(root, rootStat);
	const realRoot = await realpath(root);
	const visit = async (path: string, name: string): Promise<void> => {
		await progress();
		const info = await lstat(path);
		const suffix = source
			? `${info.size}:${info.mode & 0o777}:${info.mtimeMs}:${info.ctimeMs}:${info.birthtimeMs}:${info.dev}:${info.ino}`
			: undefined;
		if (info.isSymbolicLink()) {
			const target = await validatedLinkTarget(path, name, realRoot);
			entries.push([
				name,
				"link",
				0,
				info.uid,
				info.gid,
				source ? `${target}:${suffix}` : target,
				source ? undefined : [info.ctimeMs, info.ino, info.dev],
			]);
		} else if (info.isDirectory()) {
			entries.push(
				source
					? [name, "directory", info.mode & 0o777, info.uid, info.gid, suffix]
					: name === "."
						? [name, "directory", info.mode & 0o777, info.uid, info.gid, undefined]
						: [
								name,
								"directory",
								info.mode & 0o777,
								info.uid,
								info.gid,
								undefined,
								[info.ctimeMs, info.ino, info.dev],
							],
			);
			for (const child of (await readdir(path)).sort()) {
				if (!source && name === "." && child === RUNTIME_MARKER) continue;
				await visit(join(path, child), name === "." ? child : join(name, child));
			}
		} else if (info.isFile()) {
			entries.push([
				name,
				"file",
				info.mode & 0o777,
				info.uid,
				info.gid,
				source ? `${info.size}:${suffix}` : String(info.size),
				source ? undefined : [info.ctimeMs, info.ino, info.dev],
			]);
		} else throw new CorruptRuntimeGenerationError(`Unsupported runtime entry: ${name}`);
	};
	await visit(root, ".");
	return entries;
}

async function snapshotSealedManifest(root: string, progress: RuntimeProgress): Promise<RuntimeManifest> {
	const rootStat = await lstat(root);
	assertRuntimeRoot(root, rootStat);
	const rootRealPath = await realpath(root);
	const hash = createHash("sha256");
	const entries: RuntimeEntry[] = [];
	await hashSealedEntry(hash, root, ".", rootRealPath, progress, entries);
	return { version: 1, sealedIdentity: hash.digest("hex"), entries };
}

async function hashSealedEntry(
	hash: Hash,
	path: string,
	relativePath: string,
	rootRealPath: string,
	progress: RuntimeProgress,
	entries: RuntimeEntry[],
): Promise<void> {
	await progress();
	const stat = await lstat(path);
	if (stat.isSymbolicLink()) {
		const target = await validatedLinkTarget(path, relativePath, rootRealPath);
		entries.push([relativePath, "link", 0, stat.uid, stat.gid, target, [stat.ctimeMs, stat.ino, stat.dev]]);
		hashField(hash, "link", relativePath, String(stat.uid), String(stat.gid), target);
		return;
	}
	if (stat.isDirectory()) {
		hashField(hash, "directory", relativePath, String(stat.mode & 0o777), String(stat.uid), String(stat.gid));
		entries.push(
			relativePath === "."
				? [relativePath, "directory", stat.mode & 0o777, stat.uid, stat.gid, undefined]
				: [
						relativePath,
						"directory",
						stat.mode & 0o777,
						stat.uid,
						stat.gid,
						undefined,
						[stat.ctimeMs, stat.ino, stat.dev],
					],
		);
		for (const entry of (await readdir(path)).sort()) {
			if (relativePath === "." && entry === RUNTIME_MARKER) continue;
			await hashSealedEntry(
				hash,
				join(path, entry),
				relativePath === "." ? entry : join(relativePath, entry),
				rootRealPath,
				progress,
				entries,
			);
		}
		return;
	}
	if (stat.isFile()) {
		entries.push([
			relativePath,
			"file",
			stat.mode & 0o777,
			stat.uid,
			stat.gid,
			String(stat.size),
			[stat.ctimeMs, stat.ino, stat.dev],
		]);
		hashField(
			hash,
			"file",
			relativePath,
			String(stat.mode & 0o777),
			String(stat.uid),
			String(stat.gid),
			String(stat.size),
		);
		await hashFileInto([hash], path, progress);
		return;
	}
	throw new CorruptRuntimeGenerationError(`Embedded Postgres runtime contains an unsupported entry: ${relativePath}`);
}

async function validatedLinkTarget(path: string, relativePath: string, rootRealPath: string): Promise<string> {
	const target = await readlink(path);
	if (isAbsolute(target))
		throw new CorruptRuntimeGenerationError(`Embedded Postgres runtime contains an absolute link: ${relativePath}`);
	const resolvedTarget = await realpath(path);
	const targetFromRoot = relative(rootRealPath, resolvedTarget);
	if (targetFromRoot === ".." || targetFromRoot.startsWith(`..${sep}`) || isAbsolute(targetFromRoot)) {
		throw new CorruptRuntimeGenerationError(`Embedded Postgres runtime link escapes its tree: ${relativePath}`);
	}
	return target;
}

async function hashFileInto(hashes: readonly Hash[], path: string, progress: RuntimeProgress): Promise<void> {
	const handle = await open(path, "r");
	const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
	try {
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) return;
			const chunk = buffer.subarray(0, bytesRead);
			progress.onContentRead?.(path);
			for (const hash of hashes) hash.update(chunk);
			await progress();
		}
	} finally {
		await handle.close();
	}
}

async function sealRuntimeForPublisher(
	runtimeDir: string,
	publisher: PublisherIdentity,
	runner: LocalCommandRunner,
	progress: RuntimeProgress,
	needsPrivilegeDrop: boolean,
): Promise<void> {
	if (needsPrivilegeDrop) {
		const result = await runner("chown", ["-R", `${publisher.uid}:${publisher.gid}`, runtimeDir]);
		if (result.exitCode !== 0) {
			throw new Error(
				`Could not seal the copied embedded Postgres runtime: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
			);
		}
	}
	await sealRuntimeModes(runtimeDir, progress, true);
}

async function sealRuntimeModes(path: string, progress: RuntimeProgress, isRoot = false): Promise<void> {
	await progress();
	const stat = await lstat(path);
	if (stat.isSymbolicLink()) return;
	if (stat.isDirectory()) {
		await chmod(path, 0o700);
		for (const entry of await readdir(path)) await sealRuntimeModes(join(path, entry), progress);
		await chmod(path, sealedDirectoryMode(isRoot));
		return;
	}
	if (stat.isFile()) {
		await chmod(path, sealedFileMode(stat.mode));
		return;
	}
	throw new Error(`Embedded Postgres runtime contains an unsupported entry while sealing: ${path}`);
}

async function makeUnpublishedStageRemovable(path: string): Promise<void> {
	const stat = await lstatOrUndefined(path);
	if (stat === undefined || stat.isSymbolicLink()) return;
	if (stat.isDirectory()) {
		await chmod(path, 0o700);
		for (const entry of await readdir(path)) await makeUnpublishedStageRemovable(join(path, entry));
	} else if (stat.isFile()) {
		await chmod(path, 0o600);
	}
}

function sealedDirectoryMode(isRoot: boolean): number {
	// Node maps Windows chmod/stat to one shared read-only attribute; it cannot
	// preserve POSIX execute bits or distinct owner/group/other permissions.
	if (process.platform === "win32") return 0o444;
	return isRoot ? 0o755 : 0o555;
}

function sealedFileMode(mode: number): number {
	if (process.platform === "win32") return 0o444;
	return (mode & 0o111) === 0 ? 0o444 : 0o555;
}

function publisherIdentity(): PublisherIdentity {
	return { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
}

function assertRuntimeRoot(root: string, stat: Stats): void {
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new CorruptRuntimeGenerationError(`Embedded Postgres runtime must be a real directory: ${root}`);
	}
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code === "ENOENT") return undefined;
		throw error;
	}
}

async function readSmallFile(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const stat = await handle.stat();
		if (stat.size > 4096) throw new Error(`Unexpectedly large runtime stage owner marker: ${path}`);
		return (await handle.readFile("utf8")).trim();
	} finally {
		await handle.close();
	}
}

function hashField(hash: Hash, ...values: readonly string[]): void {
	for (const value of values) hash.update(`${Buffer.byteLength(value)}:${value}`);
}

async function lookupOwner(runner: LocalCommandRunner, name: string): Promise<EmbeddedPostgresOwner | undefined> {
	const uid = await lookupId(runner, ["-u", name]);
	const gid = await lookupId(runner, ["-g", name]);
	if (uid === undefined || gid === undefined || uid === 0) return undefined;
	return { uid, gid, name };
}

async function lookupId(runner: LocalCommandRunner, args: readonly string[]): Promise<number | undefined> {
	try {
		const value = parseIdentityNumber(await runner("id", args));
		return value !== undefined && value > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Single-quote a command line for `su -c`; arguments never embed user input. */
function shellCommand(command: string, args: readonly string[]): string {
	return [command, ...args].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
}
