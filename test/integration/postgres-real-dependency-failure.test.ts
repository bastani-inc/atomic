import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { test } from "vitest";
import { RealPostgresHome } from "../helpers/real-postgres.js";
import { copyFileSync, fileExistsSync, makeDirectorySync } from "../helpers/runtime.js";

// Real runtime executables and child processes require bounded cleanup.
const REAL_POSTGRES_PROCESS_TIMEOUT_MS = 120_000;

// #3074: copy the real executables but deliberately omit their runtime libraries.
// Never rename/delete a library in an installed or shared PostgreSQL runtime.
test(
	"missing private runtime libraries fail real executable preflight without initializing data",
	async () => {
		const home = new RealPostgresHome();
		try {
			const source = home.client(5439);
			const binaries = await source.request<Record<string, string>>("binaries");
			const runtime = join(home.path, "broken-runtime");
			makeDirectorySync(join(runtime, "bin"), { recursive: true });
			for (const binary of Object.values(binaries)) copyFileSync(binary, join(runtime, "bin", basename(binary)));
			const broken = home.client(5439, { ATOMIC_POSTGRES_RUNTIME_DIR: runtime });
			await assert.rejects(broken.request("ensure"), /incomplete PostgreSQL runtime.*broken-runtime/s);
			assert.equal(fileExistsSync(join(home.path, ".atomic", "postgres", "v18", "PG_VERSION")), false);
		} finally {
			await home.cleanup();
		}
	},
	REAL_POSTGRES_PROCESS_TIMEOUT_MS,
);
