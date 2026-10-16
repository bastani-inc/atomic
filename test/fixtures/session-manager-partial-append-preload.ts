import { mock } from "bun:test";
import * as originalFs from "node:fs/promises";
const originalAppendFile = originalFs.appendFile.bind(originalFs);

export class PartialAppendFault extends Error {
	readonly marker: string;

	constructor(marker: string) {
		super(`Fault after partial physical append: ${marker}`);
		this.name = "PartialAppendFault";
		this.marker = marker;
	}
}

const markers = ["partial-fault-later", "partial-fault-batch"] as const;
const fired = new Set<string>();

mock.module("node:fs/promises", () => ({
	...originalFs,
	async appendFile(path: string, data: string): Promise<void> {
		const marker = markers.find((candidate) => data.includes(candidate) && !fired.has(candidate));
		if (marker === undefined) {
			await originalAppendFile(path, data);
			return;
		}
		fired.add(marker);
		const prefixLength = data.indexOf(marker) + Math.max(1, Math.floor(marker.length / 2));
		await originalAppendFile(path, data.slice(0, prefixLength));
		throw new PartialAppendFault(marker);
	},
}));
