import assert from "node:assert/strict";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { loadExtensions } from "../../packages/coding-agent/src/core/extensions/loader.js";
import { clearExtensionCache } from "../../packages/coding-agent/src/core/extensions/loader-virtual-modules.js";
import * as errors from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	makeTempDirectory,
	moduleDir,
	readText,
	removeTempDirectory,
	spawnSyncCollect,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

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

test("transformed extensions resolve the storage subpath and share host storage error classes", async () => {
	const directory = makeTempDirectory("storage-extension-");
	const entry = join(directory, "extension.ts");
	await writeFileEnsuringDir(
		entry,
		`
import { StorageUnavailableError as MainError } from "@bastani/atomic";
import { StorageUnavailableError } from "@bastani/atomic/storage";
enum State { Loaded }
export default function (pi) {
	pi.events.emit("storage-probe", { MainError, StorageUnavailableError, state: State.Loaded });
}
`,
	);
	const bus = createEventBus();
	const observations: { MainError: object; StorageUnavailableError: object; state: number }[] = [];
	bus.on("storage-probe", (value) => observations.push(value as (typeof observations)[number]));
	try {
		const loaded = await loadExtensions([entry], directory, bus);
		assert.deepEqual(loaded.errors, []);
		assert.equal(observations.length, 1);
		assert.equal(observations[0]!.StorageUnavailableError, errors.StorageUnavailableError);
		assert.equal(observations[0]!.MainError, errors.StorageUnavailableError);
		assert.equal(observations[0]!.state, 0);
	} finally {
		clearExtensionCache();
		removeTempDirectory(directory);
	}
});
