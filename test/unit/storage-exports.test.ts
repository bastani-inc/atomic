import assert from "node:assert/strict";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { test } from "vitest";
import * as errors from "../../packages/coding-agent/src/core/storage/errors.js";
import { moduleDir, readText, spawnSyncCollect } from "../helpers/runtime.js";

const root = join(moduleDir(import.meta.url), "../..");

test("portable storage modules do not import Node modules", async () => {
	const pending = ["database", "errors", "prefix", "schema"].map((name) =>
		join(root, "packages/coding-agent/src/core/storage", `${name}.ts`),
	);
	const visited = new Set<string>();
	while (pending.length) {
		const path = pending.pop();
		assert.ok(path);
		if (visited.has(path)) continue;
		visited.add(path);
		const ast = parse(await readText(path), { sourceType: "module", plugins: ["typescript"] });
		for (const statement of ast.program.body) {
			if (
				statement.type !== "ImportDeclaration" &&
				statement.type !== "ExportAllDeclaration" &&
				statement.type !== "ExportNamedDeclaration"
			)
				continue;
			const fileName = statement.source?.value;
			if (fileName === undefined) continue;
			assert.equal(fileName.startsWith("node:"), false, `${path}: ${fileName}`);
			if (fileName.startsWith(".")) pending.push(join(path, "..", fileName.replace(/\.js$/, ".ts")));
		}
	}
});

test("storage errors preserve typed fields and cause identity", () => {
	const cause = new errors.StorageError("fixture failure");
	const descriptor = { adapter: "example", location: "raw location" };
	const cases = [
		[new errors.StorageUnavailableError(descriptor, cause), { ...descriptor, cause }],
		[new errors.StoreClosedError(descriptor), descriptor],
		[new errors.StorageTransactionClosedError(), {}],
		[new errors.StorageRollbackError(cause, cause), { cause, rollbackCause: cause }],
		[new errors.StorageInvalidTextError(1), { parameterIndex: 1, reason: "nul-character" }],
		[new errors.StorageSchemaVersionError("domain", 9, 1), { domain: "domain", found: 9, supported: 1 }],
		[new errors.StoragePrefixError("a-", "pattern"), { prefix: "a-", reason: "pattern" }],
		[
			new errors.StorageConfigError("settings", "field", "reason"),
			{ source: "settings", field: "field", reason: "reason" },
		],
		[new errors.StorageAdapterLoadError("module", cause), { module: "module", cause }],
		[new errors.StorageOutcomeUnknownError("domain", "id", "key"), { domain: "domain", id: "id", key: "key" }],
		[new errors.StoragePayloadTooLargeError(1, 2), { limitBytes: 1, actualBytes: 2 }],
	] as const;
	for (const [error, fields] of cases) {
		assert.ok(error instanceof errors.StorageError);
		assert.equal(error.name, error.constructor.name);
		for (const [key, value] of Object.entries(fields)) assert.equal(Reflect.get(error, key), value);
	}
});

test("built package exposes the same storage classes through main and storage subpaths", () => {
	const result = spawnSyncCollect(
		[
			process.execPath,
			"--input-type=module",
			"-e",
			`
		import assert from 'node:assert/strict';
		import * as main from '@bastani/atomic';
		import * as storage from '@bastani/atomic/storage';
		import { registerSqliteDatabaseConformance } from '@bastani/atomic/storage/testing';
		assert.equal(typeof registerSqliteDatabaseConformance, 'function');
		for (const [name, value] of Object.entries(storage)) assert.equal(main[name], value, name);
		const database = await storage.openNodeSqliteDatabase(':memory:');
		assert.deepEqual(await database.get('SELECT ? AS value', 9007199254740992n), {value: 9007199254740992n});
		await database.close();
		await assert.rejects(database.get('SELECT 1'), storage.StoreClosedError);
	`,
		],
		{ cwd: join(root, "packages/coding-agent") },
	);
	assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
});
