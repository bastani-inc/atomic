import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const [shardPath, root] = process.argv.slice(2);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { ShipShard } = await jiti.import(
	fileURLToPath(new URL("../../packages/workflows/src/workers/ship-shard.ts", import.meta.url)),
);

let shard;

const handle = async (command) => {
	switch (command.action) {
		case "open": {
			shard = await ShipShard.open(shardPath, root);
			return { pid: process.pid };
		}
		case "hold": {
			await shard.hold(command.lease, command.leaseMs);
			return {};
		}
		case "accept": {
			const receipt = await shard.accept(root, command.lease, command.key, command.payload, command.at);
			return { receipt };
		}
		case "pending": {
			const events = await shard.pending(command.lease);
			return { events };
		}
		case "leftover": {
			const items = await shard.leftover();
			return { items };
		}
		case "seal": {
			const batch = await shard.seal(command.lease, command.maxBatch);
			return { batch: batch ?? null };
		}
		case "close": {
			if (shard !== undefined) {
				await shard.close();
				shard = undefined;
			}
			return {};
		}
		default:
			throw new Error(`Unknown action: ${String(command.action)}`);
	}
};

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const command = JSON.parse(line);
	handle(command).then(
		(result) => send({ id: command.id, ok: true, ...result }),
		(error) =>
			send({
				id: command.id,
				ok: false,
				name: error instanceof Error ? error.name : "Error",
				message: String(error instanceof Error ? error.message : error),
			}),
	);
});

send({ event: "ready", pid: process.pid });
