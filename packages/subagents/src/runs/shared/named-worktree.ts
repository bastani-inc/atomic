import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type AdvisoryLock, renameNoReplaceAsync, tryAdvisoryLockAsync } from "@bastani/atomic-natives";
import { pathExists } from "../../shared/path-exists.js";
import { addNamedWorktree } from "./named-worktree-git.js";
import { ensureWorktreeIgnore, runGit } from "./worktree.js";
import { findCanonicalGitRoot } from "./worktree-root.js";

export interface NamedWorktreeRequest {
	readonly branch: string;
	readonly base?: string;
	readonly path?: string;
}

export interface NamedWorktree {
	readonly repo: string;
	readonly path: string;
	readonly agentCwd: string;
	readonly branch: string;
	readonly baseCommit: string;
}

export interface NamedWorktreeOptions {
	readonly signal?: AbortSignal;
	readonly onWaiting?: (message: string | undefined) => void;
}

interface ListedWorktree {
	readonly path: string;
	readonly branch?: string;
}

const CONCURRENT_ADD_WAIT_MS = 30_000;
const CONCURRENT_ADD_POLL_MS = 100;
const INHERITED_LOCKS_ENV = "ATOMIC_NAMED_WORKTREE_LOCKS";
const commonDirectories = new Map<string, string>();
const CONCURRENT_GIT_FAILURE =
	/(?:^|\n)(?:(?:fatal|error): )?(?:failed to read ['"][^\n]*[/\\]locked['"]|(?:Unable to create|cannot lock ref)[^\n]*\.lock['"]?: File exists|another git process seems to be running|cannot lock references)/i;
