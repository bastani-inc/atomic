import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExecOptions, ExecResult } from "../../core/extensions/index.ts";

export type FeedbackExec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export interface WorkingTreeEntry {
	path: string;
	status: string;
	fingerprint: string;
	sourcePath?: string;
}

export interface WorkingTreeSnapshot {
	cwd: string;
	status: "available" | "unavailable";
	entries: WorkingTreeEntry[];
}

export interface WorkingTreeArtifact {
	path: string;
	status: string;
	change: "created" | "changed" | "removed";
}

export interface WorkingTreeDisclosure {
	status: "unchanged" | "changed" | "unavailable";
	preExistingChangesPreserved?: boolean;
	artifacts: WorkingTreeArtifact[];
}

async function fingerprintEntry(cwd: string, status: string, path: string, sourcePath?: string): Promise<string> {
	const hash = createHash("sha256");
	hash.update(status);
	hash.update("\0");
	hash.update(path);
	hash.update("\0");
	if (sourcePath !== undefined) hash.update(sourcePath);
	try {
		hash.update(await readFile(resolve(cwd, path)));
	} catch {
		hash.update("<path unavailable>");
	}
	return hash.digest("hex");
}

async function parseWorkingTreeEntries(cwd: string, output: string): Promise<WorkingTreeEntry[]> {
	const records = output.split("\0");
	if (records.at(-1) === "") records.pop();
	const entries: WorkingTreeEntry[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record === undefined || record.length < 4) continue;
		const status = record.slice(0, 2);
		const path = record.slice(3);
		const renamedOrCopied = status.includes("R") || status.includes("C");
		const sourcePath = renamedOrCopied ? records[index + 1] : undefined;
		if (renamedOrCopied) index += 1;
		entries.push({
			path,
			status,
			fingerprint: await fingerprintEntry(cwd, status, path, sourcePath),
			...(sourcePath === undefined ? {} : { sourcePath }),
		});
	}
	return entries;
}

export async function captureWorkingTreeSnapshot(cwd: string, exec: FeedbackExec): Promise<WorkingTreeSnapshot> {
	const result = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		cwd,
		timeout: 5_000,
	});
	if (result.code !== 0 || result.killed) return { cwd, status: "unavailable", entries: [] };
	return { cwd, status: "available", entries: await parseWorkingTreeEntries(cwd, result.stdout) };
}

export function compareWorkingTreeSnapshots(
	before: WorkingTreeSnapshot,
	after: WorkingTreeSnapshot,
): WorkingTreeDisclosure {
	if (before.status === "unavailable" || after.status === "unavailable") {
		return { status: "unavailable", preExistingChangesPreserved: undefined, artifacts: [] };
	}

	const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
	const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
	const artifacts: WorkingTreeArtifact[] = [];
	for (const entry of after.entries) {
		const previous = beforeByPath.get(entry.path);
		if (previous?.fingerprint === entry.fingerprint) continue;
		artifacts.push({
			path: entry.path,
			status: entry.status,
			change: previous === undefined ? "created" : "changed",
		});
	}
	for (const entry of before.entries) {
		if (afterByPath.has(entry.path)) continue;
		artifacts.push({ path: entry.path, status: entry.status, change: "removed" });
	}

	const preExistingChangesPreserved = before.entries.every(
		(entry) => afterByPath.get(entry.path)?.fingerprint === entry.fingerprint,
	);
	return {
		status: artifacts.length === 0 ? "unchanged" : "changed",
		preExistingChangesPreserved,
		artifacts,
	};
}

export function formatWorkingTreeDisclosure(disclosure: WorkingTreeDisclosure): string {
	if (disclosure.status === "unavailable") {
		return "Working-tree disclosure unavailable because the current directory is not a Git checkout.";
	}
	if (disclosure.status === "unchanged") {
		return "Working-tree disclosure: pre-existing changes were preserved; the debugger left no new changes or artifacts.";
	}
	const preservation = disclosure.preExistingChangesPreserved
		? "pre-existing changes were preserved."
		: "one or more pre-existing changes were modified or removed during investigation.";
	return [
		`Working-tree disclosure: ${preservation}`,
		"Debugger changes or artifacts left in place:",
		...disclosure.artifacts.map((artifact) => `- ${artifact.change}: ${artifact.path}`),
	].join("\n");
}
