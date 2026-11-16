import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { renameNoReplace, tryAdvisoryLock } from "@bastani/atomic-natives";
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
	constructor(worktreePath: string, indexLock: string | null, interrupted = false) {
		const state = interrupted
			? "an interrupted named-worktree checkout left an incomplete worktree"
			: "another git process seems to be running";
		const lock = indexLock === null ? "" : ` Git's checkout lock is ${indexLock}.`;
		const wait = interrupted ? "" : " Wait for it to finish and retry.";
		super(
			`worktree: ${state} at ${worktreePath}.${lock}${wait} If no Git process is using this worktree, inspect and save any files you need, then run git worktree remove --force --force ${JSON.stringify(worktreePath)} and launch again. Do not repair a partial checkout by deleting only index.lock.`,
		);
		this.name = "WorktreeBusyError";
	}
}

function gitChecked(cwd: string, args: string[]): string {
	const result = runGit(cwd, args, { LC_ALL: "C", LANGUAGE: "C" });
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

function comparablePath(value: string): string {
	const resolved = path.resolve(value);
	let canonical: string;
	try {
		canonical = fs.realpathSync(resolved);
	} catch {
		const parent = path.dirname(resolved);
		canonical = parent === resolved ? resolved : path.join(comparablePath(parent), path.basename(resolved));
	}
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function commonGitDirectory(repo: string): string {
	const key = comparablePath(repo);
	const cached = commonDirectories.get(key);
	if (cached !== undefined && fs.existsSync(cached)) return cached;
	const commonDir = path.resolve(repo, gitChecked(repo, ["rev-parse", "--git-common-dir"]).trim());
	commonDirectories.set(key, commonDir);
	return commonDir;
}

function checkoutBlocker(gitDir: string, ownedAdd: boolean): string | null | undefined {
	const indexLock = path.join(gitDir, "index.lock");
	if (fs.existsSync(indexLock)) return indexLock;
	if (/^(?:0{40}|0{64})$/.test(fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim())) return null;
	if (!fs.existsSync(path.join(gitDir, "index"))) {
		if (ownedAdd) return null;
		try {
			if (fs.readFileSync(path.join(gitDir, "locked"), "utf8").trim() === "initializing") return null;
		} catch {}
	}
	return undefined;
}

function targetCheckoutBlocker(commonDir: string, worktreePath: string, ownedAdd = false): string | null | undefined {
	const gitFile = path.join(worktreePath, ".git");
	if (comparablePath(gitFile) === comparablePath(commonDir)) return checkoutBlocker(commonDir, ownedAdd);
	try {
		const pointer = fs.readFileSync(gitFile, "utf8");
		if (!pointer.startsWith("gitdir:")) return undefined;
		const entry = path.resolve(worktreePath, pointer.slice("gitdir:".length).trim());
		if (comparablePath(path.dirname(entry)) !== comparablePath(path.join(commonDir, "worktrees"))) return undefined;
		const back = fs.readFileSync(path.join(entry, "gitdir"), "utf8").trim();
		if (comparablePath(path.resolve(entry, back)) !== comparablePath(gitFile)) return undefined;
		return checkoutBlocker(entry, ownedAdd);
	} catch {
		return undefined;
	}
}

function parseCoreSharedRepository(configText: string): string | undefined {
	let inCore = false;
	let value: string | undefined;
	for (const rawLine of configText.split(/\r?\n/)) {
		const line = rawLine.replace(/^\s+/, "");
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const section = line.match(/^\[([^\]]+)\]/);
		if (section) {
			inCore = section[1]!.trim().toLowerCase() === "core";
			continue;
		}
		if (!inCore) continue;
		const match = line.match(/^sharedrepository(?:\s*=\s*(.*?))?\s*(?:[#;].*)?$/i);
		if (!match) continue;
		value = (match[1] ?? "true")
			.trim()
			.replace(/^"(.*)"$/, "$1")
			.toLowerCase();
	}
	return value;
}

function repositoryLockModes(commonDir: string): { dirMode: number; gid: number | undefined } {
	if (process.platform === "win32") return { dirMode: 0o700, gid: undefined };
	let gid: number | undefined;
	let hasSetgid = false;
	try {
		const commonStat = fs.statSync(commonDir);
		gid = commonStat.gid;
		hasSetgid = (commonStat.mode & 0o2000) !== 0;
	} catch {}
	try {
		const infoStat = fs.statSync(path.join(commonDir, "objects", "info"));
		gid ??= infoStat.gid;
		hasSetgid ||= (infoStat.mode & 0o2000) !== 0;
	} catch {}
	let configured: string | undefined;
	try {
		const configText = fs.readFileSync(path.join(commonDir, "config"), "utf8");
		if (
			!/\[\s*include(?:if)?\b/i.test(configText) &&
			!process.env.GIT_CONFIG_PARAMETERS &&
			!process.env.GIT_CONFIG_COUNT &&
			!process.env.GIT_CONFIG &&
			!process.env.GIT_CONFIG_GLOBAL
		) {
			configured = parseCoreSharedRepository(configText);
		}
	} catch {}
	if (configured === undefined) {
		const queried = runGit(commonDir, ["config", "--get", "core.sharedRepository"], {
			LC_ALL: "C",
			LANGUAGE: "C",
		});
		if (queried.status === 0) configured = queried.stdout.trim().toLowerCase();
	}
	if (
		configured === "false" ||
		configured === "no" ||
		configured === "off" ||
		configured === "0" ||
		configured === "umask"
	)
		return { dirMode: 0o700, gid: undefined };
	if (
		configured === "true" ||
		configured === "yes" ||
		configured === "on" ||
		configured === "1" ||
		configured === "group"
	)
		return { dirMode: 0o2770, gid };
	if (configured === "all" || configured === "world" || configured === "everybody" || configured === "2")
		return { dirMode: 0o2775, gid };
	if (configured && /^[0-7]{3,4}$/.test(configured)) {
		const mask = Number.parseInt(configured, 8) & 0o777;
		if ((mask & 0o020) !== 0) {
			const otherBits = (mask & 0o006) === 0o006 ? 0o007 : (mask & 0o004) !== 0 ? 0o005 : 0;
			return { dirMode: 0o2770 | otherBits, gid };
		}
		return { dirMode: 0o700, gid: undefined };
	}
	return hasSetgid ? { dirMode: 0o2770, gid } : { dirMode: 0o700, gid: undefined };
}

function isReadonlyLocationError(error: unknown): boolean {
	const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
	return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

function validateFallbackLockDirectory(targetDir: string, gid: number | undefined): void {
	const stat = fs.lstatSync(targetDir);
	if (!stat.isDirectory()) throw new Error(`${targetDir}: lock directory is not a directory`);
	if (process.platform === "win32") return;
	if ((stat.mode & 0o002) !== 0) throw new Error(`${targetDir}: lock directory must not be world-writable`);
	const euid = process.geteuid?.();
	const ownedByCurrent = euid === undefined || stat.uid === euid;
	const sharedWithGroup = gid !== undefined && stat.gid === gid && (stat.mode & 0o060) === 0o060;
	if (!ownedByCurrent && !sharedWithGroup) throw new Error(`${targetDir}: lock directory is owned by another user`);
}

function createLockDirectory(targetDir: string, dirMode: number, gid: number | undefined): void {
	if (fs.existsSync(targetDir)) return;
	const parentDir = path.dirname(targetDir);
	if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true, mode: dirMode });
	if (fs.existsSync(targetDir)) return;
	const temporary = fs.mkdtempSync(`${targetDir}-`);
	try {
		if (process.platform !== "win32") {
			if (gid !== undefined) {
				try {
					fs.chownSync(temporary, -1, gid);
				} catch {}
			}
			try {
				fs.chmodSync(temporary, dirMode);
			} catch {
				fs.chmodSync(temporary, dirMode & 0o777);
			}
		}
		if (!renameNoReplace(temporary, targetDir) && !fs.existsSync(targetDir)) {
			try {
				fs.renameSync(temporary, targetDir);
			} catch (error) {
				if (!fs.existsSync(targetDir)) throw error;
			}
		}
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

function resolveLockDirectory(commonDir: string): string {
	const canonicalCommon = comparablePath(commonDir);
	const primary = path.join(canonicalCommon, "objects", "info", "atomic-named-worktree-locks");
	if (fs.existsSync(primary)) return primary;
	const fallback = path.join(
		os.tmpdir(),
		`atomic-named-worktree-locks-${createHash("sha256").update(canonicalCommon).digest("hex")}`,
	);
	const { dirMode, gid } = repositoryLockModes(canonicalCommon);
	if (fs.existsSync(fallback)) {
		validateFallbackLockDirectory(fallback, gid);
		return fallback;
	}
	try {
		createLockDirectory(primary, dirMode, gid);
		return primary;
	} catch (error) {
		if (fs.existsSync(primary)) return primary;
		if (!isReadonlyLocationError(error)) throw error;
		createLockDirectory(fallback, dirMode, gid);
		validateFallbackLockDirectory(fallback, gid);
		return fallback;
	}
}

function lockPaths(commonDir: string, branch: string, worktreePath: string): string[] {
	const lockDir = resolveLockDirectory(commonDir);
	const key = (kind: string, value: string): string =>
		path.join(lockDir, `${kind}-${createHash("sha256").update(value).digest("hex")}.lock`);
	return [
		key("path", comparablePath(worktreePath)),
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

function lockFileMode(lockDir: string): number {
	if (process.platform === "win32") return 0o600;
	try {
		const mode = fs.statSync(lockDir).mode;
		if ((mode & 0o060) === 0o060) {
			const otherBits = (mode & 0o006) === 0o006 ? 0o006 : (mode & 0o004) !== 0 ? 0o004 : 0;
			return 0o660 | otherBits;
		}
	} catch {}
	return 0o600;
}

function acquireTargetLock(lockPath: string, fileMode: number): ReturnType<typeof tryAdvisoryLock> {
	try {
		if (process.platform !== "win32" && fileMode !== 0o600 && !fs.existsSync(lockPath)) {
			try {
				const fd = fs.openSync(
					lockPath,
					fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
					fileMode,
				);
				try {
					fs.fchmodSync(fd, fileMode);
				} finally {
					fs.closeSync(fd);
				}
			} catch (error) {
				const code =
					error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
				if (code !== "EEXIST") throw error;
			}
		}
		return tryAdvisoryLock(lockPath, 0);
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
	const targetSet = new Set(paths.map(comparablePath));
	if (inherited.some((lockPath) => targetSet.has(comparablePath(lockPath))))
		throw new WorktreeReentryError(worktreePath);
	const fileMode = lockFileMode(path.dirname(paths[0]!));
	const held: NonNullable<ReturnType<typeof tryAdvisoryLock>>[] = [];
	try {
		for (;;) {
			options.signal?.throwIfAborted();
			for (const lockPath of paths) {
				const lock = acquireTargetLock(lockPath, fileMode);
				if (lock === null) {
					for (const acquired of held.splice(0).reverse()) acquired.release();
					break;
				}
				held.push(lock);
			}
			if (held.length === paths.length) break;
			notifyWaiting();
			await sleep(CONCURRENT_ADD_POLL_MS, options.signal);
		}
		options.signal?.throwIfAborted();
		return await create({ [INHERITED_LOCKS_ENV]: JSON.stringify([...inherited, ...paths]) });
	} finally {
		for (const lock of held.splice(0).reverse()) lock.release();
	}
}

function listWorktrees(repo: string): ListedWorktree[] {
	const listed: ListedWorktree[] = [];
	for (const block of gitChecked(repo, ["worktree", "list", "--porcelain"]).split(/\r?\n\r?\n/)) {
		const lines = block.split(/\r?\n/);
		const worktreePath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
		if (!worktreePath) continue;
		const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
		listed.push({ path: worktreePath, ...(branch ? { branch } : {}) });
	}
	return listed;
}

function defaultBase(cwd: string): string {
	const upstream = runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	return upstream.status === 0 ? upstream.stdout.trim() : "HEAD";
}

function isEmptyDirectory(target: string): boolean {
	return fs.statSync(target).isDirectory() && fs.readdirSync(target).length === 0;
}

function withAgentCwd(worktreePath: string, cwdRelative: string): string {
	const nested = path.join(worktreePath, cwdRelative);
	return fs.existsSync(nested) ? nested : worktreePath;
}

export async function ensureNamedWorktree(
	cwd: string,
	request: NamedWorktreeRequest,
	options: NamedWorktreeOptions = {},
): Promise<NamedWorktree> {
	options.signal?.throwIfAborted();
	const branch = request.branch;
	const formatted = runGit(cwd, ["check-ref-format", "--branch", branch]);
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
	const { cwdRelative, repo, commonDir } = await retried(`could not find the repository of ${cwd}`, () => {
		const toplevel = path.resolve(gitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim());
		const cwdRelative = path.relative(fs.realpathSync(toplevel), fs.realpathSync(cwd));
		const repo = findCanonicalGitRoot(toplevel);
		if (repo === undefined) throw new Error(`unable to resolve canonical main Git repository root from ${toplevel}`);
		const commonDir = commonGitDirectory(repo);
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
		const targetLocks = lockPaths(commonDir, branch, worktreePath);
		const addingMarker = `${targetLocks[0]}.adding`;
		return await withTargetLocks(targetLocks, worktreePath, options, notifyWaiting, async (env) => {
			deadline = performance.now() + CONCURRENT_ADD_WAIT_MS;
			const ready = async (): Promise<NamedWorktree> => ({
				repo,
				path: worktreePath,
				agentCwd: withAgentCwd(worktreePath, cwdRelative),
				branch,
				baseCommit: await retried(checkingOut, () =>
					gitChecked(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]).trim(),
				),
			});
			let addFailure: { message: string; diagnostic: string; branchExisted: boolean } | undefined;
			let baseCommit: string | undefined;
			for (;;) {
				options.signal?.throwIfAborted();
				if (fs.existsSync(addingMarker)) {
					const incomplete = targetCheckoutBlocker(commonDir, worktreePath, true);
					if (incomplete !== undefined) throw new WorktreeBusyError(worktreePath, incomplete, true);
					fs.rmSync(addingMarker, { force: true });
				}
				let decision = await retried(checkingOut, () => decideWorktree(repo, commonDir, branch, worktreePath));
				if (decision.kind === "wait" && !waiting())
					decision = await retried(checkingOut, () => decideWorktree(repo, commonDir, branch, worktreePath));
				if (decision.kind === "wait") {
					if (!waiting()) throw new WorktreeBusyError(worktreePath, decision.indexLock);
					notifyWaiting();
					await sleep(CONCURRENT_ADD_POLL_MS, options.signal);
					continue;
				}
				if (decision.kind === "reuse") return ready();
				const branchExists = runGit(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
				if (
					addFailure !== undefined &&
					(!waiting() ||
						(!CONCURRENT_GIT_FAILURE.test(addFailure.diagnostic) &&
							(branchExists === addFailure.branchExisted ||
								!CONCURRENT_ADD_FAILURE.test(addFailure.diagnostic))))
				)
					throw failed(checkingOut, new GitFailure(addFailure.message));
				if (!branchExists && baseCommit === undefined) {
					const base = request.base ?? defaultBase(cwd);
					baseCommit = await retried(`${checkingOut}: invalid reference: ${base}`, () =>
						gitChecked(repo, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).trim(),
					);
				}
				if (defaultPath) await retried(checkingOut, () => ensureWorktreeIgnore(repo));
				fs.writeFileSync(addingMarker, "", { mode: 0o600 });
				let added: Awaited<ReturnType<typeof addNamedWorktree>>;
				try {
					added = await addNamedWorktree(
						repo,
						branchExists
							? ["worktree", "add", worktreePath, branch]
							: ["worktree", "add", "--no-track", "-b", branch, worktreePath, baseCommit!],
						env,
						options.signal,
					);
				} finally {
					if (targetCheckoutBlocker(commonDir, worktreePath, true) === undefined)
						fs.rmSync(addingMarker, { force: true });
				}
				if (added.status === 0) {
					fs.rmSync(addingMarker, { force: true });
					return ready();
				}
				const message = added.stderr.trim() || added.stdout.trim() || "git worktree add failed";
				const diagnostic = [worktreePath, repo].reduce(
					(text, operand) => text.replaceAll(operand.replaceAll("\\", "/"), "<path>"),
					message.replaceAll("\\", "/"),
				);
				addFailure = { message, diagnostic, branchExisted: branchExists };
				if (CONCURRENT_GIT_FAILURE.test(diagnostic) || CONCURRENT_ADD_FAILURE.test(diagnostic))
					await sleep(CONCURRENT_ADD_POLL_MS, options.signal);
			}
		});
	} catch (error) {
		throw failed(checkingOut, error);
	} finally {
		if (showedWaiting) options.onWaiting?.(undefined);
	}
}

type WorktreeDecision = { kind: "reuse" | "create" } | { kind: "wait"; indexLock: string | null };

function decideWorktree(repo: string, commonDir: string, branch: string, worktreePath: string): WorktreeDecision {
	const before = targetCheckoutBlocker(commonDir, worktreePath);
	if (before !== undefined) return { kind: "wait", indexLock: before };
	const target = comparablePath(worktreePath);
	const worktrees = listWorktrees(repo);
	const after = targetCheckoutBlocker(commonDir, worktreePath);
	if (after !== undefined) return { kind: "wait", indexLock: after };
	const atPath = worktrees.find((worktree) => comparablePath(worktree.path) === target);
	if (atPath?.branch === branch) return { kind: "reuse" };
	const elsewhere = worktrees.find((worktree) => worktree.branch === branch);
	if (elsewhere)
		throw new Error(
			`worktree: branch "${branch}" is already checked out at ${path.resolve(elsewhere.path)}, so it cannot be checked out at ${worktreePath}. Pass that path as worktree.path to reuse it, or name another branch.`,
		);
	if (atPath || (fs.existsSync(worktreePath) && !isEmptyDirectory(worktreePath)))
		throw new Error(
			`worktree: ${worktreePath} already exists and is not the worktree of branch "${branch}". Choose another worktree.path or branch.`,
		);
	return { kind: "create" };
}
