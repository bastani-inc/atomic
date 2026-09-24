import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hydrateBinaryLibraryLinks,
	loadEmbeddedPostgresBinaries,
} from "../packages/workflows/src/durable/dbos-embedded-postgres.js";
import { prepareBinariesForOwner } from "../packages/workflows/src/durable/dbos-embedded-postgres-root.js";

const TEST_CACHE_ENV = "ATOMIC_POSTGRES_TEST_RUNTIME_CACHE_DIR";
const RUNTIME_CACHE_ENV = "ATOMIC_POSTGRES_RUNTIME_CACHE_DIR";

function removeCache(path: string): void {
	const unseal = (entry: string): void => {
		const stat = lstatSync(entry, { throwIfNoEntry: false });
		if (!stat || stat.isSymbolicLink()) return;
		chmodSync(entry, stat.isDirectory() ? 0o700 : 0o600);
		if (stat.isDirectory()) for (const child of readdirSync(entry)) unseal(join(entry, child));
	};
	unseal(path);
	rmSync(path, { recursive: true, force: true });
}

export default async function setup(): Promise<() => void> {
	const cache = mkdtempSync(join(tmpdir(), "atomic-postgres-runtime-cache-"));
	const previous = process.env[RUNTIME_CACHE_ENV];
	const started = performance.now();
	try {
		process.env[RUNTIME_CACHE_ENV] = cache;
		const binaries = await loadEmbeddedPostgresBinaries({ readOnly: true });
		hydrateBinaryLibraryLinks(binaries.pg_ctl);
		await prepareBinariesForOwner(binaries, {
			baseDir: cache,
			runAsOwner: async () => {
				throw new Error("Postgres runtime prewarm must not run database commands");
			},
		});
		console.log(`Managed PostgreSQL integration runtime prewarm: ${Math.round(performance.now() - started)}ms`);
	} catch (error) {
		removeCache(cache);
		throw error;
	} finally {
		if (previous === undefined) delete process.env[RUNTIME_CACHE_ENV];
		else process.env[RUNTIME_CACHE_ENV] = previous;
	}
	process.env[TEST_CACHE_ENV] = cache;
	return () => {
		delete process.env[TEST_CACHE_ENV];
		const activeHomes = join(cache, ".active-homes");
		if (lstatSync(activeHomes, { throwIfNoEntry: false }) && readdirSync(activeHomes).length > 0) {
			console.warn(`Preserving managed PostgreSQL runtime cache with uncleaned test homes: ${cache}`);
			return;
		}
		removeCache(cache);
	};
}
