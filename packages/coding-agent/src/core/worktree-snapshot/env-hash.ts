import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SnapshotBlob } from "./types.ts";

/** Root-relative files whose content decides a checkout's installed dependencies and toolchain. */
export const ENVIRONMENT_INPUT_FILES: readonly string[] = Object.freeze(
	[
		".devcontainer.json",
		".devcontainer/Dockerfile",
		".devcontainer/devcontainer.json",
		".mise.toml",
		".node-version",
		".nvmrc",
		".python-version",
		".tool-versions",
		"Cargo.lock",
		"Gemfile.lock",
		"Pipfile.lock",
		"bun.lock",
		"bun.lockb",
		"composer.lock",
		"flake.lock",
		"go.sum",
		"mise.toml",
		"npm-shrinkwrap.json",
		"package-lock.json",
		"pnpm-lock.yaml",
		"poetry.lock",
		"rust-toolchain",
		"rust-toolchain.toml",
		"uv.lock",
		"yarn.lock",
	].sort(),
);

export function sha256Hex(data: Uint8Array | string): string {
	return createHash("sha256").update(data).digest("hex");
}

export function snapshotBlob(data: Uint8Array): SnapshotBlob {
	return { hash: sha256Hex(data), data };
}

/** SHA-256 over each present input's path and content hash, so equal dependency inputs give equal hashes anywhere. */
export async function computeEnvironmentHash(root: string): Promise<string> {
	const hash = createHash("sha256").update("atomic-env-v1\n");
	for (const path of ENVIRONMENT_INPUT_FILES) {
		let content: Buffer;
		try {
			content = await readFile(join(root, path));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") continue;
			throw error;
		}
		hash.update(`${path}\0${sha256Hex(content)}\n`);
	}
	return hash.digest("hex");
}
