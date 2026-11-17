import type { Dirent, Stats } from "node:fs";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rmdir, stat, writeFile } from "node:fs/promises";
import {
	GIT_READ_ONLY_PROBE_TIMEOUT_ATTEMPTS,
	isGitTimeoutResult,
	rawGit,
	rawGitSync,
	withDiagnostics,
} from "./worktree-git-runner.js";
import type { GitResult } from "./worktree-types.js";

interface WorktreeIo {
	git(cwd: string, args: readonly string[]): GitResult;
	stat(path: string): Stats;
	lstat(path: string): Stats;
	realpath(path: string): string;
	readdir(path: string): string[];
	readdirEntries(path: string): Dirent[];
	readFile(path: string): string;
	mkdir(path: string, recursive: boolean): void;
	rmdir(path: string): void;
	writeNewFile(path: string, data: string): void;
}

type WorktreeIoOp = keyof WorktreeIo;
type WorktreeIoRequest = {
	[Op in WorktreeIoOp]: { readonly op: Op; readonly args: Parameters<WorktreeIo[Op]> };
}[WorktreeIoOp];
type WorktreeIoResult = ReturnType<WorktreeIo[WorktreeIoOp]>;
type AsyncWorktreeIo = {
	readonly [Op in WorktreeIoOp]: (...args: Parameters<WorktreeIo[Op]>) => Promise<ReturnType<WorktreeIo[Op]>>;
};

export type WorktreeSteps<T> = Generator<WorktreeIoRequest, T, WorktreeIoResult>;

const syncIo: WorktreeIo = {
	git: (cwd, args) => rawGitSync(cwd, args),
	stat: (path) => statSync(path),
	lstat: (path) => lstatSync(path),
	realpath: (path) => realpathSync.native(path),
	readdir: (path) => readdirSync(path),
	readdirEntries: (path) => readdirSync(path, { withFileTypes: true }),
	readFile: (path) => readFileSync(path, "utf8"),
	mkdir: (path, recursive) => {
		mkdirSync(path, { recursive });
	},
	rmdir: (path) => rmdirSync(path),
	writeNewFile: (path, data) => writeFileSync(path, data, { encoding: "utf8", flag: "wx" }),
};

const asyncIo: AsyncWorktreeIo = {
	git: (cwd, args) => rawGit(cwd, args),
	stat: (path) => stat(path),
	lstat: (path) => lstat(path),
	realpath: (path) => realpath(path),
	readdir: (path) => readdir(path),
	readdirEntries: (path) => readdir(path, { withFileTypes: true }),
	readFile: (path) => readFile(path, "utf8"),
	mkdir: async (path, recursive) => {
		await mkdir(path, { recursive });
	},
	rmdir: (path) => rmdir(path),
	writeNewFile: (path, data) => writeFile(path, data, { encoding: "utf8", flag: "wx" }),
};

export function* io<Op extends WorktreeIoOp>(
	op: Op,
	...args: Parameters<WorktreeIo[Op]>
): WorktreeSteps<ReturnType<WorktreeIo[Op]>> {
	return (yield { op, args } as WorktreeIoRequest) as ReturnType<WorktreeIo[Op]>;
}

export function runWorktreeStepsSync<T>(steps: WorktreeSteps<T>): T {
	let next = steps.next();
	while (!next.done) {
		const request = next.value;
		const operation = syncIo[request.op] as (...args: WorktreeIoRequest["args"]) => WorktreeIoResult;
		let result: WorktreeIoResult;
		try {
			result = operation(...request.args);
		} catch (error) {
			next = steps.throw(error);
			continue;
		}
		next = steps.next(result);
	}
	return next.value;
}

export async function runWorktreeSteps<T>(steps: WorktreeSteps<T>): Promise<T> {
	let next = steps.next();
	while (!next.done) {
		const request = next.value;
		const operation = asyncIo[request.op] as (...args: WorktreeIoRequest["args"]) => Promise<WorktreeIoResult>;
		let result: WorktreeIoResult;
		try {
			result = await operation(...request.args);
		} catch (error) {
			next = steps.throw(error);
			continue;
		}
		next = steps.next(result);
	}
	return next.value;
}

export function* gitSteps(cwd: string, args: readonly string[]): WorktreeSteps<GitResult> {
	return withDiagnostics(yield* io("git", cwd, args), cwd, args);
}

export function* gitReadOnlyProbeSteps(cwd: string, args: readonly string[]): WorktreeSteps<GitResult> {
	let attempts = 1;
	let result = yield* gitSteps(cwd, args);
	while (attempts < GIT_READ_ONLY_PROBE_TIMEOUT_ATTEMPTS && result.status !== 0 && isGitTimeoutResult(result)) {
		attempts += 1;
		result = yield* gitSteps(cwd, args);
	}
	return attempts > 1 ? { ...result, attempts } : result;
}
