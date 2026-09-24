import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hydrateBinaryLibraryLinks,
	loadEmbeddedPostgresBinaries,
} from "../packages/workflows/src/durable/dbos-embedded-postgres.js";
import { prepareBinariesForOwner } from "../packages/workflows/src/durable/dbos-embedded-postgres-root.js";
import { type ManagedResult, RealPostgresHome, reserveListener } from "./helpers/real-postgres.js";

const TEST_CACHE_ENV = "ATOMIC_POSTGRES_TEST_RUNTIME_CACHE_DIR";
const RUNTIME_CACHE_ENV = "ATOMIC_POSTGRES_RUNTIME_CACHE_DIR";
const SUITE_ENV = [
	"HOME",
	"USERPROFILE",
	"ATOMIC_CODING_AGENT_DIR",
	"ATOMIC_MANAGED_TEST_HOME",
	"ATOMIC_POSTGRES_PORT",
	"ATOMIC_POSTGRES_RUNTIME_CACHE_DIR",
] as const;

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

export default async function setup(): Promise<() => Promise<void>> {
	const cache = mkdtempSync(join(tmpdir(), "atomic-postgres-runtime-cache-"));
	const previous = Object.fromEntries(SUITE_ENV.map((key) => [key, process.env[key]]));
	const started = performance.now();
	let home: RealPostgresHome | undefined;
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
		process.env[TEST_CACHE_ENV] = cache;
		home = new RealPostgresHome();
		const reserved = await reserveListener();
		await reserved.close();
		const managed = await home.client(reserved.port).request<ManagedResult>("ensure");
		Object.assign(process.env, {
			HOME: home.path,
			USERPROFILE: home.path,
			ATOMIC_CODING_AGENT_DIR: join(home.path, "agent"),
			ATOMIC_MANAGED_TEST_HOME: home.path,
			ATOMIC_POSTGRES_PORT: String(managed.metadata.server.port),
			ATOMIC_POSTGRES_RUNTIME_CACHE_DIR: cache,
		});
		console.log(
			`Managed PostgreSQL integration runtime prewarm and suite cluster: ${Math.round(performance.now() - started)}ms`,
		);
	} catch (error) {
		if (home) await home.cleanup();
		removeCache(cache);
		throw error;
	}
	return async () => {
		try {
			await home?.cleanup();
		} finally {
			for (const key of SUITE_ENV) {
				if (previous[key] === undefined) delete process.env[key];
				else process.env[key] = previous[key];
			}
			delete process.env[TEST_CACHE_ENV];
			const activeHomes = join(cache, ".active-homes");
			if (lstatSync(activeHomes, { throwIfNoEntry: false }) && readdirSync(activeHomes).length > 0) {
				console.warn(`Preserving managed PostgreSQL runtime cache with uncleaned test homes: ${cache}`);
			} else {
				removeCache(cache);
			}
		}
	};
}
