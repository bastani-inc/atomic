import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * Workflow-text helpers shared by the CI contract suites.
 *
 * These contracts assert on what the repository stores, which is LF.
 * `.gitattributes` now pins `*.yml` to `eol=lf`, so a CRLF checkout should no
 * longer be possible; before that pin the Windows runner checked the workflows
 * out as CRLF and any pattern containing a literal `\n` passed on Linux and
 * failed on Windows. Every reader here still normalizes newlines so the suites
 * cannot silently regress if that attribute is ever relaxed.
 */
export async function readText(path: string): Promise<string> {
	return (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
}

/** The text of one job, from its `  <name>:` header to the next job or EOF. */
export function jobBlock(workflow: string, name: string, next?: string): string {
	const start = workflow.indexOf(`  ${name}:`);
	assert.notEqual(start, -1, `missing job: ${name}`);
	const end = next ? workflow.indexOf(`  ${next}:`, start + 1) : workflow.length;
	return workflow.slice(start, end);
}

/** Split a job block into its individual steps, indentation-agnostically. */
export function jobSteps(block: string): string[] {
	const header = /^(\s*)steps:$/mu.exec(block);
	assert.ok(header, "job declares no steps");
	const body = block.slice(header.index + header[0].length);
	const first = /^([ \t]+)- /mu.exec(body);
	assert.ok(first, "job declares no steps");
	return body.split(new RegExp(`^${first[1] as string}- `, "gmu")).slice(1);
}

/** Every job in a workflow, paired with its own block. */
export function jobBlocks(workflow: string): [string, string][] {
	const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
	const names = [...jobs.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gmu)].map(([, name]) => name as string);
	return names.map((name, index) => [name, jobBlock(jobs, name, names[index + 1])]);
}

/** The step whose `- name:` starts with `prefix`, asserted to be unique. */
export function namedStep(steps: string[], prefix: string): string {
	const matches = steps.filter((step) => step.startsWith(`name: ${prefix}`));
	assert.equal(matches.length, 1, `expected exactly one step named like: ${prefix}`);
	return matches[0] as string;
}

/** Index of the step whose `- name:` starts with `prefix`, for ordering checks. */
export function stepIndex(steps: string[], prefix: string): number {
	const index = steps.findIndex((step) => step.startsWith(`name: ${prefix}`));
	assert.notEqual(index, -1, `missing step: ${prefix}`);
	return index;
}
