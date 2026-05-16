import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentConfigPaths } from "@bastani/atomic";

export interface RunEntry {
	agent: string;
	task: string;
	ts: number;
	status: "ok" | "error";
	duration: number;
	exit?: number;
}

const HISTORY_PATH = getAgentConfigPaths("run-history.jsonl")[0] ?? path.join(os.homedir(), ".atomic", "agent", "run-history.jsonl");
const HISTORY_READ_PATHS = getAgentConfigPaths("run-history.jsonl");
const ROTATE_READ_THRESHOLD = 1200;
const ROTATE_KEEP = 1000;

export function recordRun(agent: string, task: string, exitCode: number, durationMs: number): void {
	try {
		const entry: RunEntry = {
			agent,
			task: task.slice(0, 200),
			ts: Math.floor(Date.now() / 1000),
			status: exitCode === 0 ? "ok" : "error",
			duration: durationMs,
			...(exitCode !== 0 ? { exit: exitCode } : {}),
		};
		fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
		fs.appendFileSync(HISTORY_PATH, `${JSON.stringify(entry)}\n`);
	} catch {
		// Best-effort — never crash the execution flow for history recording
	}
}

export function loadRunsForAgent(agent: string): RunEntry[] {
	let lines: string[] = [];
	for (const historyPath of HISTORY_READ_PATHS) {
		if (!fs.existsSync(historyPath)) continue;
		try {
			lines.push(...fs.readFileSync(historyPath, "utf-8").split("\n"));
		} catch {
			continue;
		}
	}
	lines = lines.map((line) => line.trim()).filter((line) => line.length > 0);
	if (lines.length === 0) return [];

	if (lines.length > ROTATE_READ_THRESHOLD) {
		lines = lines.slice(-ROTATE_KEEP);
		try { fs.writeFileSync(HISTORY_PATH, `${lines.join("\n")}\n`, "utf-8"); } catch {}
	}

	return lines
		.map((line) => { try { return JSON.parse(line) as RunEntry; } catch { return undefined; } })
		.filter((entry): entry is RunEntry => Boolean(entry) && entry.agent === agent)
		.reverse();
}
