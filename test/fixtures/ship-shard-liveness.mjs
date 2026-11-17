import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const [directory] = process.argv.slice(2);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { ShipShard, shipShardPath } = await jiti.import(
	fileURLToPath(new URL("../../packages/workflows/src/workers/ship-shard.ts", import.meta.url)),
);

const lease = { id: "work-1", generation: 1, worker: "host/1", epoch: 1 };
const shard = await ShipShard.open(shipShardPath(directory, "journal", "root"), "root");
await shard.hold(lease, 600_000);
const receipt = await shard.accept("root", lease, "key", "{}", 1);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
