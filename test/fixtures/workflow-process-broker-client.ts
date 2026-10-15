import { createInterface } from "node:readline";
import { spawnBrokerIfNeeded } from "../../packages/intercom/broker/spawn.js";
import { serializeFixtureError } from "../helpers/fixture-error.js";

for await (const line of createInterface({ input: process.stdin })) {
	const { id, command } = JSON.parse(line) as { id: number; command: "start" | "exit" };
	try {
		if (command === "start") await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"]);
		console.log(JSON.stringify({ id, result: {} }));
		if (command === "exit") process.exit(0);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		console.log(JSON.stringify({ id, error: serializeFixtureError(error) }));
	}
}
