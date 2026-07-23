import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import { errorCode, publishFileExclusive, unlinkIfPresent, type ExclusivePublicationFs } from "../../shared/exclusive-file-publication.js";

interface QuarantineFs extends ExclusivePublicationFs {
	mkdirSync: typeof fs.mkdirSync;
	existsSync?: typeof fs.existsSync;
	openSync?: typeof fs.openSync;
	readSync?: typeof fs.readSync;
	closeSync?: typeof fs.closeSync;
}

function hashFile(file: string, fsApi: QuarantineFs): string {
	const hash = createHash("sha256");
	const open = fsApi.openSync ?? fs.openSync;
	const read = fsApi.readSync ?? fs.readSync;
	const close = fsApi.closeSync ?? fs.closeSync;
	const handle = open(file, "r");
	try {
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let offset = 0;
		while (true) {
			const count = read(handle, chunk, 0, chunk.length, offset);
			if (count === 0) break;
			hash.update(chunk.subarray(0, count));
			offset += count;
		}
	} finally {
		close(handle);
	}
	return hash.digest("hex");
}

function stableClaimId(resultPath: string): string {
	const parent = path.dirname(resultPath);
	if (path.basename(path.dirname(parent)) === ".claims") return path.basename(parent);
	return createHash("sha256").update(path.resolve(resultPath)).digest("hex").slice(0, 16);
}

/** Retain one exact claimed result without overwriting or duplicating prior evidence. */
export function quarantineResultFile(
	resultsDir: string,
	file: string,
	resultPath: string,
	fsApi: QuarantineFs = fs,
	createId: () => string = randomUUID,
): string {
	const quarantineDir = path.join(resultsDir, ".undelivered");
	fsApi.mkdirSync(quarantineDir, { recursive: true });
	const stem = path.basename(file, path.extname(file)).replace(/[^a-zA-Z0-9._-]/g, "_");
	const contentHash = hashFile(resultPath, fsApi);
	const claimId = stableClaimId(resultPath);
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const suffix = attempt === 0 ? claimId : createId();
		const destination = path.join(quarantineDir, `${stem}-${suffix}-${contentHash.slice(0, 20)}.json`);
		const publication = publishFileExclusive(resultPath, destination, fsApi);
		if (publication === "exists") {
			try {
				if (hashFile(destination, fsApi) !== contentHash) continue;
			} catch (error) {
				if (errorCode(error) === "ENOENT") continue;
				throw error;
			}
		}
		// If cleanup fails, the deterministic destination remains authoritative.
		// A retry recognizes it and retries only this unlink instead of copying again.
		unlinkIfPresent(resultPath, fsApi);
		return destination;
	}
	throw new Error(`Unable to allocate a collision-free quarantine path for '${resultPath}'`);
}
