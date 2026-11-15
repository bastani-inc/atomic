import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ResumeTimings } from "../timings.ts";

/** What a settled blueprint build leaves: what the agent is told, and what the user is told. */
export interface BlueprintBuildResult {
	/** Told the agent with the result of the first tool call that waited for the build. */
	readonly report?: string;
	/**
	 * Told the user once, through {@link onBlueprintBuildFinished}: the same warnings a resume shows when it waits for
	 * the build. Undefined for a build the user hears of elsewhere, such as another process's.
	 */
	readonly notices?: readonly BlueprintBuildNotice[];
}

export interface BlueprintBuildNotice {
	readonly type: "info" | "warning";
	readonly message: string;
}

/** A build that ran behind a resumed session's first turn and has ended, as `onBlueprintBuildFinished` tells it. */
export interface BlueprintBuildFinished {
	readonly type: "blueprint_build_finished";
	/** The session whose resume started the build. */
	readonly sessionId: string;
	/** The restored worktrees it built. */
	readonly roots: readonly string[];
	/** The warnings it earned; empty when it finished cleanly. */
	readonly notices: readonly BlueprintBuildNotice[];
}

/** A resume that waits for another blueprint build of a worktree before it builds it, as `onBlueprintBuildWaiting` tells it. */
export interface BlueprintBuildWaiting {
	readonly type: "blueprint_build_waiting";
	/** The worktree whose earlier build is waited for. */
	readonly root: string;
	readonly message: string;
}

/**
 * Who waits for a build: a session by its id, and the directories it works in (its cwd and the worktrees its restores
 * put its checkouts in). A session id alone names only the session whose resume started the build.
 */
export type BlueprintBuildSubject = string | { readonly sessionId: string; readonly roots: readonly string[] };

interface PendingBuild {
	readonly sessionId: string;
	readonly roots: readonly string[];
	readonly settled: Promise<BlueprintBuildResult>;
	readonly stop?: (reason: Error) => void;
}

/** Builds whose report no tool call has taken yet; tool calls of the sessions they cover wait for them. */
const builds = new Set<PendingBuild>();
/** Builds this process started that have not settled yet, whether or not their report was taken. */
const running = new Set<PendingBuild>();
/** Finished builds no listener has been told of yet. */
const unannounced: BlueprintBuildFinished[] = [];
const listeners = new Set<(finished: BlueprintBuildFinished) => void>();

function inside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}

function covers(build: PendingBuild, subject: BlueprintBuildSubject): boolean {
	if (typeof subject === "string") return build.sessionId === subject;
	if (build.sessionId === subject.sessionId) return true;
	return build.roots.some((root) => subject.roots.some((path) => inside(root, resolve(path))));
}

function covering(subject: BlueprintBuildSubject): PendingBuild[] {
	return [...builds].filter((build) => covers(build, subject));
}

function announce(finished: BlueprintBuildFinished): void {
	if (listeners.size === 0) {
		unannounced.push(finished);
		return;
	}
	for (const listener of listeners) listener(finished);
}

/**
 * Holds the tool calls of session `sessionId`, and of every session of this process that works in one of `roots`, until
 * `build` settles. `build` resolves to what the agent is told about the build when its first held tool call runs (a
 * string is that report alone), and with `notices` to what the user is told once it settles. A rejection is a build
 * that ended without a report. A later build of the same session replaces this one. `stop` stops the build, for
 * {@link stopBlueprintBuilds}.
 */
export function holdToolsUntilBuilt(
	sessionId: string,
	build: Promise<string | undefined | BlueprintBuildResult>,
	options: { readonly roots?: Iterable<string>; readonly stop?: (reason: Error) => void } = {},
): void {
	for (const earlier of builds) if (earlier.sessionId === sessionId) builds.delete(earlier);
	const roots = [...(options.roots ?? [])].map((root) => resolve(root));
	const settled = build.then(
		(result): BlueprintBuildResult => (typeof result === "object" ? result : { report: result }),
		(): BlueprintBuildResult => ({}),
	);
	const entry: PendingBuild = { sessionId, roots, settled, stop: options.stop };
	builds.add(entry);
	running.add(entry);
	void settled.then((result) => {
		running.delete(entry);
		if (result.notices !== undefined) {
			announce({ type: "blueprint_build_finished", sessionId, roots, notices: result.notices });
		}
	});
}

