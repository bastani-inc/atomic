/**
 * Worker attempt logs of a fork chaos round (#4321): the controller collects every worker's state archive onto node a,
 * and the checker reads the collected logs of every worker the timeline expects.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChaosInvariantError } from "./verdict.mjs";

/** @typedef {{ readonly code: number | null, readonly stdout: Buffer | string }} TransferResult */

/**
 * Runs `command` on `node` over SSH, with `input` on its stdin; `binary` keeps its stdout a Buffer.
 *
 * @typedef {(node: string, command: string, options: { readonly input?: Buffer | string, readonly binary?: boolean }) => Promise<TransferResult>} RemoteCommand
 */

/**
 * The {@link RemoteCommand} the controller uses: `ssh` with `sshOptions` to `azureuser` at the node's private IP, which
 * `nodes` maps from the node's name.
 *
 * @param {(command: string, args: readonly string[], options: { readonly input?: Buffer | string, readonly binary?: boolean }) => Promise<TransferResult>} exec
 * @param {readonly string[]} sshOptions
 * @param {Readonly<Record<string, { readonly ip: string }>>} nodes
 * @returns {RemoteCommand}
 */
export const sshRemote = (exec, sshOptions, nodes) => (node, command, options) =>
	exec("ssh", [...sshOptions, `azureuser@${nodes[node].ip}`, command], options);

const STATE = "/opt/fork-chaos/state";
const COLLECTED = "/opt/fork-chaos/collected";
const ARCHIVE = `tar -C ${STATE} -czf - $(cd ${STATE} && ls *.jsonl *.log sources.json 2>/dev/null)`;

/**
 * @param {string} node
 * @param {"archive" | "extract"} transfer
 * @param {TransferResult} result
 * @returns {void}
 */
function assertTransferred(node, transfer, result) {
	if (result.code === 0) return;
	throw new ChaosInvariantError("logs-not-collected", { node, transfer, transferExitCode: result.code });
}

/**
 * Collects every worker's logs onto node a, into a fresh `/opt/fork-chaos/collected/<node>`, and records `workers` as
 * the timeline's `expectedWorkers`, the list the checker requires logs from. Each worker's state archive is kept as
 * `raw/<node>-state.tgz` in `artifactDir`, but only once it was produced completely, and only then extracted. A failed
 * or killed transfer throws a `logs-not-collected` {@link ChaosInvariantError}, so the checker never runs on partial
 * logs.
 *
 * @param {{ readonly workers: readonly string[], readonly timeline: { expectedWorkers?: readonly string[] }, readonly artifactDir: string, readonly remote: RemoteCommand }} round
 * @returns {Promise<void>}
 */
export async function collectLogs({ workers, timeline, artifactDir, remote }) {
	timeline.expectedWorkers = workers;
	for (const node of workers) {
		const archived = await remote(node, ARCHIVE, { binary: true });
		assertTransferred(node, "archive", archived);
		writeFileSync(join(artifactDir, "raw", `${node}-state.tgz`), archived.stdout);
		const target = `${COLLECTED}/${node}`;
		const extract = `rm -rf ${target} && mkdir -p ${target} && tar -xzf - -C ${target} --wildcards '*.jsonl'`;
		assertTransferred(node, "extract", await remote("a", extract, { input: archived.stdout }));
	}
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
 * The `code` of an error the `node:fs` calls below throw; with string paths they throw only Node system errors.
 *
 * @param {unknown} error
 * @returns {string | undefined}
 */
const errnoOf = (error) => /** @type {NodeJS.ErrnoException} */ (error).code;

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
	return typeof value?.t === "string" ? value : undefined;
}

/**
 * Reads the collected logs (`<dir>/<node>/*.jsonl`) of every worker in `expectedWorkers`, the list
 * the controller took from the manifest. Every complete (newline-terminated) line must be a log record. Only a file's
 * final line may be torn, by a process killed while writing it; it is skipped and counted. A zero-byte file, from a
 * process killed before its first record, is counted too. `problems` lists each worker without readable logs, with no
 * record at all, or with a corrupt complete line, each node directory the list lacks, and an invalid list.
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
	/** @type {Map<string, WorkerLogCounts>} */
	const logsByNode = new Map();
	let files = 0;
	if (!isWorkerList(expectedWorkers))
		return {
			records,
			files,
			problems: [{ node: null, problem: "timeline does not list the expected workers" }],
			logsByNode: {},
		};
	for (const node of expectedWorkers) {
		const counts = { files: 0, records: 0, emptyFiles: 0, tornFinalLines: 0 };
		logsByNode.set(node, counts);
		/** @param {{ readonly t: string, readonly [key: string]: unknown }} record */
		const keep = (record) => {
			records.push({ ...record, logNode: node });
			counts.records++;
		};
		let names;
		try {
			names = readdirSync(join(dir, node)).filter((name) => name.endsWith(".jsonl"));
		} catch (error) {
			const errno = errnoOf(error);
			problems.push(
				errno === "ENOENT"
					? { node, problem: "no log directory" }
					: { node, problem: "log directory unreadable", errno },
			);
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
			const final = lines.pop();
			lines.forEach((line, index) => {
				const record = parseRecord(line);
				if (record === undefined) problems.push({ node, problem: "corrupt record", file, line: index + 1 });
				else keep(record);
			});
			if (!final) continue;
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
	return { records, files, problems, logsByNode: Object.fromEntries(logsByNode) };
}
