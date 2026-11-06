import { existsSync, realpathSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

type SqliteLocation = ConstructorParameters<typeof DatabaseSync>[0];

const REMEDY =
	"Give the test its own agent directory: point ATOMIC_CODING_AGENT_DIR at a temporary directory, or pass the store an explicit temporary path";

/** A test opened a SQLite database under the real home directory's Atomic root, where the user's own journal lives. */
export class RealHomeStorageOpenError extends Error {
	override readonly name = "RealHomeStorageOpenError" as const;
	readonly code = "real-home-storage-open" as const;
	readonly hint = REMEDY;

	constructor(
		readonly path: string,
		readonly protectedRoot: string,
	) {
		super(
			`Test opened a SQLite database under the real home directory: ${path} (real-home-storage-open). ${REMEDY}.`,
		);
	}
}

export interface RealHomeStorageGuard {
	readonly roots: readonly string[];
	/** Throw the rejections since the last check, kept even when the code that opened the database caught them. */
	assertNoViolations(): void;
}

/** Where a test file registers the checks that run after each test and after its last one. */
export interface TestFileHooks {
	afterEach(check: () => void): void;
	afterAll(check: () => void): void;
}

/** Fail the test, or its file's teardown, that left a rejected real-home open behind, even one its code caught. */
export function failTestsThatOpenRealHomeStorage(guard: RealHomeStorageGuard, hooks: TestFileHooks): void {
	hooks.afterEach(() => guard.assertNoViolations());
	hooks.afterAll(() => guard.assertNoViolations());
}

/** The `.atomic` root of every home directory Atomic could resolve for this process, on Windows and POSIX alike. */
export function realHomeAtomicRoots(env: NodeJS.ProcessEnv = process.env): string[] {
	const windowsHome = env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined;
	const homes = [homedir(), env.HOME, env.USERPROFILE, windowsHome].filter(
		(home): home is string => home !== undefined && home !== "",
	);
	return [...new Set(homes.map((home) => join(home, ".atomic")))];
}

/** The file a node:sqlite location opens: a path, `file:` URL, SQLite URI filename or Buffer. In-memory is `undefined`. */
export function sqliteLocationPath(location: SqliteLocation): string | undefined {
	if (location instanceof URL) return location.protocol === "file:" ? fileURLToPath(location) : undefined;
	const text = typeof location === "string" ? location : location.toString("utf8");
	if (text === "" || text === ":memory:") return undefined;
	if (!text.startsWith("file:")) return text;
	const withoutAuthority = text.slice("file:".length).replace(/^\/\/[^/]*/u, "");
	const path = decodeURIComponent(withoutAuthority.split(/[?#]/u, 1)[0]!);
	return /^\/[A-Za-z]:/u.test(path) ? path.slice(1) : path;
}

/** Whether `platform`'s default filesystems compare names without case. */
export function foldsCase(platform: NodeJS.Platform): boolean {
	return platform === "win32" || platform === "darwin";
}

/** The absolute path with symlinks and Windows short names resolved through its nearest existing ancestor. */
function canonicalPath(path: string): string {
	const absolute = resolve(path);
	if (existsSync(absolute)) return realpathSync.native(absolute);
	const parent = dirname(absolute);
	return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
}

function contains(root: string, path: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

/** The protected root a node:sqlite location falls under, compared both as written and canonically. */
export function protectedRootOf(
	location: SqliteLocation,
	roots: readonly string[],
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const path = sqliteLocationPath(location);
	if (path === undefined) return undefined;
	const comparable = (value: string) => (foldsCase(platform) ? value.toLowerCase() : value);
	const written = comparable(resolve(path));
	const canonical = comparable(canonicalPath(path));
	return roots.find(
		(root) => contains(comparable(resolve(root)), written) || contains(comparable(canonicalPath(root)), canonical),
	);
}

const GUARD = Symbol.for("atomic.test.realHomeStorageGuard");
type GuardState = RealHomeStorageGuard & { readonly roots: string[] };
type GuardedDatabaseSync = typeof DatabaseSync & { readonly [GUARD]?: GuardState };

/**
 * Reject every node:sqlite open under `roots` in this process, before SQLite creates or opens the file.
 *
 * The constructor is replaced on the real module, as `setup-packaged-local-worker.ts` replaces `fork`, so product code
 * that loads `node:sqlite` lazily and test code that imports it are both covered. A rejection is thrown and also kept
 * for `assertNoViolations`, so a caller that catches storage failures cannot hide it. Installing again adds `roots`
 * to the guard already in place.
 */
export function installRealHomeStorageGuard(roots: readonly string[]): RealHomeStorageGuard {
	const sqlite = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: GuardedDatabaseSync };
	const guard = sqlite.DatabaseSync[GUARD] ?? guardConstructor(sqlite);
	for (const root of roots) if (!guard.roots.includes(root)) guard.roots.push(root);
	return guard;
}

function guardConstructor(sqlite: { DatabaseSync: GuardedDatabaseSync }): GuardState {
	let violations: RealHomeStorageOpenError[] = [];
	const guard: GuardState = {
		roots: [],
		assertNoViolations: () => {
			const found = violations;
			violations = [];
			if (found.length === 1) throw found[0];
			if (found.length > 1) throw new AggregateError(found, `${found.length} real-home SQLite opens were rejected`);
		},
	};
	const guarded = new Proxy(sqlite.DatabaseSync, {
		construct(target, args: ConstructorParameters<typeof DatabaseSync>, newTarget) {
			const root = protectedRootOf(args[0], guard.roots);
			if (root !== undefined) {
				const error = new RealHomeStorageOpenError(sqliteLocationPath(args[0])!, root);
				violations.push(error);
				throw error;
			}
			return Reflect.construct(target, args, newTarget);
		},
		get: (target, key, receiver) => (key === GUARD ? guard : Reflect.get(target, key, receiver)),
	});
	Object.defineProperty(sqlite, "DatabaseSync", {
		value: guarded,
		configurable: true,
		enumerable: true,
		writable: true,
	});
	syncBuiltinESMExports();
	return guard;
}
