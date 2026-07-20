import * as fs from "node:fs";
import * as path from "node:path";
import { APP_NAME } from "@bastani/atomic";

export function flattenWorktreeSlug(value: string): string {
	return value.replaceAll("/", "+");
}

export function buildWorktreeName(runId: string, index: number): string {
	return flattenWorktreeSlug(`${APP_NAME}-worktree-${runId}-${index}`);
}

export function buildWorktreeBranch(runId: string, index: number): string {
	return `worktree-${buildWorktreeName(runId, index)}`;
}

export function buildWorktreePath(mainRoot: string, runId: string, index: number): string {
	return path.join(mainRoot, ".atomic", "worktrees", buildWorktreeName(runId, index));
}

export function ensureWorktreeDirectory(mainRoot: string): void {
	const worktreesDir = path.join(mainRoot, ".atomic", "worktrees");
	const ignorePath = path.join(worktreesDir, ".gitignore");
	fs.mkdirSync(worktreesDir, { recursive: true });
	let contents = "";
	try { contents = fs.readFileSync(ignorePath, "utf-8"); } catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as { readonly code?: string }).code : undefined;
		if (code !== "ENOENT") throw error;
	}
	if (!contents.split(/\r?\n/).includes("*")) fs.appendFileSync(ignorePath, `${contents && !contents.endsWith("\n") ? "\n" : ""}*\n`);
}
