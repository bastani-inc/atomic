/**
 * Session artifact storage, mirrored from oh-my-pi's
 * `packages/coding-agent/src/session/artifacts.ts` at 15b5c1397fc.
 *
 * Artifacts are persisted as `<numericId>.<toolType>.log` files inside a
 * session artifacts directory. IDs are sequential and scan-initialized from
 * existing files so a resumed session keeps a contiguous id space. Subagents
 * that share a session dir share the same manager/id space.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./path-utils.ts";

export interface AllocatedArtifact {
	path: string;
	id: string;
}

export class ArtifactManager {
	#nextId = 0;
	readonly #dir: string;
	#initialized: Promise<void> | undefined;

	constructor(dir: string) {
		this.#dir = dir;
	}

	get dir(): string {
		return this.#dir;
	}

	#init(): Promise<void> {
		this.#initialized ??= (async () => {
			let max = -1;
			if (await pathExists(this.#dir)) {
				for (const name of await readdir(this.#dir)) {
					const match = name.match(/^(\d+)\..*\.log$/);
					if (match) {
						const id = Number.parseInt(match[1] ?? "0", 10);
						if (id > max) max = id;
					}
				}
			}
			this.#nextId = max + 1;
		})();
		return this.#initialized;
	}

	async allocate(toolType: string): Promise<AllocatedArtifact> {
		await this.#init();
		const id = String(this.#nextId++);
		const path = join(this.#dir, `${id}.${toolType}.log`);
		return { path, id };
	}

	async save(content: string, toolType: string): Promise<string> {
		const { path, id } = await this.allocate(toolType);
		if (!(await pathExists(this.#dir))) await mkdir(this.#dir, { recursive: true });
		await writeFile(path, content, "utf8");
		return id;
	}

	/** Resolve a numeric id to its artifact file path, matching by `${id}.` prefix. */
	async resolve(id: string): Promise<string | undefined> {
		await this.#init();
		if (!(await pathExists(this.#dir))) return undefined;
		const prefix = `${id}.`;
		for (const name of await readdir(this.#dir))
			if (name.startsWith(prefix) && name.endsWith(".log")) return join(this.#dir, name);
		return undefined;
	}

	async list(): Promise<string[]> {
		await this.#init();
		if (!(await pathExists(this.#dir))) return [];
		const ids: number[] = [];
		for (const name of await readdir(this.#dir)) {
			const match = name.match(/^(\d+)\..*\.log$/);
			if (match) ids.push(Number.parseInt(match[1] ?? "0", 10));
		}
		return ids.sort((a, b) => a - b).map(String);
	}
}

const managers = new Map<string, ArtifactManager>();

/** Returns a shared ArtifactManager for a session artifacts dir (cached per dir). */
export function getArtifactManager(artifactsDir: string): ArtifactManager {
	let manager = managers.get(artifactsDir);
	if (!manager) {
		manager = new ArtifactManager(artifactsDir);
		managers.set(artifactsDir, manager);
	}
	return manager;
}

export function resetArtifactManagerCache(): void {
	managers.clear();
}
