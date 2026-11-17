import { execSync } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { listOwnedArea } from "./owned.ts";
import { FileStore, type Store } from "./stores.ts";
import { Terminal } from "./terminal.ts";

const store: Store = new FileStore();

function loadConfigBeforeFirstFrame(): string {
	return readFileSync("config.json", "utf8");
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
	appendFileSync("keys.log", data);
	store.save(data);
	spin(1);
	sleepWithAtomics(1);
	reviewedStartupHelper();
	pbkdf2Sync(data, "salt", 1, 32, "sha256");
	listOwnedArea();
	void readLazily();
}

function pollStatus(): string {
	return execSync("git status --short", { encoding: "utf8" });
}

export function startHost(): void {
	loadConfigBeforeFirstFrame();
	new Terminal().start((data) => handleKey(data));
	setInterval(pollStatus, 1_000);
	process.on("exit", () => writeFileSync("exit.marker", "bye"));
}

startHost();
