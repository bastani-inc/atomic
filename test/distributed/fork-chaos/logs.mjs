/**
 * Worker attempt logs of a fork chaos round (#4321): the controller collects every worker's state archive onto node a,
 * and the checker reads the collected logs of every worker the timeline expects.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChaosInvariantError } from "./verdict.mjs";

/** @typedef {{ readonly code: number | null, readonly stdout: Buffer }} TransferResult */

/**
 * @typedef {object} LogTransfer
 * @property {(node: string) => Promise<TransferResult>} archive archives `node`'s state directory
 * @property {(node: string, archive: Buffer) => void} save keeps the archive among the round's artifacts
 * @property {(node: string, archive: Buffer) => Promise<TransferResult>} extract unpacks the archive's logs on node a
 * @property {() => Promise<void>} check runs the checker over the collected logs
 */

/**
 * @param {string} node
 * @param {"archive" | "extract"} transfer
 * @param {TransferResult} result
 * @returns {void}
 */
function assertTransferred(node, transfer, result) {
	if (result.code === 0) return;
	throw new ChaosInvariantError("logs-not-collected", {
		node,
		transfer,
		transferExitCode: result.code,
	});
}

/**
 * Collects every worker's logs, then runs the checker. An archive is saved and extracted only after it was produced
 * completely, and the checker runs only after every worker's logs were extracted; a failed or killed transfer throws
 * a `logs-not-collected` {@link ChaosInvariantError} instead.
 *
 * @param {readonly string[]} workers
 * @param {LogTransfer} transfer
 * @returns {Promise<void>}
 */
export async function collectLogsAndCheck(workers, { archive, save, extract, check }) {
	for (const node of workers) {
		const archived = await archive(node);
		assertTransferred(node, "archive", archived);
		save(node, archived.stdout);
		assertTransferred(node, "extract", await extract(node, archived.stdout));
	}
	await check();
}

/** @typedef {{ readonly t: string, readonly logNode: string, readonly [key: string]: unknown }} WorkerLogRecord */
/**
 * @typedef {{ readonly node: string | null, readonly problem: string, readonly file?: string, readonly line?: number, readonly errno?: string }} WorkerLogProblem
 */
/** @typedef {{ files: number, records: number, emptyFiles: number, tornFinalLines: number }} WorkerLogCounts */

const WORKER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * @param {unknown} value
 * @returns {value is readonly string[]}
 */
const isWorkerList = (value) =>
	Array.isArray(value) &&
	value.length > 0 &&
	value.every((node) => typeof node === "string" && WORKER_NAME.test(node)) &&
	new Set(value).size === value.length;

/**
 * @param {unknown} error
 * @returns {string}
 */
const errnoOf = (error) =>
	typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "unknown";

/**
 * The log record `line` holds, or `undefined` when it is not a JSON object with a string `t`.
 *
 * @param {string} line
 * @returns {{ readonly t: string, readonly [key: string]: unknown } | undefined}
 */
function parseRecord(line) {
	let value;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.t === "string"
		? value
		: undefined;
}

/**
 * Reads the collected logs (`<dir>/<node>/*.jsonl`) of every worker in `expectedWorkers`, the list the controller took
 * from the manifest. Every complete (newline-terminated) line must be a log record. Only a file's final line may be
 * torn, by a process killed while writing it; it is skipped and counted. A zero-byte file, from a process killed
 * before its first record, is counted too. `problems` lists each worker without readable logs, with no record at
 * all, or with a corrupt complete line, each node directory the list lacks, and an invalid list.
 *
 * @param {string} dir
 * @param {unknown} expectedWorkers
 * @returns {{ records: WorkerLogRecord[], files: number, problems: WorkerLogProblem[], logsByNode: Record<string, WorkerLogCounts> }}
 */
export function readWorkerLogs(dir, expectedWorkers) {
	/** @type {WorkerLogRecord[]} */
	const records = [];
	/** @type {WorkerLogProblem[]} */
	const problems = [];
	/** @type {Record<string, WorkerLogCounts>} */
	const logsByNode = {};
	let files = 0;
	if (!isWorkerList(expectedWorkers))
		return { records, files, problems: [{ node: null, problem: "timeline does not list the expected workers" }], logsByNode };
	for (const node of expectedWorkers) {
		const counts = { files: 0, records: 0, emptyFiles: 0, tornFinalLines: 0 };
		logsByNode[node] = counts;
		/** @param {{ readonly t: string, readonly [key: string]: unknown }} record */
		const keep = (record) => {
			records.push({ ...record, logNode: node });
			counts.records++;
		};
		let names;
		try {
			names = readdirSync(join(dir, node))
				.filter((name) => name.endsWith(".jsonl"))
				.sort();
		} catch (error) {
			const errno = errnoOf(error);
			problems.push(errno === "ENOENT" ? { node, problem: "no log directory" } : { node, problem: "log directory unreadable", errno });
			continue;
		}
		if (names.length === 0) {
			problems.push({ node, problem: "no attempt logs" });
			continue;
		}
		for (const file of names) {
			counts.files++;
			files++;
			let text;
			try {
				text = readFileSync(join(dir, node, file), "utf8");
			} catch (error) {
				problems.push({ node, problem: "log unreadable", file, errno: errnoOf(error) });
				continue;
			}
			if (text.length === 0) {
				counts.emptyFiles++;
				continue;
			}
			const lines = text.split("\n");
			const final = lines.pop() ?? "";
			lines.forEach((line, index) => {
				const record = parseRecord(line);
				if (record === undefined) problems.push({ node, problem: "corrupt record", file, line: index + 1 });
				else keep(record);
			});
			if (final === "") continue;
			const record = parseRecord(final);
			if (record === undefined) counts.tornFinalLines++;
			else keep(record);
		}
		if (counts.records === 0) problems.push({ node, problem: "no log records" });
	}
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true }))
			if (entry.isDirectory() && !expectedWorkers.includes(entry.name))
				problems.push({ node: entry.name, problem: "log directory of a node the timeline does not list" });
	} catch (error) {
		problems.push({ node: null, problem: "collected directory unreadable", errno: errnoOf(error) });
	}
	return { records, files, problems, logsByNode };
}