/**
 * Tells `listener` of each blueprint build of this process that ran behind a resumed session's first turn once it ends,
 * and at once of those that ended before anyone listened; each build is told to the listeners of its time, once. A run
 * without a UI shows its warnings to the user this way, as a waiting resume shows them. Returns the unsubscribe.
 */
export function onBlueprintBuildFinished(listener: (finished: BlueprintBuildFinished) => void): () => void {
	listeners.add(listener);
	for (const finished of unannounced.splice(0)) listener(finished);
	return () => listeners.delete(listener);
}

const unannouncedWaits: BlueprintBuildWaiting[] = [];
const waitListeners = new Set<(waiting: BlueprintBuildWaiting) => void>();

/**
 * Tells the user, through the listeners of {@link onBlueprintBuildWaiting}, that a resume waits for another blueprint
 * build of the worktree at `root`: one still running in another process, or the leftovers of one whose process died.
 */
export function announceBlueprintBuildWaiting(root: string, message: string): void {
	const waiting: BlueprintBuildWaiting = { type: "blueprint_build_waiting", root, message };
	if (waitListeners.size === 0) unannouncedWaits.push(waiting);
	for (const listener of waitListeners) listener(waiting);
}

/**
 * Tells `listener` each time a resume of this process starts waiting for another blueprint build of a worktree, and at
 * once of those that started before anyone listened, each told once. Returns the unsubscribe.
 */
export function onBlueprintBuildWaiting(listener: (waiting: BlueprintBuildWaiting) => void): () => void {
	waitListeners.add(listener);
	for (const waiting of unannouncedWaits.splice(0)) listener(waiting);
	return () => waitListeners.delete(listener);
}

/** Whether tool calls of `subject` wait for a blueprint build, or the agent has not yet been told how it ended. */
export function blueprintBuildPending(subject: BlueprintBuildSubject): boolean {
	return covering(subject).length > 0;
}

function untilSettledOrAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return work;
	signal.throwIfAborted();
	return Promise.race([
		work,
		new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
	]);
}

/**
 * Resolves once the blueprint builds `subject` waits for have settled, whatever their status, and at once when it waits
 * for none. Their reports stay for the next tool call that waits. A user's shell command waits here, and so does a run
 * without a UI before it ends. `signal` aborting rejects the wait with its reason; the builds go on.
 */
export async function blueprintBuildSettled(subject: BlueprintBuildSubject, signal?: AbortSignal): Promise<void> {
	await untilSettledOrAborted(Promise.all(covering(subject).map((build) => build.settled)), signal);
}

/** Resolves once every blueprint build this process started has settled, including ones started while it waits. */
export async function blueprintBuildsSettled(): Promise<void> {
	while (running.size > 0) await Promise.all([...running].map((build) => build.settled));
}

/** Whether this process still runs a blueprint build behind a resumed session's first turn. */
export function blueprintBuildsRunning(): boolean {
	return running.size > 0;
}

/**
 * Stops every blueprint build this process still runs, with their steps' process trees, and resolves once they have
 * settled and recorded what ran. A build stopped this way is built again by the next resume.
 */
export async function stopBlueprintBuilds(reason = new Error("Atomic is exiting")): Promise<void> {
	for (const build of running) build.stop?.(reason);
	await blueprintBuildsSettled();
}

/**
 * Resolves once the blueprint builds `subject` waits for have settled, whatever their status, with what the agent is
 * told about them. Each report goes to the first caller only; later callers and a subject without a pending build get
 * undefined at once. `signal` aborting rejects the wait with its reason; the builds go on.
 */
export async function awaitBlueprintReady(
	subject: BlueprintBuildSubject,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const waiting = covering(subject);
	if (waiting.length === 0) return undefined;
	const results = await untilSettledOrAborted(Promise.all(waiting.map((build) => build.settled)), signal);
	const reports: string[] = [];
	waiting.forEach((build, index) => {
		if (!builds.delete(build)) return;
		const report = results[index]?.report;
		if (report !== undefined) reports.push(report);
	});
	return reports.length === 0 ? undefined : reports.join("\n");
}

