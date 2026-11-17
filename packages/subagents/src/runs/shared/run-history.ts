import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentConfigPaths, sliceHead } from "@bastani/atomic";

export interface RunEntry {
	agent: string;
	task: string;
	ts: number;
	status: "ok" | "error" | "skipped" | "interrupted" | "killed" | "continued";
	duration: number;
}

const HISTORY_PATH =
	getAgentConfigPaths("run-history.jsonl")[0] ?? path.join(os.homedir(), ".atomic", "agent", "run-history.jsonl");
const HISTORY_READ_PATHS = getAgentConfigPaths("run-history.jsonl");
const ROTATE_READ_THRESHOLD = 1200;
const ROTATE_KEEP = 1000;

let recordRunQueue: Promise<void> = Promise.resolve();

export function recordRun(agent: string, task: string, status: RunEntry["status"], durationMs: number): Promise<void> {
	const entry: RunEntry = {
		agent,
		task: sliceHead(task, 200),
		ts: Math.floor(Date.now() / 1000),
		status,
		duration: durationMs,
	};
	const line = `${JSON.stringify(entry)}\n`;
	recordRunQueue = recordRunQueue
		.then(async () => {
			await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
			await fs.appendFile(HISTORY_PATH, line);
		})
		.catch(() => {
			// Best-effort — never crash the execution flow for history recording
		});
	return recordRunQueue;
}

export async function loadRunsForAgent(agent: string): Promise<RunEntry[]> {
	await recordRunQueue;
	let lines: string[] = [];
	for (const historyPath of HISTORY_READ_PATHS) {
		try {
			const content = await fs.readFile(historyPath, "utf-8");
			lines.push(...content.split("\n"));
		} catch {}
	}
	lines = lines.map((line) => line.trim()).filter((line) => line.length > 0);
	if (lines.length === 0) return [];

	if (lines.length > ROTATE_READ_THRESHOLD) {
		lines = lines.slice(-ROTATE_KEEP);
		try {
			await fs.writeFile(HISTORY_PATH, `${lines.join("\n")}\n`, "utf-8");
		} catch {}
	}

	return lines
		.map((line) => {
			try {
				return JSON.parse(line) as RunEntry;
			} catch {
				return undefined;
			}
		})
		.filter((entry): entry is RunEntry => entry !== undefined && entry.agent === agent)
		.reverse();
}
