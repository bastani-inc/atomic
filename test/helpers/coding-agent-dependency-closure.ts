import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

export interface LockEntry {
	readonly name?: string;
	readonly version?: string;
	readonly resolved?: string;
	readonly integrity?: string;
	readonly link?: boolean;
	readonly hasInstallScript?: boolean;
	readonly dependencies?: Record<string, string>;
	readonly optionalDependencies?: Record<string, string>;
	readonly os?: readonly string[];
	readonly cpu?: readonly string[];
}

export interface ClosurePackage {
	readonly name: string;
	/** Where the root package-lock.json places it (a workspace path for Atomic's own packages). */
	readonly lockPath: string;
	readonly entry: LockEntry;
}

function lockPathName(lockPath: string): string {
	const index = lockPath.lastIndexOf("node_modules/");
	const rest = lockPath.slice(index + "node_modules/".length);
	const parts = rest.split("/");
	return parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

/** Node's lookup from `from`: its own node_modules, then each parent's, then the root's. */
function resolveFrom(packages: Record<string, LockEntry>, name: string, from: string): string | undefined {
	let directory = from;
	for (;;) {
		const candidate = directory ? `${directory}/node_modules/${name}` : `node_modules/${name}`;
		if (packages[candidate]) return candidate;
		if (!directory) return undefined;
		const parent = posix.dirname(directory);
		directory = parent === "." ? "" : parent;
	}
}

/**
 * The packages an install of `@bastani/atomic` gets, as the repository's package-lock.json resolves them:
 * the CLI's dependencies and optional dependencies, followed through Atomic's own workspace packages.
 * Without a published shrinkwrap a user's install resolves the same ranges itself, so a later release of a
 * dependency can replace a version listed here; this is the tree the release was tested with.
 */
export function codingAgentDependencyClosure(root = process.cwd()): ClosurePackage[] {
	const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
		packages: Record<string, LockEntry>;
	};
	const packages = lock.packages;
	const seen = new Map<string, ClosurePackage>();
	const queue: { name: string; from: string }[] = [];
	const enqueue = (entry: LockEntry, from: string) => {
		for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
			queue.push({ name, from });
		}
	};
	enqueue(packages["packages/coding-agent"]!, "packages/coding-agent");
	while (queue.length > 0) {
		const { name, from } = queue.shift()!;
		const found = resolveFrom(packages, name, from);
		if (found === undefined) {
			// An optional dependency of another platform that this lock does not carry.
			continue;
		}
		let lockPath = found;
		let entry = packages[found]!;
		if (entry.link && entry.resolved) {
			lockPath = entry.resolved;
			entry = packages[lockPath]!;
		}
		if (seen.has(lockPath)) continue;
		seen.set(lockPath, { name: entry.name ?? lockPathName(found), lockPath, entry });
		enqueue(entry, lockPath);
	}
	return [...seen.values()];
}
