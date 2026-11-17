import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function lockHeld(path: string): boolean {
	return existsSync(`${path}.lock`);
}

export function queryStatement(path: string): void {
	if (lockHeld(path)) return;
	new DatabaseSync(path).close();
}

function readStartToken(): string {
	return readFileSync("start-token", "utf8");
}

export function recordDurably(): void {
	writeFileSync("record.json", readStartToken());
}
