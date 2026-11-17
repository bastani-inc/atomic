import { constants } from "node:fs";
import * as fs from "node:fs/promises";

export interface ExclusivePublicationFs {
	link?: typeof fs.link;
	copyFile?: typeof fs.copyFile;
	unlink: typeof fs.unlink;
}

export function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
}

/** Publish an existing file without ever replacing the destination. */
export async function publishFileExclusive(
	source: string,
	destination: string,
	fsApi: ExclusivePublicationFs = fs,
): Promise<"published" | "exists"> {
	try {
		await (fsApi.link ?? fs.link)(source, destination);
		return "published";
	} catch (error) {
		const code = errorCode(error);
		if (code === "EEXIST") return "exists";
		if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP" && code !== "EXDEV") throw error;
	}
	try {
		await (fsApi.copyFile ?? fs.copyFile)(source, destination, constants.COPYFILE_EXCL);
		return "published";
	} catch (error) {
		if (errorCode(error) === "EEXIST") return "exists";
		throw error;
	}
}

export async function unlinkIfPresent(file: string, fsApi: Pick<typeof fs, "unlink"> = fs): Promise<void> {
	try {
		await fsApi.unlink(file);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}
