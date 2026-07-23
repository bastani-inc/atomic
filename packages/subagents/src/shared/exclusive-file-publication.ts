import * as fs from "node:fs";

export interface ExclusivePublicationFs {
	linkSync?: typeof fs.linkSync;
	copyFileSync?: typeof fs.copyFileSync;
	unlinkSync: typeof fs.unlinkSync;
}

export function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
}

/** Publish an existing file without ever replacing the destination. */
export function publishFileExclusive(
	source: string,
	destination: string,
	fsApi: ExclusivePublicationFs = fs,
): "published" | "exists" {
	try {
		(fsApi.linkSync ?? fs.linkSync)(source, destination);
		return "published";
	} catch (error) {
		const code = errorCode(error);
		if (code === "EEXIST") return "exists";
		if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP" && code !== "EXDEV") throw error;
	}
	try {
		(fsApi.copyFileSync ?? fs.copyFileSync)(source, destination, fs.constants.COPYFILE_EXCL);
		return "published";
	} catch (error) {
		if (errorCode(error) === "EEXIST") return "exists";
		throw error;
	}
}

export function unlinkIfPresent(file: string, fsApi: Pick<typeof fs, "unlinkSync"> = fs): void {
	try {
		fsApi.unlinkSync(file);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}
