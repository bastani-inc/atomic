import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import type { PathLike } from "node:fs";
import { constants } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";

/**
 * Faults injected where the snapshot code reads files or starts Git, so a failure that needs `chmod`, a symbolic link
 * or a shell script to set up on POSIX runs on every platform. Test files install them from their `vi.mock` factories;
 * this module imports neither `node:fs` nor `node:child_process`, so those factories can load it.
 */

/** A failure shaped like the ones Node raises: the snapshot code types filesystem errors by `code` and `syscall`. */
export function systemError(code: string, syscall: string, path: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: injected failure, ${syscall} '${path}'`), {
		errno: -(constants.errno[code as keyof typeof constants.errno] ?? 1),
		code,
		syscall,
		path,
	});
}

/** Whether `path` is `directory` or a path inside it. */
export function isSameOrWithin(directory: string, path: string): boolean {
	const inside = relative(resolve(directory), resolve(path));
	return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

/** One filesystem call that fails for one path, with the error code Node would give. */
export interface FilesystemFault {
	readonly call: string;
	readonly path: string;
	readonly code: string;
}

const SYSCALLS: Readonly<Record<string, string>> = {
	accessSync: "access",
	lstat: "lstat",
	readFile: "open",
	stat: "stat",
};

/** A filesystem function that takes the path first: `accessSync` returns nothing, the promise functions a promise. */
type PathFunction = (path: PathLike, ...rest: never[]) => Promise<object | string> | undefined;

/**
 * `module` with each function named in `calls` failing, as Node fails it, for a path that `faults()` names, and
 * calling through otherwise. Functions of a promise module reject; the others throw.
 */
export function withFilesystemFaults<Module extends object>(
	module: Module,
	kind: "promises" | "sync",
	calls: readonly string[],
	faults: () => readonly FilesystemFault[],
): Module {
	const original = module as Readonly<Record<string, PathFunction>>;
	const wrapped: Record<string, PathFunction> = {};
	for (const call of calls) {
		const real = original[call]!;
		wrapped[call] = (path, ...rest) => {
			const fault = faults().find((entry) => entry.call === call && resolve(entry.path) === resolve(String(path)));
			if (fault === undefined) return real(path, ...rest);
			const error = systemError(fault.code, SYSCALLS[call] ?? call, String(path));
			if (kind === "promises") return Promise.reject(error);
			throw error;
		};
	}
	const defaults = (module as { readonly default?: object }).default;
	return { ...original, ...wrapped, ...(defaults ? { default: { ...defaults, ...wrapped } } : {}) } as Module;
}

/** A process the code under test starts: what it would run, where, and with which environment. */
export interface SpawnRequest {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly detached: boolean | undefined;
}

/** What a test makes of one spawn: a failure Node reports for it, or another command run in its place. */
export type SpawnFault =
	| { readonly error: NodeJS.ErrnoException }
	| {
			readonly command: string;
			readonly args: readonly string[];
			/** Receives the process started in its place, for a test that must see it exit. */
			readonly spawned?: (child: ChildProcess.ChildProcess) => void;
	  };

/** The arguments of a Git command after its leading `-c key=value` settings. */
export function gitCommand(args: readonly string[]): string[] {
	const rest: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (rest.length === 0 && args[index] === "-c") index++;
		else rest.push(args[index]!);
	}
	return rest;
}

/** A command that writes `stderr` and exits with `exitCode`, run by the Node binary that runs the tests. */
export function failingCommand(exitCode: number, stderr = ""): { command: string; args: string[] } {
	return {
		command: process.execPath,
		args: ["-e", `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${exitCode};`],
	};
}

/**
 * A command that writes its process id to `pidFile` and then runs for 30 seconds unless it is killed. The id is written
 * to a temporary file that is then renamed, so `pidFile` never exists without the whole id in it.
 */
export function runningCommand(pidFile: string): { command: string; args: string[] } {
	return {
		command: process.execPath,
		args: [
			"-e",
			`const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid)); fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)}); setTimeout(() => {}, 30_000);`,
		],
	};
}

/** Whether a process with this id is still running. */
export function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The child of a spawn that failed: Node reports `error` and then `close`, and no process ever starts. */
function failedSpawn(error: NodeJS.ErrnoException): EventEmitter {
	const child = Object.assign(new EventEmitter(), {
		pid: undefined,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: () => false,
	});
	process.nextTick(() => {
		child.emit("error", error);
		child.emit("close", error.errno ?? -1, null);
	});
	return child;
}

/**
 * `module` whose `spawn` records every request with `fault`, then fails it or runs another command when `fault`
 * says so, and otherwise starts it unchanged.
 */
export function withSpawnFaults(
	module: typeof ChildProcess,
	fault: (request: SpawnRequest) => SpawnFault | undefined,
): typeof ChildProcess {
	const spawn = (command: string, args: readonly string[], options: ChildProcess.SpawnOptions) => {
		const chosen = fault({
			command,
			args,
			cwd: String(options?.cwd),
			env: options?.env ?? {},
			detached: options?.detached,
		});
		if (chosen !== undefined && "error" in chosen) return failedSpawn(chosen.error);
		const child = module.spawn(chosen?.command ?? command, chosen?.args ?? args, options);
		chosen?.spawned?.(child);
		return child;
	};
	return { ...module, spawn } as typeof ChildProcess;
}
