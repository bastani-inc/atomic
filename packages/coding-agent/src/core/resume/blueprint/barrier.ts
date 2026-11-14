import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Built-in tools that run project code or read the worktree, and so wait for a blueprint build that runs behind the
 * first turn (`resume.waitForBlueprint: "tools"`). An extension tool that declares `writesFiles` waits too.
 */
export const BLUEPRINT_GATED_TOOLS: ReadonlySet<string> = new Set([
	"bash",
	"powershell",
	"edit",
	"write",
	"read",
	"ls",
	"find",
	"grep",
	"search",
]);

/** A build the session's tools wait for: settles with what the agent is told once it ends. */
interface PendingBuild {
	readonly settled: Promise<string | undefined>;
}

const pending = new Map<string, PendingBuild>();

/**
 * Holds the tools of session `sessionId` in this process until `build` settles. `build` resolves to what the agent is
 * told about the build when its first held tool runs. A rejection is treated as a build that ended without a report.
 */
export function holdToolsUntilBuilt(sessionId: string, build: Promise<string | undefined>): void {
	pending.set(sessionId, { settled: build.catch(() => undefined) });
}

/** Whether tools of session `sessionId` wait for a blueprint build, or the agent has not yet been told how it ended. */
export function blueprintBuildPending(sessionId: string): boolean {
	return pending.has(sessionId);
}

/**
 * Resolves once the blueprint build the resume of session `sessionId` started has settled, whatever its status, with
 * what the agent is told about it. The report goes to the first caller only; later callers and a session without a
 * pending build get undefined at once. `signal` aborting rejects the wait with its reason; the build goes on.
 */
export async function awaitBlueprintReady(sessionId: string, signal?: AbortSignal): Promise<string | undefined> {
	const build = pending.get(sessionId);
	if (build === undefined) return undefined;
	signal?.throwIfAborted();
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	try {
		const report = await Promise.race([build.settled, aborted]);
		if (pending.get(sessionId) !== build) return undefined;
		pending.delete(sessionId);
		return report;
	} finally {
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
	}
}

interface SharedBuildState {
	readonly state: "building" | "settled";
	readonly report?: string;
}

/** How often a process that waits for another process's build looks at its state file. */
export const SHARED_BUILD_POLL_MS = 200;

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
 * file is removed when this process exits. Never rejects: an engine that finds no file runs its tools at once, as
 * without the setting.
 */
export async function shareBlueprintBuild(storeDir: string, sessionId: string): Promise<void> {
	const build = pending.get(sessionId);
	if (build === undefined) return;
	const file = sharedBuildFile(storeDir, process.pid, sessionId);
	try {
		await mkdir(dirname(file), { recursive: true });
		await writeState(file, { state: "building" });
	} catch {
		return;
	}
	process.once("exit", () => {
		try {
			unlinkSync(file);
		} catch {}
	});
	void build.settled.then((report) => writeState(file, { state: "settled", report })).catch(() => undefined);
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
 * {@link shareBlueprintBuild} settles. Nothing is held when it shared none. A state file that disappears, cannot be
 * read, or whose owner exits releases the tools without a report.
 */
export function holdToolsUntilOwnerBuilt(storeDir: string, ownerPid: number, sessionId: string): void {
	const file = sharedBuildFile(storeDir, ownerPid, sessionId);
	if (readState(file)?.state !== "building") return;
	const settled = (async (): Promise<string | undefined> => {
		for (;;) {
			const shared = readState(file);
			if (shared?.state !== "building") {
				await rm(file, { force: true });
				return shared?.state === "settled" ? shared.report : undefined;
			}
			if (!ownerAlive(ownerPid)) return undefined;
			await new Promise((resolve) => setTimeout(resolve, SHARED_BUILD_POLL_MS));
		}
	})();
	holdToolsUntilBuilt(sessionId, settled);
}
