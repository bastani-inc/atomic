/** Private, exclusively created tool output files in this process's scratch directory. */
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getRuntimeScratchDirSync, writeInRuntimeScratch } from "../config-runtime-scratch.ts";

const OUTPUT_FILE_MODE = 0o600;

function createOutputFilePath(dir: string, prefix: string, extension: string): string {
	return join(dir, `${prefix}-${randomBytes(8).toString("hex")}${extension}`);
}

export async function writeOutputFile(prefix: string, extension: string, data: string | Uint8Array): Promise<string> {
	return writeInRuntimeScratch(async (dir) => {
		const path = createOutputFilePath(dir, prefix, extension);
		await writeFile(path, data, { mode: OUTPUT_FILE_MODE, flag: "wx" });
		return path;
	});
}

export function createOutputFileStream(prefix: string, extension: string): { path: string; stream: WriteStream } {
	const path = createOutputFilePath(getRuntimeScratchDirSync(), prefix, extension);
	return { path, stream: createWriteStream(path, { mode: OUTPUT_FILE_MODE, flags: "wx" }) };
}
