/**
 * artifact:// protocol resolution, mirrored from oh-my-pi's
 * `packages/coding-agent/src/internal-urls/artifact-protocol.ts` at 15b5c1397fc.
 *
 * `artifact://<numericId>` resolves to an artifact file by matching the
 * `${id}.` prefix. The calling session's artifacts dir is searched first,
 * then any other registered active dirs (so subagents can see parent
 * artifacts). Artifacts are immutable reads.
 */
import { readFile } from "node:fs/promises";
import { getArtifactManager } from "./artifacts.ts";
import { pathExists } from "./path-utils.ts";
import type { InternalResourceRouter } from "./resource-selectors.ts";

const activeArtifactDirs = new Set<string>();

export function registerArtifactDir(dir: string): void {
	activeArtifactDirs.add(dir);
}

export function unregisterArtifactDir(dir: string): void {
	activeArtifactDirs.delete(dir);
}

export function artifactIdFromUrl(url: string): string | undefined {
	const match = url.match(/^artifact:\/\/([^/]+)/i);
	return match?.[1];
}

function isValidId(id: string): boolean {
	return /^\d+$/.test(id);
}

/** Resolve an artifact:// url to a backing file path across known dirs. */
export async function resolveArtifactUrl(url: string, pinnedDirs: readonly string[] = []): Promise<string | undefined> {
	const id = artifactIdFromUrl(url);
	if (id === undefined) throw new Error("artifact:// URL requires a numeric ID: artifact://0");
	if (!isValidId(id)) throw new Error(`artifact:// ID must be numeric, got: ${id}`);
	const ordered = [...pinnedDirs, ...activeArtifactDirs];
	const seen = new Set<string>();
	for (const dir of ordered) {
		if (seen.has(dir)) continue;
		seen.add(dir);
		const resolved = await getArtifactManager(dir).resolve(id);
		if (resolved) return resolved;
	}
	const available: string[] = [];
	for (const dir of new Set([...pinnedDirs, ...activeArtifactDirs]))
		available.push(...(await getArtifactManager(dir).list()));
	throw new Error(`Artifact ${id} not found. Available: ${available.join(", ") || "none"}`);
}

/** Build an InternalResourceRouter that resolves/reads artifact:// urls. */
export function createArtifactRouter(getPinnedDirs: () => readonly string[]): InternalResourceRouter {
	return {
		resolve: async (url) => {
			if (!/^artifact:\/\//i.test(url)) return undefined;
			try {
				return await resolveArtifactUrl(url, getPinnedDirs());
			} catch {
				return undefined;
			}
		},
		read: async (url) => {
			if (!/^artifact:\/\//i.test(url)) return undefined;
			const path = await resolveArtifactUrl(url, getPinnedDirs());
			if (!path || !(await pathExists(path))) throw new Error(`Artifact not found: ${url}`);
			return readFile(path, "utf8");
		},
	};
}

/** Resolve and read an artifact directly from a context's artifact dirs. */
export async function readArtifactUrl(url: string, dirs: readonly string[] = []): Promise<string> {
	const path = await resolveArtifactUrl(url, dirs);
	if (!path || !(await pathExists(path))) throw new Error(`Artifact not found: ${url}`);
	return readFile(path, "utf8");
}
