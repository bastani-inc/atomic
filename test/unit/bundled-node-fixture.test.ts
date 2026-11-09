import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { useBundledNodeFixture } from "../helpers/bundled-node-fixture.js";
import {
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const directory = makeTempDirectory("bundled-node-fixture-test-");
const source = join(directory, "fixture.ts");
const bundles: string[] = [];

afterAll(() => {
	for (const bundle of bundles) removeTempDirectory(dirname(bundle));
	removeTempDirectory(directory);
});

beforeAll(async () => {
	await writeFileEnsuringDir(
		source,
		'import { Type } from "typebox"; const environment: string = process.env.NODE_ENV ?? "missing"; console.log(JSON.stringify({ environment, type: Type.Object({}).type }));',
	);
});

describe("fixture owners", () => {
	const getFixture = useBundledNodeFixture(source);
	const getRemovedFixture = useBundledNodeFixture(source);
	const unusedFixture = useBundledNodeFixture(join(directory, "unused.ts"));

	test("concurrent requests reuse a Node fixture with external packages under the ignored cache", async () => {
		const [first, second] = await Promise.all([getFixture(), getFixture()]);
		bundles.push(first);
		assert.equal(first, second);
		assert.ok(first.startsWith(`${join(ROOT, "node_modules", ".cache")}${sep}`));
		const child = spawnSyncCollect([process.execPath, first], {
			env: { ...process.env, NODE_ENV: "fixture-node-environment" },
		});
		assert.equal(child.exitCode, 0, child.stderr.toString());
		assert.deepEqual(JSON.parse(child.stdout.toString()), {
			environment: "fixture-node-environment",
			type: "object",
		});
	});

	test("cleanup accepts a fixture directory removed before teardown", async () => {
		const bundle = await getRemovedFixture();
		bundles.push(bundle);
		removeTempDirectory(dirname(bundle));
		getRemovedFixture.dispose();
		unusedFixture.dispose();
	});
});

test("the owning suite removes its bundled fixtures at teardown", () => {
	assert.equal(bundles.length, 2);
	for (const bundle of bundles) assert.equal(existsSync(dirname(bundle)), false);
});
