/**
 * The APIs that block the calling thread until I/O, a child process, a lock or a timed wait finishes. A call that
 * resolves to one of these declarations, reached from an interactive entry point, freezes the terminal for as long as
 * it takes: nothing else runs on that event loop meanwhile, not input, not rendering, not streaming.
 */

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
	/** How the API reads in a report, such as `fs.readFileSync`. */
	readonly label: string;
}

/** The declaration a call resolved to, outside the analyzed sources. */
export interface ExternalDeclaration {
	/** The declaring file's path, with forward slashes. */
	readonly path: string;
	/** The declared name. */
	readonly name: string;
	/** The enclosing class or interface name, when the declaration is a member. */
	readonly owner: string | undefined;
}

const NODE_TYPES = "/node_modules/@types/node/";
const BUN_TYPES = "/node_modules/bun-types/";

/**
 * Synchronous exports of `@bastani/atomic-natives` that wait on the file system, a lock or another process. Its
 * in-memory supervisor calls return at once and are not listed.
 */
const BLOCKING_NATIVE_FUNCTIONS = new Set([
	"tryAdvisoryLock",
	"renameNoReplace",
	"processCreationTime",
	"containProcessTree",
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

/** The blocking API a declaration is, or undefined when calling it does not block. */
export function classifyExternalDeclaration(declaration: ExternalDeclaration): BlockingApi | undefined {
	const { path, name, owner } = declaration;
	const nodeFile = nodeModuleFile(path);
	if (nodeFile !== undefined) {
		const module = nodeFile.replace(/\.d\.ts$/, "");
		if ((module === "fs" || module === "fs/promises") && name.endsWith("Sync")) {
			return { category: "fs-sync", label: `fs.${name}` };
		}
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

/**
 * A call whose callee could not be resolved to a declaration (a destructured dynamic import, a parameter) but whose
 * name says it is a synchronous variant of an asynchronous API.
 */
export function classifyUnresolvedCallName(name: string): BlockingApi | undefined {
	if (/^[a-z][A-Za-z0-9]*Sync$/.test(name)) return { category: "fs-sync", label: `${name} (unresolved)` };
	return undefined;
}

/** Global clocks a busy-wait loop polls. */
export const CLOCK_READS = new Set([
	"Date.now",
	"performance.now",
	"process.hrtime",
	"process.hrtime.bigint",
	"hrtime.bigint",
]);
