import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";

export const optionCases: readonly (readonly [string, SqliteValue | boolean])[] = [
	["null", null],
	["nan", NaN],
	["infinity", Infinity],
	["negative-infinity", -Infinity],
	["zero", 0],
	["negative-zero", -0],
	["one", 1],
	["bigint-zero", 0n],
	["bigint-one", 1n],
	["string-zero", "0"],
	["string-nan", "NaN"],
	["string-infinity", "Infinity"],
	["false", false],
	["true", true],
	["bytes-empty", new Uint8Array()],
	["bytes-zero", new Uint8Array([0])],
	["bytes-one", new Uint8Array([1])],
];

export default {
	atomicStorageAdapter: 1,
	async openDatabase(options) {
		assert.equal(typeof options.root, "string");
		const actual = options.value;
		const selected = optionCases.find(([, value]) =>
			value instanceof Uint8Array && actual instanceof Uint8Array
				? value.length === actual.length && value.every((byte, index) => byte === actual[index])
				: Object.is(value, actual),
		);
		assert.ok(selected);
		await appendFile(join(String(options.root), "opens.txt"), `${selected[0]}\n`);
		return openNodeSqliteDatabase(join(String(options.root), `${selected[0]}.sqlite`));
	},
} satisfies StorageAdapterModule;
