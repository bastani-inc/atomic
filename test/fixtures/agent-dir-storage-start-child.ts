import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	defaultSessionDatabasePath,
	defaultSessionDatabasePathAsync,
} from "../../packages/coding-agent/src/core/storage/file-identity.js";

/**
 * One of several processes starting together on fresh agent directories. For every round it waits at a file barrier
 * until all processes arrived, then resolves the round's agent directory the way a starting process does. It prints
 * one line per round: the resolved session database path or the error the start failed with.
 */
const [root, label, processCountText, roundCountText] = process.argv.slice(2);
if (root === undefined || label === undefined || processCountText === undefined || roundCountText === undefined) {
	throw new Error("Expected root, label, process count and round count");
}
const processCount = Number(processCountText);
const roundCount = Number(roundCountText);
const BARRIER_TIMEOUT_MS = 30_000;

for (let round = 0; round < roundCount; round++) {
	const barrier = join(root, "barriers", String(round));
	mkdirSync(barrier, { recursive: true });
	writeFileSync(join(barrier, label), "");
	const deadline = Date.now() + BARRIER_TIMEOUT_MS;
	while (readdirSync(barrier).length < processCount) {
		if (Date.now() >= deadline) throw new Error(`Round ${round} did not start`);
	}
	const agent = join(root, "agents", String(round), "agent");
	let outcome: { readonly path: string } | { readonly error: string };
	try {
		outcome = {
			path:
				round % 2 === 0 ? defaultSessionDatabasePath(agent, {}) : await defaultSessionDatabasePathAsync(agent, {}),
		};
	} catch (error) {
		outcome = { error: error instanceof Error ? error.message : String(error) };
	}
	console.log(JSON.stringify({ round, ...outcome }));
}
