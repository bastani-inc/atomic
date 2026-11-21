import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { excludeUnreachableDeclarations } from "../../packages/coding-agent/scripts/unreachable-declarations.js";
import { npmSpawnPrefix, spawnSyncCollect, writeFileEnsuringDir } from "../helpers/runtime.js";

/** One `npm pack --dry-run` of a fixture package with a handful of files. */
const NPM_PACK_DRY_RUN_TIMEOUT_MS = 60_000;

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-unreachable-declarations-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

async function write(path: string, text: string): Promise<void> {
	await writeFileEnsuringDir(join(root, path), text);
}

async function writeFixturePackage(): Promise<void> {
	await write(
		"package.json",
		JSON.stringify({
			name: "fixture",
			version: "1.0.0",
			type: "module",
			files: ["dist"],
			types: "./dist/index.d.ts",
			exports: {
				".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
				"./storage": { types: "./dist/storage/index.d.ts", import: "./dist/storage/index.js" },
				"./plain": { import: "./dist/plain.js" },
				"./conditioned": { "types@>=5.0": "./dist/conditioned.d.ts", import: "./dist/conditioned-impl.js" },
			},
		}),
	);
	await write(
		"dist/index.d.ts",
		[
			'/// <reference path="./globals.d.ts" />',
			'/// <reference types="./ambient.d.ts" />',
			'/// <REFERENCE preserve="true" PATH="./preserved.d.ts" />',
			'/// <reference types="node" />',
			'export { Session } from "./session.js";',
			'export type * from "./types/index.js";',
			'export declare const inferred: import("./inferred.js").Inferred;',
			'import legacy = require("./legacy.js");',
			"export declare const old: typeof legacy;",
		].join("\n"),
	);
	await write("dist/globals.d.ts", "declare const marker: string;");
	await write("dist/ambient.d.ts", "declare const ambient: string;");
	await write("dist/preserved.d.ts", "declare const preserved: string;");
	await write("dist/conditioned.d.ts", "export declare const conditioned: number;");
	await write("dist/session.d.ts", 'import type { Row } from "./row.js";\nexport declare class Session { row: Row; }');
	await write("dist/row.d.ts", "export interface Row { id: string }");
	await write("dist/types/index.d.ts", "export type Kind = 'a' | 'b';");
	await write("dist/inferred.d.ts", "export interface Inferred { value: number }");
	await write("dist/legacy.d.ts", "export declare const value: number;");
	await write("dist/storage/index.d.ts", 'export * from "../row.js";');
	await write("dist/plain.d.ts", "export declare const plain: number;");
	await write("dist/plain.js", "export const plain = 1;");
	await write("dist/internal.d.ts", "export declare function internal(): void;");
	await write("dist/internal.d.ts.map", "{}");
	await write("dist/internal.js", "export function internal() {}");
	await write("dist/core/internal.d.ts", "export {};");
	await write("dist/session.d.ts.map", "{}");
	await write("dist/builtin/web-access/index.d.ts", "export {};");
}

test(
	"the package leaves out declarations that no exported entry reaches, and dist keeps them",
	async () => {
		await writeFixturePackage();

		assert.deepEqual(excludeUnreachableDeclarations(root), { kept: 12, excluded: 2 });
		assert.ok(existsSync(join(root, "dist/internal.d.ts")), "dist keeps every declaration for incremental builds");

		const pack = spawnSyncCollect([...npmSpawnPrefix(), "pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: root,
			timeout: NPM_PACK_DRY_RUN_TIMEOUT_MS,
		});
		assert.equal(pack.exitCode, 0, pack.stderr.toString());
		const [result] = JSON.parse(pack.stdout.toString()) as { files: { path: string }[] }[];
		const packed = (result?.files ?? []).map((file) => file.path).sort();
		assert.deepEqual(packed, [
			"dist/ambient.d.ts",
			"dist/builtin/web-access/index.d.ts",
			"dist/conditioned.d.ts",
			"dist/globals.d.ts",
			"dist/index.d.ts",
			"dist/inferred.d.ts",
			"dist/internal.js",
			"dist/legacy.d.ts",
			"dist/plain.d.ts",
			"dist/plain.js",
			"dist/preserved.d.ts",
			"dist/row.d.ts",
			"dist/session.d.ts",
			"dist/session.d.ts.map",
			"dist/storage/index.d.ts",
			"dist/types/index.d.ts",
			"package.json",
		]);
	},
	NPM_PACK_DRY_RUN_TIMEOUT_MS,
);

test("a declaration that names a missing file stops the build instead of shipping broken types", async () => {
	await write("package.json", JSON.stringify({ types: "./dist/index.d.ts" }));
	await write("dist/index.d.ts", 'export * from "./missing.js";');

	assert.throws(() => excludeUnreachableDeclarations(root), /missing\.js, which has no declaration file/);
	assert.equal(existsSync(join(root, "dist/.npmignore")), false);
});
