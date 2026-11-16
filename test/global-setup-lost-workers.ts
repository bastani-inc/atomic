import type * as ChildProcessModule from "node:child_process";
import type { ChildProcess, MessageOptions, SendHandle, Serializable } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { freemem } from "node:os";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALLED = Symbol.for("atomic.vitest.lostWorkerAttribution");

type MutableChildProcessModule = {
	fork: typeof ChildProcessModule.fork;
	[INSTALLED]?: boolean;
};

interface VitestWorkerFile {
	filepath?: string;
}

interface VitestWorkerMessage {
	type?: string;
	context?: {
		config?: {
			root?: string;
		};
		files?: readonly VitestWorkerFile[];
	};
}

export interface LostWorkerRecord {
	files: string[];
	code: number | null;
	signal: NodeJS.Signals | null;
	meaning: string;
	elapsedMs: number;
	freeMemoryBytes: number;
}

const EXIT_CODE_MEANINGS = new Map<number, string>([
	[0xc0000005, "access violation"],
	[0xc00000fd, "stack overflow"],
	[0xc0000409, "fail-fast (V8 CHECK or native abort)"],
	[0xc0000374, "heap corruption"],
	[0xc0000017, "out of memory"],
	[134, "abort"],
]);

const SIGNAL_MEANINGS: Readonly<Record<string, string>> = {
	SIGKILL: "killed (out-of-memory killer or external kill)",
	SIGSEGV: "segmentation fault",
	SIGABRT: "abort",
};

function decodeExit(code: number | null, signal: NodeJS.Signals | null): string {
	if (code !== null) {
		const unsigned = code >>> 0;
		const known = EXIT_CODE_MEANINGS.get(unsigned);
		if (known) return known;
		if (process.platform === "win32" && unsigned === 1 && signal === null) {
			return "terminated (TerminateProcess: process.kill or taskkill)";
		}
	}
	if (signal !== null) {
		const known = SIGNAL_MEANINGS[signal];
		if (known) return known;
	}
	return "unexpected exit";
}

export function formatLostWorkerSummary(record: LostWorkerRecord): string {
	const files = record.files.length > 0 ? record.files.join(", ") : "no file yet";
	const detail =
		record.code !== null ? `0x${(record.code >>> 0).toString(16).toUpperCase()} ${record.meaning}` : record.meaning;
	const freeMemoryGib = (record.freeMemoryBytes / 1024 ** 3).toFixed(1);
	return `${files} exited with code ${record.code} (${detail}) signal ${record.signal} after ${record.elapsedMs} ms; host free memory ${freeMemoryGib} GiB`;
}

function isVitestForksEntrypoint(modulePath: string | URL): boolean {
	const resolved = typeof modulePath === "string" ? modulePath : fileURLToPath(modulePath);
	return /[\\/]workers[\\/]forks\.js$/u.test(resolved);
}

type SendArgs = [
	message: Serializable,
	sendHandle?: SendHandle | ((error: Error | null) => void),
	options?: MessageOptions | ((error: Error | null) => void),
	callback?: (error: Error | null) => void,
];

function trackWorkerFork(child: ChildProcess): void {
	const startedAt = Date.now();
	const files: string[] = [];
	let rootDir = process.cwd();
	let expected = false;

	const originalSend = child.send.bind(child) as (...args: SendArgs) => boolean;
	child.send = ((...args: SendArgs): boolean => {
		const [message] = args;
		if (typeof message === "object" && message !== null) {
			const workerMessage = message as VitestWorkerMessage;
			if (workerMessage.type === "stop") expected = true;
			const configRoot = workerMessage.context?.config?.root;
			if (typeof configRoot === "string" && configRoot.length > 0) rootDir = configRoot;
			const messageFiles = workerMessage.context?.files;
			if (Array.isArray(messageFiles)) {
				for (const entry of messageFiles) {
					if (typeof entry?.filepath === "string") {
						const rel = relative(rootDir, entry.filepath).replaceAll("\\", "/");
						const normalized = rel.length > 0 && !rel.startsWith("..") ? rel : entry.filepath;
						if (!files.includes(normalized)) files.push(normalized);
					}
				}
			}
		}
		return originalSend(...args);
	}) as typeof child.send;

	const originalKill = child.kill.bind(child);
	child.kill = ((signal?: NodeJS.Signals | number): boolean => {
		expected = true;
		return originalKill(signal);
	}) as typeof child.kill;

	child.once("exit", (code, signal) => {
		if (expected) return;
		const record: LostWorkerRecord = {
			files: [...files],
			code,
			signal,
			meaning: decodeExit(code, signal),
			elapsedMs: Math.max(0, Date.now() - startedAt),
			freeMemoryBytes: freemem(),
		};
		process.stderr.write(`Lost test worker: ${formatLostWorkerSummary(record)}\n`);
		const outputFile = process.env.ATOMIC_TEST_LOST_WORKERS_FILE;
		if (outputFile) {
			mkdirSync(dirname(outputFile), { recursive: true });
			appendFileSync(outputFile, `${JSON.stringify(record)}\n`);
		}
	});
}

export default function setup(): void {
	const require = createRequire(import.meta.url);
	const childProcess = require("node:child_process") as MutableChildProcessModule;
	if (childProcess[INSTALLED]) return;
	childProcess[INSTALLED] = true;
	const originalFork = childProcess.fork.bind(childProcess) as (
		...args: Parameters<typeof ChildProcessModule.fork>
	) => ChildProcess;
	childProcess.fork = ((...args: Parameters<typeof ChildProcessModule.fork>): ChildProcess => {
		const child = originalFork(...args);
		if (isVitestForksEntrypoint(args[0])) trackWorkerFork(child);
		return child;
	}) as typeof ChildProcessModule.fork;
	syncBuiltinESMExports();
}
