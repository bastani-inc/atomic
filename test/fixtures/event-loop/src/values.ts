import * as fs from "node:fs";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";

const requireModule = createRequire(import.meta.url);

export function listWith(list: (path: string) => string[], path: string): string[] {
	return list(path);
}

export function countEntries(paths: string[]): number {
	return listWith(readdirSync, paths[0] ?? ".").length;
}

export function openDatabase(path: string): void {
	const { DatabaseSync } = requireModule("node:sqlite") as { DatabaseSync: new (path: string) => { close(): void } };
	new DatabaseSync(path).close();
}

export function readThroughCast(path: string): string {
	const files = requireModule("node:fs") as { readFileSync(path: string, encoding: "utf8"): string };
	return files.readFileSync(path, "utf8");
}

export function existsByElement(path: string): boolean {
	return fs["existsSync"](path);
}

export function nativeProcessQueries(pid: number): unknown[] {
	const natives = requireModule("@bastani/atomic-natives") as {
		processCreationTime(pid: number): string | null;
		containProcessTree(pid: number): unknown;
		tryAdvisoryLock(path: string): unknown;
	};
	return [natives.processCreationTime(pid), natives.containProcessTree(pid), natives.tryAdvisoryLock("held.lock")];
}
