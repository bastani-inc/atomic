import { readFileSync, writeFileSync } from "node:fs";

// Change only fixed-size dependency-name storage. Code signatures are invalidated;
// the producer must re-sign changed images before sealing/promoting its inventory.
export function relocateMachO(path, replacements) {
	const bytes = readFileSync(path);
	let changed = false;
	function visit(image) {
		if (image.length < 4) return;
		if (image.readUInt32BE(0) === 0xcafebabe) {
			for (let i = 0; i < image.readUInt32BE(4); i++) {
				const start = image.readUInt32BE(16 + i * 20),
					size = image.readUInt32BE(20 + i * 20);
				if (start + size > image.length) throw new Error("invalid Mach-O slice");
				visit(image.subarray(start, start + size));
			}
			return;
		}
		if (image.readUInt32LE(0) !== 0xfeedfacf) return;
		let offset = 32;
		for (let i = 0; i < image.readUInt32LE(16); i++) {
			const command = image.readUInt32LE(offset),
				size = image.readUInt32LE(offset + 4);
			if (size < 8 || offset + size > image.length) throw new Error("invalid Mach-O command");
			if ([0xc, 0x80000018, 0x8000001f, 0x80000023].includes(command)) {
				const start = offset + image.readUInt32LE(offset + 8),
					end = image.indexOf(0, start);
				if (start < offset || end < start || end >= offset + size) throw new Error("invalid Mach-O dependency");
				const replacement = replacements.get(image.toString("utf8", start, end));
				if (replacement !== undefined) {
					if (Buffer.byteLength(replacement) + 1 > offset + size - start)
						throw new Error(`Mach-O dependency needs relinking: ${replacement}`);
					image.fill(0, start, offset + size);
					image.write(replacement, start);
					changed = true;
				}
			}
			offset += size;
		}
	}
	visit(bytes);
	if (changed) writeFileSync(path, bytes);
	return changed;
}
