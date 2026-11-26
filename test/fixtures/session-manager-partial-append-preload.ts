import { mock } from "bun:test";
import { constants } from "node:fs";
import * as originalFs from "node:fs/promises";

const originalOpen = originalFs.open.bind(originalFs);

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

/** Writes part of a marked payload through a handle the store appends with, then fails, as a full disk would. */
function faultingWrites(handle: originalFs.FileHandle): originalFs.FileHandle {
	const write = handle.write.bind(handle) as (buffer: Buffer, offset: number, length: number) => Promise<unknown>;
	Object.assign(handle, {
		async write(buffer: Buffer, offset = 0, length = buffer.length - offset) {
			const data = buffer.subarray(offset, offset + length).toString("utf8");
			const marker = markers.find((candidate) => data.includes(candidate) && !fired.has(candidate));
			if (marker === undefined) return write(buffer, offset, length);
			fired.add(marker);
			const prefixLength = Buffer.byteLength(data.slice(0, data.indexOf(marker) + Math.max(1, Math.floor(marker.length / 2))));
			await write(buffer, offset, prefixLength);
			throw new PartialAppendFault(marker);
		},
	});
	return handle;
}

mock.module("node:fs/promises", () => ({
	...originalFs,
	async open(...args: Parameters<typeof originalFs.open>): Promise<originalFs.FileHandle> {
		const handle = await originalOpen(...args);
		const flags = args[1];
		return typeof flags === "number" && (flags & constants.O_APPEND) !== 0 ? faultingWrites(handle) : handle;
	},
}));
