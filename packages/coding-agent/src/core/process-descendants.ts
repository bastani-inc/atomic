/**
 * The processes a running process started, and theirs, each told apart from a later process given its pid by when it
 * started, so that ending them later never signals another process.
 */
import { execFile, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

/**
 * A process and when it started: on Linux its start time since boot in clock ticks, on macOS its start time to the
 * second.
 */
export interface IdentifiedProcess {
	readonly pid: number;
	readonly started: string;
}

/** A process's parent, process group and start time, as one read of the process table gave them. */
interface ProcessRow {
	readonly parent: number;
	readonly group: number;
	readonly started: string;
}

/** How long reading the process table through `ps` may take before it is given up. */
const PS_TIMEOUT_MS = 2_000;
/** How many `/proc` entries are read at once. */
const PROC_READS_AT_ONCE = 32;

/** A process's row and state (`R`, `S`, ..., `Z` once it ended and is not reaped yet), from its `/proc/<pid>/stat`. */
function linuxProcessRow(stat: string): (ProcessRow & { readonly state: string }) | undefined {
	// After the command name, which may hold spaces and parentheses: state, parent, process group, ..., the start
	// time (22nd field).
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const started = fields[19];
	if (started === undefined || !/^\d+$/.test(started)) return undefined;
	return { state: fields[0] ?? "", parent: Number(fields[1]), group: Number(fields[2]), started };
}

/** Parent, process group and start time of process `pid`, from one read of its `/proc` entry; undefined once gone. */
async function linuxProcess(pid: number): Promise<ProcessRow | undefined> {
	try {
		return linuxProcessRow(await readFile(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return undefined;
	}
}

/** {@link linuxProcess}, read at once, with the process's state. */
function linuxProcessNow(pid: number): (ProcessRow & { readonly state: string }) | undefined {
	try {
		return linuxProcessRow(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return undefined;
	}
}

/** Every process's parent, process group and start time, from one pass over `/proc`; undefined if it cannot be read. */
async function linuxProcesses(): Promise<Map<number, ProcessRow> | undefined> {
	let entries: string[];
	try {
		entries = await readdir("/proc");
	} catch {
		return undefined;
	}
	const pids = entries.filter((entry) => /^[0-9]+$/.test(entry)).map(Number);
	const processes = new Map<number, ProcessRow>();
	// A few reads at a time: a machine with many thousands of processes must not run out of file descriptors.
	for (let start = 0; start < pids.length; start += PROC_READS_AT_ONCE) {
		const batch = pids.slice(start, start + PROC_READS_AT_ONCE);
		const rows = await Promise.all(batch.map(async (pid) => [pid, await linuxProcess(pid)] as const));
		for (const [pid, row] of rows) if (row !== undefined) processes.set(pid, row);
	}
	return processes;
}

/** The children of process `pid`, from its threads' `/proc` lists; undefined where the kernel keeps none. */
async function linuxChildren(pid: number): Promise<number[] | undefined> {
	let threads: string[];
	try {
		threads = await readdir(`/proc/${pid}/task`);
	} catch {
		return undefined;
	}
	const children: number[] = [];
	for (const thread of threads) {
		try {
			children.push(...words(await readFile(`/proc/${pid}/task/${thread}/children`, "utf8")).map(Number));
		} catch {
			return undefined;
		}
	}
	return children;
}

/**
 * On Linux, {@link descendantsOf} from the children `/proc` lists, which read only the tree; undefined where the kernel
 * keeps no such lists, and the whole process table is read instead. Each process is taken with the parent, process group
 * and start time one read of its entry gave, and only while those agree with the tree and `root`'s group.
 */
async function linuxDescendants(root: number): Promise<IdentifiedProcess[] | undefined> {
	const rootRow = await linuxProcess(root);
	if (rootRow === undefined) return [];
	if ((await linuxChildren(root)) === undefined) return undefined;
	const found = new Map<number, IdentifiedProcess>();
	const pending: IdentifiedProcess[] = [{ pid: root, started: rootRow.started }];
	while (pending.length > 0) {
		const parent = pending.pop()!;
		for (const child of (await linuxChildren(parent.pid)) ?? []) {
			if (found.has(child)) continue;
			const row = await linuxProcess(child);
			if (row === undefined || row.parent !== parent.pid || row.group !== rootRow.group) continue;
			if (BigInt(row.started) < BigInt(parent.started)) continue;
			const identified = { pid: child, started: row.started };
			found.set(child, identified);
			pending.push(identified);
		}
	}
	return [...found.values()];
}

let tableRead: Promise<Map<number, ProcessRow> | undefined> | undefined;

/**
 * Every process's parent, process group and start time. Stops that start together, as a quit's do, share one read of
 * the process table.
 */
function processTable(): Promise<Map<number, ProcessRow> | undefined> {
	if (tableRead === undefined) {
		const read = process.platform === "linux" ? linuxProcesses() : macProcesses();
		tableRead = read;
		void read.finally(() => {
			if (tableRead === read) tableRead = undefined;
		});
	}
	return tableRead;
}

/** The lines of `ps` with `args`, in English and with times in UTC, whatever the user's locale and time zone. */
function psLines(args: readonly string[]): Promise<string[] | undefined> {
	return new Promise((resolve) => {
		execFile(
			"/bin/ps",
			[...args],
			{ encoding: "utf8", timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
			// `ps -p` exits with a failure when one of the processes is gone, and still lists the others.
			(_error, stdout) => resolve(typeof stdout === "string" ? stdout.split("\n") : undefined),
		);
	});
}

/** The whitespace-separated words of `line`. */
function words(line: string): string[] {
	return line.split(" ").filter((word) => word !== "");
}

const PS_TABLE_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,lstart="];

/** The process table in the lines of `ps` with {@link PS_TABLE_ARGS}. */
function psTable(lines: readonly string[]): Map<number, ProcessRow> {
	const processes = new Map<number, ProcessRow>();
	for (const line of lines) {
		const [pid, parent, group, ...started] = words(line);
		if (pid === undefined || parent === undefined || group === undefined || started.length === 0) continue;
		processes.set(Number(pid), { parent: Number(parent), group: Number(group), started: started.join(" ") });
	}
	return processes;
}

/** On macOS, every process's parent, process group and start time, from one `ps` call. */
async function macProcesses(): Promise<Map<number, ProcessRow> | undefined> {
	const lines = await psLines(PS_TABLE_ARGS);
	return lines === undefined ? undefined : psTable(lines);
}

/**
 * The processes below `root` in `processes` that are in `root`'s process group, as a signal to that group would reach
 * them; a process that left the group, as a program started detached does, is not followed. A process is taken for a
 * child only if it started no earlier than its parent, so that a later process given a parent's pid while the table was
 * read does not adopt the parent's children.
 */
function descendants(
	root: number,
	processes: Map<number, ProcessRow>,
	startedAfter: (child: string, parent: string) => boolean,
): IdentifiedProcess[] {
	const group = processes.get(root)?.group;
	if (group === undefined) return [];
	const children = new Map<number, number[]>();
	for (const [pid, row] of processes) {
		if (pid === root || row.group !== group) continue;
		const siblings = children.get(row.parent) ?? [];
		siblings.push(pid);
		children.set(row.parent, siblings);
	}
	const found = new Map<number, IdentifiedProcess>();
	const pending = [root];
	while (pending.length > 0) {
		const parent = pending.pop()!;
		const parentStart = processes.get(parent)!.started;
		for (const child of children.get(parent) ?? []) {
			const started = processes.get(child)!.started;
			if (found.has(child) || !startedAfter(started, parentStart)) continue;
			found.set(child, { pid: child, started });
			pending.push(child);
		}
	}
	return [...found.values()];
}

/**
 * The processes `root` started, and theirs, in its process group, read while `root` runs: on Linux from `/proc`, on
 * macOS from one `ps` call. None on Windows, where they end with the process that started `root`, or when the process
 * table cannot be read.
 */
export async function descendantsOf(root: number): Promise<IdentifiedProcess[]> {
	if (process.platform !== "linux" && process.platform !== "darwin") return [];
	if (process.platform === "linux") {
		const found = await linuxDescendants(root);
		if (found !== undefined) return found;
	}
	const processes = await processTable();
	return processes === undefined ? [] : descendantsInTable(root, processes);
}

/** {@link descendants} with this system's start times. */
function descendantsInTable(root: number, processes: Map<number, ProcessRow>): IdentifiedProcess[] {
	return process.platform === "linux"
		? descendants(root, processes, (child, parent) => BigInt(child) >= BigInt(parent))
		: descendants(root, processes, (child, parent) => Date.parse(`${child} UTC`) >= Date.parse(`${parent} UTC`));
}

function signal(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// It ended since its start was read.
	}
}

/**
 * Sends `signal` to each of `processes` that is still the process recorded: one that started when it was recorded. On
 * Linux each is signalled right after its start is read again; on macOS after one `ps` call reads them all.
 */
export async function signalIfSame(processes: readonly IdentifiedProcess[], signalName: NodeJS.Signals): Promise<void> {
	if (process.platform === "linux") {
		for (const recorded of processes) {
			if ((await linuxProcess(recorded.pid))?.started === recorded.started) signal(recorded.pid, signalName);
		}
	} else if (process.platform === "darwin" && processes.length > 0) {
		const starts = new Map<number, string>();
		for (const line of (await psLines(["-o", "pid=,lstart=", "-p", processes.map(({ pid }) => pid).join(",")])) ??
			[]) {
			const [pid, ...started] = words(line);
			if (pid !== undefined && started.length > 0) starts.set(Number(pid), started.join(" "));
		}
		for (const recorded of processes)
			if (starts.get(recorded.pid) === recorded.started) signal(recorded.pid, signalName);
	}
}

// Reading at once, for a process that is about to exit and can no longer wait for anything.

/** {@link linuxChildren}, read at once. */
function linuxChildrenNow(pid: number): number[] | undefined {
	let threads: string[];
	try {
		threads = readdirSync(`/proc/${pid}/task`);
	} catch {
		return undefined;
	}
	const children: number[] = [];
	for (const thread of threads) {
		try {
			children.push(...words(readFileSync(`/proc/${pid}/task/${thread}/children`, "utf8")).map(Number));
		} catch {
			return undefined;
		}
	}
	return children;
}

/** {@link linuxDescendants}, read at once. */
function linuxDescendantsNow(root: number): IdentifiedProcess[] | undefined {
	const rootRow = linuxProcessNow(root);
	if (rootRow === undefined) return [];
	if (linuxChildrenNow(root) === undefined) return undefined;
	const found = new Map<number, IdentifiedProcess>();
	const pending: IdentifiedProcess[] = [{ pid: root, started: rootRow.started }];
	while (pending.length > 0) {
		const parent = pending.pop()!;
		for (const child of linuxChildrenNow(parent.pid) ?? []) {
			if (found.has(child)) continue;
			const row = linuxProcessNow(child);
			if (row === undefined || row.parent !== parent.pid || row.group !== rootRow.group) continue;
			if (BigInt(row.started) < BigInt(parent.started)) continue;
			const identified = { pid: child, started: row.started };
			found.set(child, identified);
			pending.push(identified);
		}
	}
	return [...found.values()];
}

/** {@link linuxProcesses}, read at once. */
function linuxProcessesNow(): Map<number, ProcessRow> | undefined {
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return undefined;
	}
	const processes = new Map<number, ProcessRow>();
	for (const entry of entries) {
		if (!/^[0-9]+$/.test(entry)) continue;
		const row = linuxProcessNow(Number(entry));
		if (row !== undefined) processes.set(Number(entry), row);
	}
	return processes;
}

/** {@link psLines}, at once. */
function psLinesNow(args: readonly string[]): string[] | undefined {
	const result = spawnSync("/bin/ps", [...args], {
		encoding: "utf8",
		timeout: PS_TIMEOUT_MS,
		env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
	});
	// A `ps` that could not start, or was stopped at the time limit, read nothing that can be trusted.
	if (result.error !== undefined || result.signal !== null) return undefined;
	return result.stdout.split("\n");
}

/** {@link descendantsOf}, read at once. */
export function descendantsOfNow(root: number): IdentifiedProcess[] {
	if (process.platform !== "linux" && process.platform !== "darwin") return [];
	if (process.platform === "linux") {
		const found = linuxDescendantsNow(root);
		if (found !== undefined) return found;
	}
	const lines = process.platform === "darwin" ? psLinesNow(PS_TABLE_ARGS) : undefined;
	const processes = process.platform === "linux" ? linuxProcessesNow() : lines && psTable(lines);
	return processes === undefined ? [] : descendantsInTable(root, processes);
}

/** {@link signalIfSame}, at once. */
export function signalIfSameNow(processes: readonly IdentifiedProcess[], signalName: NodeJS.Signals): void {
	if (process.platform === "linux") {
		for (const recorded of processes) {
			if (linuxProcessNow(recorded.pid)?.started === recorded.started) signal(recorded.pid, signalName);
		}
	} else if (process.platform === "darwin" && processes.length > 0) {
		const starts = new Map<number, string>();
		for (const line of psLinesNow(["-o", "pid=,lstart=", "-p", processes.map(({ pid }) => pid).join(",")]) ?? []) {
			const [pid, ...started] = words(line);
			if (pid !== undefined && started.length > 0) starts.set(Number(pid), started.join(" "));
		}
		for (const recorded of processes)
			if (starts.get(recorded.pid) === recorded.started) signal(recorded.pid, signalName);
	}
}
