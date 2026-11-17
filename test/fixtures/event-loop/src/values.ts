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

/** A factory whose result the host keeps and calls for every key: the handler it returns runs on input. */
export function createCommandHandler(): (command: string) => string {
	const handleCommand = (command: string): string => fs.readFileSync(command, "utf8");
	return handleCommand;
}

/** Reached only through a handler the call graph cannot follow; the fixture's policy roots it. */
export function handleEngineRequest(path: string): boolean {
	return fs.statSync(path).isFile();
}

/** Hands a blocking API on as a shorthand property value. */
export function listThroughShorthand(path: string): number {
	const listing = { readdirSync };
	return listing.readdirSync(path).length;
}
