import { lstatSync, readdirSync, readFileSync } from "node:fs";

function afterImmediate(): void {
	readdirSync("immediate");
}

function afterSettled(): void {
	lstatSync("settled");
}

async function warmCache(): Promise<void> {
	await Promise.resolve();
	readFileSync("cache.json");
}

export function scheduleStartupWork(): void {
	setImmediate(afterImmediate);
	void Promise.resolve().then(afterSettled);
	void warmCache();
}
