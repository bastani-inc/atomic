import type { RunSnapshot, StoreSnapshot } from "../shared/store-types.js";

const COLD_SERIALIZE_CHUNK_SIZE = 25;
const realSetTimeout = setTimeout;

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => {
		realSetTimeout(resolve, 0);
	});
}

export class StatusSnapshotSerializer {
	private readonly runCache = new WeakMap<RunSnapshot, string>();

	async serialize(snapshot: StoreSnapshot): Promise<string[]> {
		await yieldToEventLoop();
		const chunks = ["{\n"];
		if (snapshot.runs.length === 0) chunks.push('  "runs": [],\n');
		if (snapshot.runs.length > 0) {
			chunks.push('  "runs": [\n');
			let uncachedSinceYield = 0;
			for (let index = 0; index < snapshot.runs.length; index++) {
				const run = snapshot.runs[index]!;
				const canCache = Object.isFrozen(run);
				let serialized = canCache ? this.runCache.get(run) : undefined;
				if (serialized === undefined) {
					if (uncachedSinceYield >= COLD_SERIALIZE_CHUNK_SIZE) {
						uncachedSinceYield = 0;
						await yieldToEventLoop();
					}
					serialized = `    ${JSON.stringify(run, null, 2).replaceAll("\n", "\n    ")}`;
					if (canCache) {
						this.runCache.set(run, serialized);
					}
					uncachedSinceYield++;
				}
				if (index > 0) chunks.push(",\n");
				chunks.push(serialized);
			}
			chunks.push("\n  ],\n");
		}
		const noticesBlock = `  "notices": ${JSON.stringify(snapshot.notices, null, 2).replaceAll("\n", "\n  ")},\n`;
		const versionBlock = `  "version": ${JSON.stringify(snapshot.version)}\n`;
		chunks.push(noticesBlock, versionBlock, "}");
		return chunks;
	}

	close(): void {}
}
