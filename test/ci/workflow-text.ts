import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/** Normalize checkout line endings for source and documentation assertions. */
export async function readText(path: string): Promise<string> {
	return (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
}

/** Extract a job's embedded shell client for execution tests. */
export function jobBlock(workflow: string, name: string, next?: string): string {
	const start = workflow.indexOf(`  ${name}:`);
	assert.notEqual(start, -1, `missing job: ${name}`);
	const end = next ? workflow.indexOf(`  ${next}:`, start + 1) : workflow.length;
	return workflow.slice(start, end);
}
