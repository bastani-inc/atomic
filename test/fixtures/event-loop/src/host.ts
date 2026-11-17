import { execSync } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Loader } from "./loader.ts";
import { listOwnedArea } from "./owned.ts";
import { compilesInvalidPattern, matchesModulePatterns } from "./patterns.ts";
import { Session } from "./session.ts";
import { scheduleStartupWork } from "./startup.ts";
import { queryStatement, recordDurably } from "./statements.ts";
import { FileStore, type Store } from "./stores.ts";
import { Terminal } from "./terminal.ts";
import { countEntries, existsByElement, nativeProcessQueries, openDatabase, readThroughCast } from "./values.ts";

const store: Store = new FileStore();

function loadConfigBeforeFirstFrame(): string {
	const text = readFileSync("config.json", "utf8");
	return /^(\s*\w+\s*)+=/.test(text) ? text : "";
}

function spin(milliseconds: number): void {
	const end = Date.now() + milliseconds;
	while (Date.now() < end) {}
}

function sleepWithAtomics(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function reviewedStartupHelper(): void {
	rmSync("stale.lock", { force: true });
}

async function readLazily(): Promise<string> {
	const { readFileSync: read } = await import("node:fs");
	return read("lazy.txt", "utf8");
}

function handleKey(data: string): void {
	if (/^(\w+\s?)*$/.test(data)) return;
	if (new RegExp("^[a-z]+$").test(data)) return;
	appendFileSync("keys.log", realpathSync.native(data));
	store.save(data);
	spin(1);
	sleepWithAtomics(1);
	reviewedStartupHelper();
	pbkdf2Sync(data, "salt", 1, 32, "sha256");
	listOwnedArea();
	void readLazily();
	process.once("exit", flushOnExit);
	void new Loader({ text: data }).text;
	const session = new Session();
	session.exportText();
	void session.title;
	matchesModulePatterns(data);
	compilesInvalidPattern(data);
	countEntries([data]);
	openDatabase(data);
	readThroughCast(data);
	existsByElement(data);
	nativeProcessQueries(data.length);
	queryStatement(data);
	recordDurably();
}

function pollStatus(): string {
	return execSync("git status --short", { encoding: "utf8" });
}

function flushOnExit(): void {
	writeFileSync("exit.flush", "flushed");
}

export function startHost(): void {
	loadConfigBeforeFirstFrame();
	scheduleStartupWork();
	new Terminal().start((data) => handleKey(data));
	setInterval(pollStatus, 1_000);
	process.on("exit", () => writeFileSync("exit.marker", "bye"));
}

startHost();
