import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { formatSize } from "./truncate.ts";

export interface DirectoryTreeResult {
	rendered: string;
	truncated: boolean;
	totalLines: number;
}

interface TreeNode {
	name: string;
	path: string;
	isDir: boolean;
	mtimeMs: number;
	size: number;
	depth: number;
	children: TreeNode[];
	droppedCount: number;
}

interface DirectoryTreeOptions {
	maxDepth?: number;
	perDirLimit?: number | null;
	rootLimit?: number | null;
}

function formatAge(ageSeconds: number): string {
	if (ageSeconds < 60) return `${ageSeconds}s`;
	const minutes = Math.floor(ageSeconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo`;
	return `${Math.floor(months / 12)}y`;
}

function shouldSkipDirectory(name: string): boolean { return name === ".git" || name === "node_modules"; }

function byRecency(a: TreeNode, b: TreeNode): number {
	return b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name);
}

async function buildNode(fullPath: string, name: string, depth: number, maxDepth: number): Promise<TreeNode | undefined> {
	const info = await stat(fullPath).catch(() => undefined);
	if (!info) return undefined;
	const node: TreeNode = { name, path: fullPath, isDir: info.isDirectory(), mtimeMs: info.mtimeMs, size: info.size, depth, children: [], droppedCount: 0 };
	if (!node.isDir || depth >= maxDepth) return node;
	const entries = (await readdir(fullPath, { withFileTypes: true }).catch(() => [])).filter((entry) => !entry.isDirectory() || !shouldSkipDirectory(entry.name));
	const children = await Promise.all(entries.map((entry) => buildNode(resolve(fullPath, entry.name), entry.name, depth + 1, maxDepth)));
	node.children = children.filter((child): child is TreeNode => child !== undefined).sort(byRecency);
	return node;
}

function applyChildLimit(node: TreeNode, perDirLimit: number | null, rootLimit: number | null): boolean {
	let truncated = false;
	const limit = node.depth === 0 ? rootLimit : perDirLimit;
	if (limit !== null && node.children.length > limit) {
		const originalCount = node.children.length;
		node.children = limit <= 1 ? node.children.slice(0, Math.max(0, limit)) : [...node.children.slice(0, limit - 1), node.children.at(-1)!];
		node.droppedCount = originalCount - node.children.length;
		truncated = true;
	}
	for (const child of node.children) if (child.isDir) truncated = applyChildLimit(child, perDirLimit, rootLimit) || truncated;
	return truncated;
}

function renderNode(node: TreeNode, now: number, out: string[]): void {
	if (node.depth === 0) out.push(".");
	else {
		const indent = "  ".repeat(node.depth);
		const suffix = node.isDir ? "/" : "";
		const meta = node.isDir ? "" : `  ${formatSize(node.size).padEnd(8)}  ${formatAge(Math.max(0, Math.floor((now - node.mtimeMs) / 1000)))}`;
		out.push(`${indent}- ${node.name}${suffix}${meta}`.trimEnd());
	}
	if (node.droppedCount === 0) {
		for (const child of node.children) renderNode(child, now, out);
		return;
	}
	const recent = node.children.slice(0, -1), oldest = node.children.at(-1);
	for (const child of recent) renderNode(child, now, out);
	out.push(`${"  ".repeat(node.depth + 1)}- … ${node.droppedCount} more`);
	if (oldest) renderNode(oldest, now, out);
}

export async function buildDirectoryTree(rootPath: string, options: DirectoryTreeOptions = {}): Promise<DirectoryTreeResult> {
	const root = await buildNode(rootPath, ".", 0, options.maxDepth ?? 2);
	if (!root || root.children.length === 0) return { rendered: "(empty directory)", truncated: false, totalLines: 1 };
	const truncated = applyChildLimit(root, options.perDirLimit ?? 12, options.rootLimit === undefined ? null : options.rootLimit);
	const lines: string[] = [];
	renderNode(root, Date.now(), lines);
	return { rendered: lines.join("\n"), truncated, totalLines: lines.length };
}
