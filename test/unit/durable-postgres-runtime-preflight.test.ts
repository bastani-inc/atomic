import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";

// No actual server or database is contacted by this regression.
vi.mock("../../packages/workflows/src/durable/local-command.js", async (original) => ({
	...(await original<typeof import("../../packages/workflows/src/durable/local-command.js")>()),
	tcpReachable: async () => true,
}));

import { ensureEmbeddedDbosPostgres } from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";

// #3073: a server surviving an upgrade must not conceal an incomplete installation.
test("rejects an incomplete runtime even when the shared server is reachable", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-pg-preflight-"));
	const previous = process.env.ATOMIC_POSTGRES_RUNTIME_DIR;
	try {
		mkdirSync(join(root, "bin"));
		for (const name of ["postgres", "pg_ctl", "initdb"]) {
			writeFileSync(join(root, "bin", `${name}${process.platform === "win32" ? ".exe" : ""}`), "fixture");
		}
		writeFileSync(join(root, "pg-symlinks.json"), "{broken");
		process.env.ATOMIC_POSTGRES_RUNTIME_DIR = root;
		await assert.rejects(ensureEmbeddedDbosPostgres(), /incomplete PostgreSQL runtime/u);
	} finally {
		if (previous === undefined) delete process.env.ATOMIC_POSTGRES_RUNTIME_DIR;
		else process.env.ATOMIC_POSTGRES_RUNTIME_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
