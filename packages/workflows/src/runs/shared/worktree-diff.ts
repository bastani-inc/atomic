import * as fs from "node:fs";
import * as path from "node:path";
import { runGitChecked } from "./worktree-git.js";
import type { WorktreeDiff, WorktreeInfo, WorktreeSetup } from "./worktree-types.js";

function safePatchAgentName(agent: string): string {
	return agent.replace(/[^\w.-]/g, "_");
}

function removeSyntheticPath(worktree: WorktreeInfo, syntheticPath: string): void {
	const resolved = path.resolve(worktree.path, syntheticPath);
	const relative = path.relative(worktree.path, resolved);
	if (
		!relative ||
		relative === "." ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		return;
	}

	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(resolved);
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return;
		throw error;
	}

	if (stat.isSymbolicLink()) {
		fs.unlinkSync(resolved);
		return;
	}
	if (stat.isDirectory()) {
		fs.rmSync(resolved, { recursive: true, force: true });
		return;
	}
	fs.rmSync(resolved, { force: true });
}

function removeSyntheticPathsBeforeDiff(worktree: WorktreeInfo): void {
	if (worktree.syntheticPaths.length === 0) return;
	const seen = new Set<string>();
	for (const syntheticPath of worktree.syntheticPaths) {
		if (seen.has(syntheticPath)) continue;
		seen.add(syntheticPath);
		removeSyntheticPath(worktree, syntheticPath);
	}
}

function emptyDiff(index: number, agent: string, worktree: WorktreeInfo, patchPath: string): WorktreeDiff {
	return {
		index,
		agent,
		branch: worktree.branch,
		diffStat: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		patchPath,
		worktreePath: worktree.path,
		...(worktree.setupWarnings?.length ? { setupWarnings: [...worktree.setupWarnings] } : {}),
	};
}

function parseNumstat(numstat: string): { filesChanged: number; insertions: number; deletions: number } {
	const lines = numstat
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;

	for (const line of lines) {
		const [rawInsertions, rawDeletions] = line.split("\t");
		if (rawInsertions === undefined || rawDeletions === undefined) continue;
		filesChanged++;
		if (/^\d+$/.test(rawInsertions)) insertions += parseInt(rawInsertions, 10);
		if (/^\d+$/.test(rawDeletions)) deletions += parseInt(rawDeletions, 10);
	}

	return { filesChanged, insertions, deletions };
}

function captureWorktreeDiff(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	index: number,
	agent: string,
	patchPath: string,
): WorktreeDiff {
	removeSyntheticPathsBeforeDiff(worktree);
	runGitChecked(worktree.path, ["add", "-A"]);
	const diffStat = runGitChecked(worktree.path, ["diff", "--cached", "--stat", setup.baseCommit]).trim();
	const numstat = runGitChecked(worktree.path, ["diff", "--cached", "--numstat", setup.baseCommit]);
	writePatchFile(patchPath, (partialPath) =>
		runGitChecked(worktree.path, ["diff", "--cached", "--binary", `--output=${partialPath}`, setup.baseCommit]),
	);

	const parsed = parseNumstat(numstat);
	return {
		index,
		agent,
		branch: worktree.branch,
		diffStat,
		filesChanged: parsed.filesChanged,
		insertions: parsed.insertions,
		deletions: parsed.deletions,
		patchPath,
		worktreePath: worktree.path,
		...(worktree.setupWarnings?.length ? { setupWarnings: [...worktree.setupWarnings] } : {}),
	};
}

/**
 * Have git write the patch to a file of its own, so no output buffer caps it, and put it at `patchPath` only once it
 * is complete: a failed capture never leaves a partial patch there.
 */
function writePatchFile(patchPath: string, write: (partialPath: string) => void): void {
	const partialPath = `${patchPath}.${process.pid}.partial`;
	try {
		write(partialPath);
		fs.renameSync(partialPath, patchPath);
	} finally {
		fs.rmSync(partialPath, { force: true });
	}
}

/** Worktrees whose last diff capture failed: they hold work no patch has, so they are never removed (#4876). */
const uncapturedWorktrees = new Set<string>();

/** Whether the worktree's last diff capture failed, so removing it would lose its work. */
export function worktreeDiffCaptureFailed(worktreePath: string): boolean {
	return uncapturedWorktrees.has(worktreePath);
}

function hasWorktreeChanges(diff: WorktreeDiff): boolean {
	return diff.filesChanged > 0 || diff.insertions > 0 || diff.deletions > 0 || diff.diffStat.trim().length > 0;
}

export function diffWorktrees(setup: WorktreeSetup, agents: string[], diffsDir: string): WorktreeDiff[] {
	const diffs: WorktreeDiff[] = [];
	for (let index = 0; index < setup.worktrees.length; index++) {
		const worktree = setup.worktrees[index]!;
		const agent = agents[index] ?? `task-${index + 1}`;
		const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
		try {
			fs.mkdirSync(diffsDir, { recursive: true });
			diffs.push(captureWorktreeDiff(setup, worktree, index, agent, patchPath));
			uncapturedWorktrees.delete(worktree.path);
		} catch (error) {
			// Execution goes on, but the worktree is kept: its work is in no patch.
			uncapturedWorktrees.add(worktree.path);
			const captureError = error instanceof Error ? error.message : String(error);
			diffs.push({ ...emptyDiff(index, agent, worktree, patchPath), captureError });
		}
	}

	return diffs;
}

/** A worktree's setup warnings, one line each, naming its task. */
function setupWarningLines(diffs: WorktreeDiff[]): string[] {
	return diffs.flatMap((diff) =>
		(diff.setupWarnings ?? []).map((warning) => `Warning: Task ${diff.index + 1} (${diff.agent}): ${warning}`),
	);
}

export function formatWorktreeDiffSummary(diffs: WorktreeDiff[]): string {
	const changed = diffs.filter((diff) => diff.captureError !== undefined || hasWorktreeChanges(diff));
	const warnings = setupWarningLines(diffs);
	if (changed.length === 0 && warnings.length === 0) return "";

	const lines: string[] = ["=== Worktree Changes ===", ""];
	for (const diff of changed) {
		if (diff.captureError !== undefined) {
			lines.push(
				`--- Task ${diff.index + 1} (${diff.agent}): diff capture failed; worktree kept at ${diff.worktreePath} ---`,
				diff.captureError,
				"",
			);
			continue;
		}
		lines.push(
			`--- Task ${diff.index + 1} (${diff.agent}): ${diff.filesChanged} files changed, +${diff.insertions} -${diff.deletions} ---`,
		);
		if (diff.diffStat.trim().length > 0) {
			lines.push(diff.diffStat);
		}
		lines.push("");
	}

	if (changed.length > 0) lines.push(`Full patches: ${path.dirname(changed[0]!.patchPath)}`, "");
	lines.push(...warnings);
	return lines.join("\n").trimEnd();
}