const SIBLING_REGISTRATION_FAILURE =
	/^fatal: failed to read ['"]?([^\r\n]+?[/\\]worktrees[/\\][^/\\\r\n]+[/\\]commondir)['"]?: [^\r\n]*\r?$/m;
const OWNED_ADD_LOCK_PREFIX = "atomic-named-worktree-add:";
const INITIALIZING_LOCK_REASONS = new Set([
	"initializing",
	"inisialiseer",
	"инициализация",
	"s'està inicialitzant",
	"inicialització en curs",
	"initialisiere",
	"inicializando",
	"initialisation",
	"a thionscnamh",
	"menginisialisasi",
	"inicjowanie",
	"iniciando",
	"initierar",
	"ilklendiriliyor",
	"ініціалізація",
	"khởi tạo",
	"初始化",
	"正在初始化",
]);
const SIBLING_REGISTRATION_ATTEMPTS = 5;
/**
 * How long an add waits, in all, between its attempts for another worktree's registration to finish. Only the waits
 * count: the add's own Git commands between attempts take seconds on a loaded machine, and counting them too used up
 * the whole wait before the first retry.
 */
const SIBLING_REGISTRATION_WAIT_MS = 1_000;
const CONCURRENT_ADD_FAILURE = /already exists|already checked out|already used by worktree|is a missing but/i;

class GitFailure extends Error {}

export class WorktreeReentryError extends Error {
	constructor(worktreePath: string) {
		super(
			`worktree: a checkout hook cannot synchronously create another named worktree for the same branch or path (${worktreePath}). Finish the current checkout and retry outside the hook.`,
		);
		this.name = "WorktreeReentryError";
	}
}

export class WorktreeBusyError extends Error {
	constructor(worktreePath: string, indexLock: string | null, interrupted = false, referenceLocks: string[] = []) {
		const state = interrupted
			? "an interrupted named-worktree checkout left an incomplete worktree"
			: "another git process seems to be running";
		const lock = indexLock === null ? "" : ` Git's checkout lock is ${indexLock}.`;
		const wait = interrupted ? "" : " Wait for it to finish and retry.";
		const locations = referenceLocks.length ? ` Reference lock locations: ${referenceLocks.join(", ")}.` : "";
		super(
			`worktree: ${state} at ${worktreePath}.${lock}${wait} Once no Git process is using this worktree or repository, inspect and save any files you need. Run git worktree unlock ${JSON.stringify(worktreePath)}, remove the worktree directory, then run git worktree prune. Remove any stale HEAD.lock and branch reference .lock files before launching again.${locations} If its metadata is intact, git worktree remove --force --force ${JSON.stringify(worktreePath)} also removes the worktree. Do not repair a partial checkout by deleting only index.lock.`,
		);
		this.name = "WorktreeBusyError";
	}
}

async function gitChecked(cwd: string, args: string[]): Promise<string> {
	const result = await runGit(cwd, args, { LC_ALL: "C", LANGUAGE: "C" });
	if (result.status !== 0)
		throw new GitFailure(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	return result.stdout;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	try {
		await delay(ms, undefined, { signal });
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	}
}

async function comparablePath(value: string): Promise<string> {
	const resolved = path.resolve(value);
	let canonical: string;
	try {
		canonical = await fs.realpath(resolved);
	} catch {
		const parent = path.dirname(resolved);
		canonical = parent === resolved ? resolved : path.join(await comparablePath(parent), path.basename(resolved));
	}
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

async function commonGitDirectory(repo: string): Promise<string> {
	const key = await comparablePath(repo);
	const cached = commonDirectories.get(key);
	if (cached !== undefined && (await pathExists(cached))) return cached;
	const commonDir = path.resolve(repo, (await gitChecked(repo, ["rev-parse", "--git-common-dir"])).trim());
	commonDirectories.set(key, commonDir);
	return commonDir;
}

interface CheckoutState {
	readonly gitDir: string;
	readonly ownedAdd: boolean;
	readonly blocker: string | null | undefined;
}

async function checkoutState(gitDir: string, commonDir: string, branch: string): Promise<CheckoutState> {
	let reason = "";
	try {
		reason = (await fs.readFile(path.join(gitDir, "locked"), "utf8")).trim();
	} catch {}
	const ownedAdd = reason.startsWith(OWNED_ADD_LOCK_PREFIX);
	const initializing = ownedAdd || INITIALIZING_LOCK_REASONS.has(reason);
	const indexLock = path.join(gitDir, "index.lock");
	if (await pathExists(indexLock)) return { gitDir, ownedAdd, blocker: indexLock };
	if (initializing) {
		for (const lock of [path.join(gitDir, "HEAD.lock"), path.join(commonDir, "refs", "heads", `${branch}.lock`)]) {
			if (await pathExists(lock)) return { gitDir, ownedAdd, blocker: lock };
		}
	}
	let head: string;
	try {
		head = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
	} catch {
		return { gitDir, ownedAdd, blocker: initializing ? null : undefined };
	}
	if (/^(?:0{40}|0{64})$/.test(head) || (initializing && !(await pathExists(path.join(gitDir, "index")))))
		return { gitDir, ownedAdd, blocker: null };
	return { gitDir, ownedAdd, blocker: undefined };
}

async function targetCheckoutState(
	commonDir: string,
	worktreePath: string,
	branch: string,
): Promise<CheckoutState | undefined> {
	const gitFile = path.join(worktreePath, ".git");
	if ((await comparablePath(gitFile)) === (await comparablePath(commonDir)))
		return checkoutState(commonDir, commonDir, branch);
	try {
		const pointer = await fs.readFile(gitFile, "utf8");
		if (!pointer.startsWith("gitdir:")) return undefined;
		const entry = path.resolve(worktreePath, pointer.slice("gitdir:".length).trim());
		if ((await comparablePath(path.dirname(entry))) !== (await comparablePath(path.join(commonDir, "worktrees"))))
			return undefined;
		const back = (await fs.readFile(path.join(entry, "gitdir"), "utf8")).trim();
		if ((await comparablePath(path.resolve(entry, back))) !== (await comparablePath(gitFile))) return undefined;
		return checkoutState(entry, commonDir, branch);
	} catch {
		return undefined;
	}
}

async function repositoryLockModes(commonDir: string): Promise<{ dirMode: number; gid: number | undefined }> {
	if (process.platform === "win32") return { dirMode: 0o700, gid: undefined };
	for (const directory of [path.join(commonDir, "objects", "info"), path.join(commonDir, "worktrees"), commonDir]) {
		try {
			const stat = await fs.stat(directory);
			const groupMode = (stat.mode & 0o020) !== 0 ? 0o2070 : 0;
			const otherMode = (stat.mode & 0o002) !== 0 ? 0o007 : 0;
			return { dirMode: 0o700 | (stat.mode & 0o2000) | groupMode | otherMode, gid: stat.gid };
		} catch {}
	}
	return { dirMode: 0o700, gid: undefined };
}

function isReadonlyLocationError(error: unknown): boolean {
	const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
	return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

async function validateFallbackLockDirectory(targetDir: string, gid: number | undefined): Promise<void> {
	const stat = await fs.lstat(targetDir);
	if (!stat.isDirectory()) throw new Error(`${targetDir}: lock directory is not a directory`);
	if (process.platform === "win32") return;
	if ((stat.mode & 0o002) !== 0) throw new Error(`${targetDir}: lock directory must not be world-writable`);
	const euid = process.geteuid?.();
	const ownedByCurrent = euid === undefined || stat.uid === euid;
	const sharedWithGroup = gid !== undefined && stat.gid === gid && (stat.mode & 0o060) === 0o060;
	if (!ownedByCurrent && !sharedWithGroup) throw new Error(`${targetDir}: lock directory is owned by another user`);
}

async function createLockDirectory(targetDir: string, dirMode: number, gid: number | undefined): Promise<void> {
	if (await pathExists(targetDir)) return;
	const parentDir = path.dirname(targetDir);
	if (!(await pathExists(parentDir))) await fs.mkdir(parentDir, { recursive: true, mode: dirMode });
	if (await pathExists(targetDir)) return;
	const temporary = await fs.mkdtemp(`${targetDir}-`);
	try {
		if (process.platform !== "win32") {
			if (gid !== undefined) {
				try {
					await fs.chown(temporary, -1, gid);
				} catch {}
			}
			try {
				await fs.chmod(temporary, dirMode);
			} catch {
				await fs.chmod(temporary, dirMode & 0o777);
			}
		}
		if (!(await renameNoReplaceAsync(temporary, targetDir)) && !(await pathExists(targetDir))) {
			try {
				await fs.rename(temporary, targetDir);
			} catch (error) {
				if (!(await pathExists(targetDir))) throw error;
			}
		}
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

async function resolveLockDirectory(commonDir: string): Promise<string> {
	const canonicalCommon = await comparablePath(commonDir);
	const primary = path.join(canonicalCommon, "objects", "info", "atomic-named-worktree-locks");
	if (await pathExists(primary)) return primary;
	const fallback = path.join(
		os.tmpdir(),
		`atomic-named-worktree-locks-${createHash("sha256").update(canonicalCommon).digest("hex")}`,
	);
	const { dirMode, gid } = await repositoryLockModes(canonicalCommon);
	if (await pathExists(fallback)) {
		await validateFallbackLockDirectory(fallback, gid);
		return fallback;
	}
	try {
		await createLockDirectory(primary, dirMode, gid);
		return primary;
	} catch (error) {
		if (await pathExists(primary)) return primary;
		if (!isReadonlyLocationError(error)) throw error;
		await createLockDirectory(fallback, dirMode, gid);
		await validateFallbackLockDirectory(fallback, gid);
		return fallback;
	}
}

async function lockPaths(commonDir: string, branch: string, worktreePath: string): Promise<string[]> {
	const lockDir = await resolveLockDirectory(commonDir);
	const key = (kind: string, value: string): string =>
		path.join(lockDir, `${kind}-${createHash("sha256").update(value).digest("hex")}.lock`);
	return [
		key("path", await comparablePath(worktreePath)),
		key("branch", process.platform === "win32" ? branch.toLowerCase() : branch),
	];
}

function inheritedLocks(): string[] {
	const raw = process.env[INHERITED_LOCKS_ENV];
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) && parsed.every((item): item is string => typeof item === "string") ? parsed : [];
	} catch {
		return [];
	}
}

async function lockFileMode(lockDir: string): Promise<number> {
	if (process.platform === "win32") return 0o600;
	try {
		return 0o600 | ((await fs.stat(lockDir)).mode & 0o066);
	} catch {}
	return 0o600;
}

async function acquireTargetLock(lockPath: string, fileMode: number): Promise<AdvisoryLock | null> {
	try {
		if (process.platform !== "win32" && fileMode !== 0o600 && !(await pathExists(lockPath))) {
			try {
				const handle = await fs.open(
					lockPath,
					fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
					fileMode,
				);
				try {
					await handle.chmod(fileMode);
				} finally {
					await handle.close();
				}
			} catch (error) {
				const code =
					error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
				if (code !== "EEXIST") throw error;
			}
		}
		return await tryAdvisoryLockAsync(lockPath, 0);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(detail.includes(lockPath) ? detail : `${lockPath}: ${detail}`, { cause: error });
	}
}

async function withTargetLocks<T>(
	paths: string[],
	worktreePath: string,
	options: NamedWorktreeOptions,
	notifyWaiting: () => void,
	create: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
	const inherited = inheritedLocks();
	const inheritedSet = new Set(await Promise.all(inherited.map(comparablePath)));
	const fileMode = await lockFileMode(path.dirname(paths[0]!));
	const held: AdvisoryLock[] = [];
	try {
		for (;;) {
			options.signal?.throwIfAborted();
			for (const lockPath of paths) {
				const lock = await acquireTargetLock(lockPath, fileMode);
				if (lock === null) {
					for (const acquired of held.splice(0).reverse()) acquired.release();
					if (inheritedSet.has(await comparablePath(lockPath))) throw new WorktreeReentryError(worktreePath);
					for (const otherPath of paths) {
						if (otherPath === lockPath || !inheritedSet.has(await comparablePath(otherPath))) continue;
						const probe = await acquireTargetLock(otherPath, fileMode);
						if (probe === null) throw new WorktreeReentryError(worktreePath);
						probe.release();
					}
					break;
				}
				held.push(lock);
			}
			if (held.length === paths.length) break;
			notifyWaiting();
			await sleep(CONCURRENT_ADD_POLL_MS, options.signal);
		}
		options.signal?.throwIfAborted();
		return await create({ [INHERITED_LOCKS_ENV]: JSON.stringify([...new Set([...inherited, ...paths])]) });
	} finally {
		for (const lock of held.splice(0).reverse()) lock.release();
	}
}

async function listWorktrees(repo: string): Promise<ListedWorktree[]> {
	const listed: ListedWorktree[] = [];
	for (const block of (await gitChecked(repo, ["worktree", "list", "--porcelain"])).split(/\r?\n\r?\n/)) {
		const lines = block.split(/\r?\n/);
		const worktreePath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
		if (!worktreePath) continue;
		const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
		listed.push({ path: worktreePath, ...(branch ? { branch } : {}) });
	}
	return listed;
}

async function defaultBase(cwd: string): Promise<string> {
	const upstream = await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	return upstream.status === 0 ? upstream.stdout.trim() : "HEAD";
}

async function resolveCommitRevision(cwd: string, revision: string): Promise<string> {
	const target = revision.startsWith(":/")
		? (await gitChecked(cwd, ["rev-parse", "--verify", "--end-of-options", revision])).trim()
		: revision;
	return (await gitChecked(cwd, ["rev-parse", "--verify", "--end-of-options", `${target}^{commit}`])).trim();
}

async function isEmptyDirectory(target: string): Promise<boolean> {
	return (await fs.stat(target)).isDirectory() && (await fs.readdir(target)).length === 0;
}

async function withAgentCwd(worktreePath: string, cwdRelative: string): Promise<string> {
	const nested = path.join(worktreePath, cwdRelative);
	return (await pathExists(nested)) ? nested : worktreePath;
}

async function siblingRegistrationEntry(
	repo: string,
	commonDir: string,
	worktreePath: string,
	message: string,
): Promise<string | undefined> {
	const metadata = message.match(SIBLING_REGISTRATION_FAILURE)?.[1];
	if (metadata === undefined) return undefined;
	const entry = path.dirname(path.resolve(repo, metadata));
	if ((await comparablePath(path.dirname(entry))) !== (await comparablePath(path.join(commonDir, "worktrees"))))
		return undefined;
	const name = path.basename(await comparablePath(entry));
	if (name === path.basename(await comparablePath(worktreePath))) return undefined;
	return path.basename(entry);
}

async function addWasCleanedUp(commonDir: string, worktreePath: string, siblingEntry: string): Promise<boolean> {
	if ((await pathExists(worktreePath)) && !(await isEmptyDirectory(worktreePath))) return false;
	const entriesDir = path.join(commonDir, "worktrees");
	if (!(await pathExists(entriesDir))) return true;
	const target = await comparablePath(path.join(worktreePath, ".git"));
	try {
		for (const name of await fs.readdir(entriesDir)) {
			const entry = path.join(entriesDir, name);
			try {
				const gitFile = (await fs.readFile(path.join(entry, "gitdir"), "utf8")).trim();
				if ((await comparablePath(path.resolve(entry, gitFile))) === target) return false;
			} catch {
				if (name !== siblingEntry) return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

export async function ensureNamedWorktree(
	cwd: string,
	request: NamedWorktreeRequest,
	options: NamedWorktreeOptions = {},
): Promise<NamedWorktree> {
	options.signal?.throwIfAborted();
	const branch = request.branch;
	const formatted = await runGit(cwd, ["check-ref-format", "--branch", branch]);
	if (formatted.status !== 0 || formatted.stdout.trim() !== branch || branch.includes("@{"))
		throw new Error(`worktree.branch "${request.branch}" is not a valid branch name.`);
	let deadline = performance.now() + CONCURRENT_ADD_WAIT_MS;
	const waiting = (): boolean => performance.now() < deadline;
	const failed = (what: string, error: unknown): Error => {
		if (!(error instanceof GitFailure) && error instanceof Error && error.message.startsWith("worktree"))
			return error;
		const detail = error instanceof Error ? error.message : String(error);
		return new Error(`worktree: ${what}: ${detail}`, { cause: error });
	};
	const retried = async <T>(what: string, attempt: () => T | Promise<T>): Promise<T> => {
		for (;;) {
			try {
				options.signal?.throwIfAborted();
				return await attempt();
			} catch (error) {
				const wrapped = failed(what, error);
				if (!(error instanceof GitFailure) || !CONCURRENT_GIT_FAILURE.test(error.message) || !waiting())
					throw wrapped;
				await sleep(CONCURRENT_ADD_POLL_MS, options.signal);
			}
		}
	};
	const { cwdRelative, repo, commonDir } = await retried(`could not find the repository of ${cwd}`, async () => {
		const toplevel = path.resolve((await gitChecked(cwd, ["rev-parse", "--show-toplevel"])).trim());
		const cwdRelative = path.relative(await fs.realpath(toplevel), await fs.realpath(cwd));
		const repo = await findCanonicalGitRoot(toplevel);
		if (repo === undefined) throw new Error(`unable to resolve canonical main Git repository root from ${toplevel}`);
		const commonDir = await commonGitDirectory(repo);
		return { cwdRelative, repo, commonDir };
	});
	const defaultPath = request.path === undefined;
	const worktreePath = defaultPath
		? path.join(repo, ".atomic", "worktrees", branch.replaceAll("/", "+"))
		: path.resolve(cwd, request.path!);
	const checkingOut = `could not check out branch "${branch}" at ${worktreePath}`;
	let nextNotice = performance.now() + 2_000;
	let showedWaiting = false;
	const notifyWaiting = (): void => {
		if (performance.now() < nextNotice) return;
		showedWaiting = true;
		options.onWaiting?.(`Waiting for another launch to finish creating ${worktreePath}`);
		nextNotice = performance.now() + 2_000;
	};
	try {
		const targetLocks = await lockPaths(commonDir, branch, worktreePath);
		return await withTargetLocks(targetLocks, worktreePath, options, notifyWaiting, async (env) => {
			deadline = performance.now() + CONCURRENT_ADD_WAIT_MS;
			const ready = async (): Promise<NamedWorktree> => ({
				repo,
				path: worktreePath,
				agentCwd: await withAgentCwd(worktreePath, cwdRelative),
				branch,
				baseCommit: await retried(checkingOut, async () =>
					(await gitChecked(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"])).trim(),
				),
			});
			let addFailure:
				| {
						message: string;
						diagnostic: string;
						branchExisted: boolean;
						retrySibling?: boolean;
						siblingEntry?: string;
				  }
				| undefined;
			let startPoint: string | undefined;
			let siblingFailures = 0;
			let siblingWaitedMs = 0;
			for (;;) {
				options.signal?.throwIfAborted();
				const previous = await targetCheckoutState(commonDir, worktreePath, branch);
				if (previous?.ownedAdd) {
					if (previous.blocker !== undefined)
						throw new WorktreeBusyError(worktreePath, previous.blocker, true, [
							path.join(previous.gitDir, "HEAD.lock"),
							path.join(commonDir, "refs", "heads", `${branch}.lock`),
						]);
					await fs.rm(path.join(previous.gitDir, "locked"));
				}
				if (addFailure?.retrySibling === false) throw failed(checkingOut, new GitFailure(addFailure.message));
				let decision: WorktreeDecision;
				try {
					decision = await retried(checkingOut, () => decideWorktree(repo, commonDir, branch, worktreePath));
					if (decision.kind === "wait" && !waiting())
						decision = await retried(checkingOut, () => decideWorktree(repo, commonDir, branch, worktreePath));
				} catch (error) {
					const cause = error instanceof Error ? error.cause : undefined;
					const siblingEntry =
						cause instanceof GitFailure
							? await siblingRegistrationEntry(repo, commonDir, worktreePath, cause.message)
							: undefined;
					if (siblingEntry === undefined || !(await addWasCleanedUp(commonDir, worktreePath, siblingEntry)))
						throw error;
					siblingFailures++;
					const backoff = Math.min(20 * 2 ** (siblingFailures - 1), 200);
					if (
						siblingFailures >= SIBLING_REGISTRATION_ATTEMPTS ||
						siblingWaitedMs + backoff > SIBLING_REGISTRATION_WAIT_MS
					)
						throw error;
					siblingWaitedMs += backoff;
					await sleep(backoff, options.signal);
					continue;
				}
				if (decision.kind === "wait") {
					if (!waiting()) throw new WorktreeBusyError(worktreePath, decision.indexLock);
					notifyWaiting();
					await sleep(CONCURRENT_ADD_POLL_MS, options.signal);
					continue;
				}
				if (decision.kind === "reuse") return ready();
				const branchExists =
					(await runGit(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).status === 0;
				if (
					addFailure !== undefined &&
					addFailure.retrySibling !== true &&
					(!waiting() ||
						(!CONCURRENT_GIT_FAILURE.test(addFailure.diagnostic) &&
							(branchExists === addFailure.branchExisted ||
								!CONCURRENT_ADD_FAILURE.test(addFailure.diagnostic))))
				)
					throw failed(checkingOut, new GitFailure(addFailure.message));
				if (!branchExists && startPoint === undefined) {
					const baseRevision = request.base ?? (await defaultBase(cwd));
					startPoint = await retried(`${checkingOut}: invalid reference: ${baseRevision}`, () =>
						resolveCommitRevision(cwd, baseRevision),
					);
				}
				if (defaultPath) await retried(checkingOut, () => ensureWorktreeIgnore(repo));
				if (
					addFailure?.retrySibling === true &&
					!(await addWasCleanedUp(commonDir, worktreePath, addFailure.siblingEntry ?? ""))
				)
					throw failed(checkingOut, new GitFailure(addFailure.message));
				const lockReason = `${OWNED_ADD_LOCK_PREFIX}${process.pid}`;
				const addArgs = ["worktree", "add", "--lock", "--reason", lockReason];
				const added = await addNamedWorktree(
					repo,
					branchExists
						? [...addArgs, worktreePath, branch]
						: [...addArgs, "--no-track", "-b", branch, worktreePath, startPoint!],
					env,
					options.signal,
				);
				const completed = await targetCheckoutState(commonDir, worktreePath, branch);
				if (completed?.ownedAdd && completed.blocker === undefined)
					await fs.rm(path.join(completed.gitDir, "locked"));
				if (added.status === 0) return ready();
				const message = added.stderr.trim() || added.stdout.trim() || "git worktree add failed";
				const diagnostic = [worktreePath, repo].reduce(
					(text, operand) => text.replaceAll(operand.replaceAll("\\", "/"), "<path>"),
					message.replaceAll("\\", "/"),
				);
				const siblingEntry = await siblingRegistrationEntry(repo, commonDir, worktreePath, message);
				if (siblingEntry !== undefined) {
					siblingFailures++;
					const backoff = Math.min(20 * 2 ** (siblingFailures - 1), 200);
					const retrySibling =
						siblingFailures < SIBLING_REGISTRATION_ATTEMPTS &&
						siblingWaitedMs + backoff <= SIBLING_REGISTRATION_WAIT_MS &&
						(await addWasCleanedUp(commonDir, worktreePath, siblingEntry));
					addFailure = { message, diagnostic, branchExisted: branchExists, retrySibling, siblingEntry };
					if (retrySibling) {
						siblingWaitedMs += backoff;
						await sleep(backoff, options.signal);
					}
				} else {
					addFailure = { message, diagnostic, branchExisted: branchExists };
					if (CONCURRENT_GIT_FAILURE.test(diagnostic) || CONCURRENT_ADD_FAILURE.test(diagnostic))
						await sleep(CONCURRENT_ADD_POLL_MS, options.signal);
				}
			}
		});
	} catch (error) {
		throw failed(checkingOut, error);
	} finally {
		if (showedWaiting) options.onWaiting?.(undefined);
	}
}

type WorktreeDecision = { kind: "reuse" | "create" } | { kind: "wait"; indexLock: string | null };

async function decideWorktree(
	repo: string,
	commonDir: string,
	branch: string,
	worktreePath: string,
): Promise<WorktreeDecision> {
	const before = (await targetCheckoutState(commonDir, worktreePath, branch))?.blocker;
	if (before !== undefined) return { kind: "wait", indexLock: before };
	const target = await comparablePath(worktreePath);
	const worktrees = await listWorktrees(repo);
	const after = (await targetCheckoutState(commonDir, worktreePath, branch))?.blocker;
	if (after !== undefined) return { kind: "wait", indexLock: after };
	let atPath: ListedWorktree | undefined;
	for (const worktree of worktrees) {
		if ((await comparablePath(worktree.path)) === target) {
			atPath = worktree;
			break;
		}
	}
	if (atPath?.branch === branch) return { kind: "reuse" };
	const elsewhere = worktrees.find((worktree) => worktree.branch === branch);
	if (elsewhere)
		throw new Error(
			`worktree: branch "${branch}" is already checked out at ${path.resolve(elsewhere.path)}, so it cannot be checked out at ${worktreePath}. Pass that path as worktree.path to reuse it, or name another branch.`,
		);
	if (atPath || ((await pathExists(worktreePath)) && !(await isEmptyDirectory(worktreePath))))
		throw new Error(
			`worktree: ${worktreePath} already exists and is not the worktree of branch "${branch}". Choose another worktree.path or branch.`,
		);
	return { kind: "create" };
}
