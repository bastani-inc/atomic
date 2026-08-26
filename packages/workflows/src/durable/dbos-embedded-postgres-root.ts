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
 * The embedded binaries themselves may also live under an untraversable
 * probe them as the unprivileged owner and fall back to a recoverable staged
 * copy in the cluster base directory.
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
	readlink,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
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
	/** Test seam for deterministic event-loop cooperation without real delays. */
	readonly yieldToEventLoop?: () => Promise<void>;
}

const STAGE_OWNER_FILE = ".atomic-stage-owner";
const STAGE_PAYLOAD_DIR = "runtime";
const TRAVERSAL_OPERATIONS_PER_YIELD = 16;
const HASH_CHUNK_BYTES = 64 * 1024;

/**
 * Ensure the embedded binaries are executable by the drop-privilege owner.
 * Probes `initdb --version` as the owner; on failure (typically an
 * untraversable ancestor such as `/root`) uses an immutable copied package
 * generation. Each generation is tied to the exact source-tree content and
 * raw symlink text, so a stale or corrupt prior copy is never selected.
 */
export async function prepareBinariesForOwner(
	binaries: EmbeddedPostgresBinaryPaths,
	context: EmbeddedPostgresRunContext,
	runner: LocalCommandRunner = runLocalCommand,
	options: RuntimePreparationOptions = {},
): Promise<EmbeddedPostgresBinaryPaths> {
	const owner = context.owner;
	if (owner === undefined) return binaries;

	const probe = await context.runAsOwner(binaries.initdb, ["--version"]).catch(() => undefined);
	if (probe !== undefined && probe.exitCode === 0) return binaries;

	// `<packageRoot>/native/bin/initdb` → copy the whole `native` tree so the
	// binaries keep their relative `../lib` runtime library references. Do not
	// resolve or rewrite the configured caller paths or any relative link text.
	const sourceNativeDir = dirname(dirname(binaries.initdb));
	const copiedRuntimeDir = join(context.baseDir, "pg-runtime");
	const publisher = publisherIdentity();
	const progress = runtimeProgress(options);
	const sourceSnapshot = await snapshotSourceRuntime(sourceNativeDir, publisher, progress);
	await options.afterInitialSourceSnapshot?.();
	const copiedNativeDir = await findOrCreateRuntimeGeneration(
		sourceNativeDir,
		sourceSnapshot,
		copiedRuntimeDir,
		publisher,
		runner,
		progress,
		options,
	);
	return {
		pg_ctl: join(copiedNativeDir, "bin", "pg_ctl"),
		initdb: join(copiedNativeDir, "bin", "initdb"),
		postgres: join(copiedNativeDir, "bin", "postgres"),
	};
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

type RuntimeProgress = () => Promise<void>;

/**
 * One exact source identity owns one deterministic path. If that path is
 * externally corrupted it is retained (it may be executing) and setup fails
 * closed; repeated calls neither append repair generations nor scan legacy
 * unique generations, selected `native`, or `.native-retired-*` evidence.
 */
async function findOrCreateRuntimeGeneration(
	sourceNativeDir: string,
	sourceSnapshot: SourceRuntimeSnapshot,
	copiedRuntimeDir: string,
	publisher: PublisherIdentity,
	runner: LocalCommandRunner,
	progress: RuntimeProgress,
	options: RuntimePreparationOptions,
): Promise<string> {
	await mkdir(copiedRuntimeDir, { recursive: true, mode: 0o755 });
	const runtimeStat = await lstat(copiedRuntimeDir);
	if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
		throw new Error(`Embedded Postgres runtime parent must be a real directory: ${copiedRuntimeDir}`);
	}
	await chown(copiedRuntimeDir, publisher.uid, publisher.gid);
	await chmod(copiedRuntimeDir, 0o755);
	const generationNativeDir = join(copiedRuntimeDir, `native-${sourceSnapshot.sourceIdentity}`);
	const existing = await lstatOrUndefined(generationNativeDir);
	if (existing !== undefined) {
		try {
			if ((await snapshotSealedRuntime(generationNativeDir, progress)) !== sourceSnapshot.sealedIdentity) {
				throw new Error("sealed identity mismatch");
			}
			await assertSourceSnapshotUnchanged(
				sourceNativeDir,
				sourceSnapshot,
				publisher,
				progress,
				"Embedded Postgres source package changed while selecting an existing generation.",
			);
			return generationNativeDir;
		} catch (error) {
			if (error instanceof SourceRuntimeChangedError) throw error;
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Embedded Postgres runtime generation is corrupt and cannot be replaced while it may be in use (${generationNativeDir}): ${detail}`,
			);
		}
	}

	const stageOwner = options.publicationLease?.ownerToken ?? `unmanaged-${process.pid}-${crypto.randomUUID()}`;
	const stagedRoot = join(copiedRuntimeDir, `.native-staged-${process.pid}-${crypto.randomUUID()}`);
	const stagedNativeDir = join(stagedRoot, STAGE_PAYLOAD_DIR);
	await mkdir(stagedRoot, { mode: 0o700 });
	await writeFile(join(stagedRoot, STAGE_OWNER_FILE), stageOwner, { mode: 0o600, flag: "wx" });
	try {
		await progress();
		await cp(sourceNativeDir, stagedNativeDir, { recursive: true, verbatimSymlinks: true });
		const copiedSnapshot = await snapshotSourceRuntime(stagedNativeDir, publisher, progress);
		if (copiedSnapshot.sourceIdentity !== sourceSnapshot.sourceIdentity) {
			throw new Error("Copied embedded Postgres runtime did not match its source package.");
		}
		await sealRuntimeForPublisher(stagedNativeDir, publisher, runner, progress);
		if ((await snapshotSealedRuntime(stagedNativeDir, progress)) !== sourceSnapshot.sealedIdentity) {
			throw new Error("Sealed embedded Postgres runtime did not match its source package.");
		}
		await options.beforePublish?.(stagedNativeDir);
		if ((await snapshotSealedRuntime(stagedNativeDir, progress)) !== sourceSnapshot.sealedIdentity) {
			throw new Error("Embedded Postgres runtime changed after sealed validation and before publication.");
		}
		await assertSourceSnapshotUnchanged(
			sourceNativeDir,
			sourceSnapshot,
			publisher,
			progress,
			"Embedded Postgres source package changed while preparing a generation.",
		);
		assertPublicationLease(options, "Embedded Postgres runtime publication lost its setup lease.");
		await progress();
		// The stage is publisher-owned and has no write bit for any uid before
		// this single same-parent rename. The Postgres uid therefore has no
		// validation-to-publication mutation window. Root mutation is caught by
		// validation through the deterministic path after the rename.
		await rename(stagedNativeDir, generationNativeDir);
		await options.afterPublish?.(generationNativeDir);
		if ((await snapshotSealedRuntime(generationNativeDir, progress)) !== sourceSnapshot.sealedIdentity) {
			throw new Error("Embedded Postgres published runtime changed during publication.");
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

class SourceRuntimeChangedError extends Error {}

async function assertSourceSnapshotUnchanged(
	sourceNativeDir: string,
	expected: SourceRuntimeSnapshot,
	publisher: PublisherIdentity,
	progress: RuntimeProgress,
	message: string,
): Promise<void> {
	const current = await snapshotSourceRuntime(sourceNativeDir, publisher, progress);
	if (current.sourceIdentity !== expected.sourceIdentity || current.sealedIdentity !== expected.sealedIdentity) {
		throw new SourceRuntimeChangedError(message);
	}
}

function assertPublicationLease(options: RuntimePreparationOptions, message: string): void {
	if (options.publicationLease !== undefined && !options.publicationLease.refresh()) throw new Error(message);
}
function runtimeProgress(options: RuntimePreparationOptions): RuntimeProgress {
	let operations = 0;
	const yieldToEventLoop = options.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
	return async () => {
		if (operations % TRAVERSAL_OPERATIONS_PER_YIELD === 0) {
			if (options.publicationLease !== undefined && !options.publicationLease.refresh()) {
				throw new Error("Embedded Postgres runtime publication lost its setup lease.");
			}
			if (operations > 0) {
				await yieldToEventLoop();
				if (options.publicationLease !== undefined && !options.publicationLease.refresh()) {
					throw new Error("Embedded Postgres runtime publication lost its setup lease.");
				}
			}
		}
		operations += 1;
	};
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
	throw new Error(`Embedded Postgres runtime contains an unsupported entry: ${relativePath}`);
}

async function snapshotSealedRuntime(root: string, progress: RuntimeProgress): Promise<string> {
	const rootStat = await lstat(root);
	assertRuntimeRoot(root, rootStat);
	const rootRealPath = await realpath(root);
	const hash = createHash("sha256");
	await hashSealedEntry(hash, root, ".", rootRealPath, progress);
	return hash.digest("hex");
}

async function hashSealedEntry(
	hash: Hash,
	path: string,
	relativePath: string,
	rootRealPath: string,
	progress: RuntimeProgress,
): Promise<void> {
	await progress();
	const stat = await lstat(path);
	if (stat.isSymbolicLink()) {
		const target = await validatedLinkTarget(path, relativePath, rootRealPath);
		hashField(hash, "link", relativePath, String(stat.uid), String(stat.gid), target);
		return;
	}
	if (stat.isDirectory()) {
		hashField(hash, "directory", relativePath, String(stat.mode & 0o777), String(stat.uid), String(stat.gid));
		for (const entry of (await readdir(path)).sort()) {
			await hashSealedEntry(
				hash,
				join(path, entry),
				relativePath === "." ? entry : join(relativePath, entry),
				rootRealPath,
				progress,
			);
		}
		return;
	}
	if (stat.isFile()) {
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
	throw new Error(`Embedded Postgres runtime contains an unsupported entry: ${relativePath}`);
}

async function validatedLinkTarget(path: string, relativePath: string, rootRealPath: string): Promise<string> {
	const target = await readlink(path);
	if (isAbsolute(target)) throw new Error(`Embedded Postgres runtime contains an absolute link: ${relativePath}`);
	const resolvedTarget = await realpath(path);
	const targetFromRoot = relative(rootRealPath, resolvedTarget);
	if (targetFromRoot === ".." || targetFromRoot.startsWith(`..${sep}`) || isAbsolute(targetFromRoot)) {
		throw new Error(`Embedded Postgres runtime link escapes its tree: ${relativePath}`);
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
): Promise<void> {
	const result = await runner("chown", ["-R", `${publisher.uid}:${publisher.gid}`, runtimeDir]);
	if (result.exitCode !== 0) {
		throw new Error(
			`Could not seal the copied embedded Postgres runtime: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
		);
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
		throw new Error(`Embedded Postgres runtime must be a real directory: ${root}`);
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
