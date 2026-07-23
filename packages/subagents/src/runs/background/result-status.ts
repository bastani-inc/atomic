import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR } from "../../shared/types.js";
import { NESTED_RUNS_DIR } from "../shared/nested-events.js";
import type { ResultFileData } from "./result-watcher-data.js";

const TERMINAL_ASYNC_STATES = new Set(["complete", "failed", "paused"]);
export const DEFAULT_MAX_STATUS_BYTES = 1024 * 1024;

export interface ResultStatusFs {
	realpathSync: typeof fs.realpathSync;
	lstatSync: typeof fs.lstatSync;
	openSync: typeof fs.openSync;
	fstatSync: typeof fs.fstatSync;
	readSync: typeof fs.readSync;
	closeSync: typeof fs.closeSync;
}

export interface ResultStatusOptions {
	allowedRoots?: string[];
	maxBytes?: number;
}

function contained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalRoots(fsApi: ResultStatusFs, roots: string[]): string[] {
	const resolved: string[] = [];
	for (const root of roots) {
		try { resolved.push(fsApi.realpathSync(root)); } catch { /* unavailable roots cannot authorize a status path */ }
	}
	return resolved;
}

function readBoundedRegularFile(statusPath: string, fsApi: ResultStatusFs, maxBytes: number): string | undefined {
	const linkStat = fsApi.lstatSync(statusPath);
	if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.size > maxBytes) return undefined;
	const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
	const handle = fsApi.openSync(statusPath, fs.constants.O_RDONLY | noFollow);
	try {
		const stat = fsApi.fstatSync(handle);
		if (!stat.isFile() || stat.size > maxBytes) return undefined;
		const buffer = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < buffer.length) {
			const count = fsApi.readSync(handle, buffer, offset, buffer.length - offset, offset);
			if (count === 0) break;
			offset += count;
		}
		return buffer.subarray(0, offset).toString("utf-8");
	} finally {
		fsApi.closeSync(handle);
	}
}

export function modernResultHasTerminalStatus(
	data: ResultFileData,
	fsApi: ResultStatusFs = fs,
	options: ResultStatusOptions = {},
): boolean {
	if (!Object.prototype.hasOwnProperty.call(data, "asyncDir")) return true;
	const asyncDir = data.asyncDir?.trim();
	const resultRunId = data.runId?.trim() || data.id?.trim();
	if (!asyncDir || !resultRunId) return false;
	try {
		const canonicalAsyncDir = fsApi.realpathSync(asyncDir);
		const roots = canonicalRoots(fsApi, options.allowedRoots ?? [ASYNC_DIR, NESTED_RUNS_DIR]);
		if (!roots.some((root) => contained(root, canonicalAsyncDir))) return false;
		const statusPath = path.join(canonicalAsyncDir, "status.json");
		const content = readBoundedRegularFile(statusPath, fsApi, options.maxBytes ?? DEFAULT_MAX_STATUS_BYTES);
		if (content === undefined) return false;
		const status = JSON.parse(content) as { state?: string; runId?: string };
		return status.runId?.trim() === resultRunId
			&& typeof status.state === "string"
			&& TERMINAL_ASYNC_STATES.has(status.state);
	} catch {
		return false;
	}
}
