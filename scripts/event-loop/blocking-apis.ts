export type BlockingCategory =
	| "fs-sync"
	| "child-process-sync"
	| "crypto-sync"
	| "zlib-sync"
	| "sqlite-sync"
	| "atomics-wait"
	| "native-sync"
	| "library-sync"
	| "busy-wait";

export interface BlockingApi {
	readonly category: BlockingCategory;
	readonly label: string;
}

export interface ExternalDeclaration {
	readonly path: string;
	readonly name: string;
	readonly owner: string | undefined;
}

const NODE_TYPES = "/node_modules/@types/node/";
const BUN_TYPES = "/node_modules/bun-types/";

const BLOCKING_NATIVE_FUNCTIONS = new Set([
	"tryAdvisoryLock",
	"trySharedAdvisoryLock",
	"renameNoReplace",
	"killSupervisedProcessTrees",
]);

const NODE_SQLITE_MEMBERS = new Set(["exec", "prepare", "run", "get", "all", "iterate", "open", "close", "backup"]);
const BUN_SQLITE_MEMBERS = new Set(["exec", "run", "query", "prepare", "get", "all", "values", "iterate", "close"]);

function nodeModuleFile(path: string): string | undefined {
	const index = path.lastIndexOf(NODE_TYPES);
	return index === -1 ? undefined : path.slice(index + NODE_TYPES.length);
}

function bunTypesFile(path: string): string | undefined {
	const index = path.lastIndexOf(BUN_TYPES);
	return index === -1 ? undefined : path.slice(index + BUN_TYPES.length);
}

function isTypeScriptLib(path: string): boolean {
	return /(^|\/)lib\.[a-z0-9.]+\.d\.ts$/i.test(path);
}

export function classifyExternalDeclaration(declaration: ExternalDeclaration): BlockingApi | undefined {
	const { path, name, owner } = declaration;
	const nodeFile = nodeModuleFile(path);
	if (nodeFile !== undefined) {
		const module = nodeFile.replace(/\.d\.ts$/, "");
		if ((module === "fs" || module === "fs/promises") && name.endsWith("Sync")) {
			return { category: "fs-sync", label: `fs.${name}` };
		}
		if (module === "fs" && owner?.endsWith("Sync")) return { category: "fs-sync", label: `fs.${owner}.${name}` };
		if (module === "child_process" && (name === "execSync" || name === "execFileSync" || name === "spawnSync")) {
			return { category: "child-process-sync", label: `child_process.${name}` };
		}
		if (module === "crypto" && name.endsWith("Sync")) return { category: "crypto-sync", label: `crypto.${name}` };
		if (module === "zlib" && name.endsWith("Sync")) return { category: "zlib-sync", label: `zlib.${name}` };
		if (module === "sqlite") {
			if (name === "DatabaseSync") return { category: "sqlite-sync", label: "new DatabaseSync" };
			if ((owner === "DatabaseSync" || owner === "StatementSync") && NODE_SQLITE_MEMBERS.has(name)) {
				return { category: "sqlite-sync", label: `${owner}.${name}` };
			}
		}
		return undefined;
	}
	const bunFile = bunTypesFile(path);
	if (bunFile !== undefined) {
		if (name === "spawnSync" || name === "sleepSync") return { category: "child-process-sync", label: `Bun.${name}` };
		if (
			bunFile.startsWith("sqlite") &&
			(owner === "Database" || owner === "Statement") &&
			BUN_SQLITE_MEMBERS.has(name)
		) {
			return { category: "sqlite-sync", label: `bun:sqlite ${owner}.${name}` };
		}
		if (bunFile.startsWith("sqlite") && name === "Database")
			return { category: "sqlite-sync", label: "new bun:sqlite Database" };
		return undefined;
	}
	if (isTypeScriptLib(path)) {
		if (owner === "Atomics" && (name === "wait" || name === "pause"))
			return { category: "atomics-wait", label: `Atomics.${name}` };
		return undefined;
	}
	if (path.endsWith("/packages/natives/native/index.d.ts") || path.includes("/@bastani/atomic-natives/")) {
		return BLOCKING_NATIVE_FUNCTIONS.has(name) ? { category: "native-sync", label: `natives.${name}` } : undefined;
	}
	if (path.includes("/node_modules/") && (name.endsWith("Sync") || name === "sync")) {
		const pkg = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1] ?? "library";
		return { category: "library-sync", label: `${pkg}.${owner ? `${owner}.` : ""}${name}` };
	}
	return undefined;
}

export function classifyUnresolvedCallName(name: string): BlockingApi | undefined {
	if (/^[a-z][A-Za-z0-9]*Sync$/.test(name)) return { category: "fs-sync", label: `${name} (unresolved)` };
	return undefined;
}

export const CLOCK_READS = new Set([
	"Date.now",
	"performance.now",
	"process.hrtime",
	"process.hrtime.bigint",
	"hrtime.bigint",
]);