interface SharedBuildState {
	readonly state: "building" | "settled";
	/** The restored worktrees the build sets up, whose sessions in the engine wait for it too. */
	readonly roots?: readonly string[];
	readonly report?: string;
	/** The resume's timings with the build's steps, for the process that writes the session to record. */
	readonly timings?: ResumeTimings;
}

/** How often a process that waits for another process's build looks at its state file. */
export const SHARED_BUILD_POLL_MS = 200;

/** The sessions whose build this process shared, with the timings the build left for the sharing process to record. */
const shared = new Map<string, { timings?: ResumeTimings }>();

function sharedBuildFile(storeDir: string, ownerPid: number, sessionId: string): string {
	const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
	return join(storeDir, "blueprint-builds", "pending", `${ownerPid}-${key}.json`);
}

async function writeState(file: string, state: SharedBuildState): Promise<void> {
	const temporary = `${file}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
	await rename(temporary, file);
}

/**
 * Lets the isolated interactive engine this process starts for session `sessionId` hold its tools for the build this
 * process runs: writes a state file under `storeDir` that {@link holdToolsUntilOwnerBuilt} reads, and updates it when
 * the build settles. Resolves once the file says the build is running; does nothing when no build is pending here. The
 * file is removed when this process exits, and when the settled state cannot be written, so the engine never waits for
 * a build that ended. Never rejects: an engine that finds no file runs its tools at once, as without the setting.
 */
export async function shareBlueprintBuild(storeDir: string, sessionId: string): Promise<void> {
	const build = [...builds].find((candidate) => candidate.sessionId === sessionId);
	if (build === undefined) return;
	const file = sharedBuildFile(storeDir, process.pid, sessionId);
	try {
		await mkdir(dirname(file), { recursive: true });
		await writeState(file, { state: "building", roots: build.roots });
	} catch {
		return;
	}
	const handOver: { timings?: ResumeTimings } = {};
	shared.set(sessionId, handOver);
	process.once("exit", () => {
		try {
			unlinkSync(file);
		} catch {}
	});
	void build.settled
		.then(({ report }) => writeState(file, { state: "settled", report, timings: handOver.timings }))
		.catch(() => rm(file, { force: true }))
		.catch(() => undefined);
}

/**
 * Whether this process shared the build of session `sessionId` with the engine that writes the session. Such a
 * process leaves the build's timings to the engine with {@link handOverBuildTimings}, since it must not write the
 * session the engine has open.
 */
export function blueprintBuildShared(sessionId: string): boolean {
	return shared.has(sessionId);
}

/** Gives the engine the timings of the shared build of session `sessionId`, with its settled state. */
export function handOverBuildTimings(sessionId: string, timings: ResumeTimings): void {
	const handOver = shared.get(sessionId);
	if (handOver !== undefined) handOver.timings = timings;
}

function ownerAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readState(file: string): SharedBuildState | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as SharedBuildState;
	} catch {
		return undefined;
	}
}

/**
 * Holds the tools of session `sessionId` in this process until the build that process `ownerPid` shared for it with
 * {@link shareBlueprintBuild} settles, and gives its report to the first held tool, also when it settled before this
 * process looked. Nothing is held when it shared none. A state file that disappears, cannot be read, or whose owner
 * exits releases the tools without a report. `recordTimings` is given the timings the owner handed over, before the
 * tools are released.
 */
export function holdToolsUntilOwnerBuilt(
	storeDir: string,
	ownerPid: number,
	sessionId: string,
	recordTimings?: (timings: ResumeTimings) => Promise<void>,
): void {
	const file = sharedBuildFile(storeDir, ownerPid, sessionId);
	const first = readState(file);
	if (first === undefined) return;
	const settled = (async (): Promise<string | undefined> => {
		for (;;) {
			const state = readState(file);
			if (state?.state !== "building") {
				await rm(file, { force: true });
				if (state?.state !== "settled") return undefined;
				if (state.timings !== undefined) await recordTimings?.(state.timings);
				return state.report;
			}
			if (!ownerAlive(ownerPid)) return undefined;
			await new Promise((resolve) => setTimeout(resolve, SHARED_BUILD_POLL_MS));
		}
	})();
	holdToolsUntilBuilt(sessionId, settled, { roots: first.roots });
}
