import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const expectedIntegrity = new Map([
	["@earendil-works/pi-agent-core", "sha512-nwnOR3SuLYGRFfyQm8ri4Nj5VGVAvAM9GuqQd3u7BUQj0d6hmD2F8w7OHAAjThE3CuySIdM+v8E22QJG6/RfCg=="],
	["@earendil-works/pi-ai", "sha512-Moe/H8c87yacDGK9dPbWphZNjVsrb3nTrIHycOQJAkFEnY9PYxOOd74+ny44kATfPU9Dm7aTHefar3pZF+UKUA=="],
	["@earendil-works/pi-tui", "sha512-c2JO29PbhKPEQ6fgHQKAl0WhwuFqzWfzspMmP+8B5tpDuP+0mvarRbKKg8gq4b+pQx/QX+6aVS4ko7deoyjQjg=="],
]);

const declarations = new Map([
	["packages/coding-agent", ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]],
	["packages/cursor", ["@earendil-works/pi-ai"]],
	["packages/intercom", ["@earendil-works/pi-tui"]],
	["packages/mcp", ["@earendil-works/pi-ai", "@earendil-works/pi-tui"]],
	["packages/subagents", ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]],
	["packages/web-access", ["@earendil-works/pi-tui"]],
	["packages/workflows", ["@earendil-works/pi-tui"]],
]);

test("Pi v0.80.10 declarations and publish artifacts stay synchronized", async () => {
	let declarationCount = 0;
	for (const [workspace, names] of declarations) {
		const manifest = await Bun.file(join(root, workspace, "package.json")).json();
		assert.equal(manifest.version, "0.0.0");
		for (const name of names) {
			assert.equal(manifest.dependencies?.[name] ?? manifest.peerDependencies?.[name], "^0.80.10");
			declarationCount++;
		}
	}
	assert.equal(declarationCount, 12);

	for (const [workspace, names] of declarations) {
		if (workspace === "packages/coding-agent") continue;
		const source = await Bun.file(join(root, workspace, "package.json")).json();
		const builtinName = workspace.slice("packages/".length);
		const generated = await Bun.file(
			join(root, "packages/coding-agent/dist/builtin", builtinName, "package.json"),
		).json();
		assert.equal(generated.version, source.version);
		for (const name of names) {
			assert.equal(
				generated.dependencies?.[name] ?? generated.peerDependencies?.[name],
				source.dependencies?.[name] ?? source.peerDependencies?.[name],
			);
		}
	}

	const npmLock = await Bun.file(join(root, "package-lock.json")).json();
	const shrinkwrap = await Bun.file(join(root, "packages/coding-agent/npm-shrinkwrap.json")).json();
	const bunLock = await Bun.file(join(root, "bun.lock")).text();
	for (const [name, integrity] of expectedIntegrity) {
		for (const lock of [npmLock, shrinkwrap]) {
			const entry = lock.packages[`node_modules/${name}`];
			assert.equal(entry.version, "0.80.10");
			assert.equal(entry.integrity, integrity);
		}
		assert.ok(bunLock.includes(`${name}@0.80.10`));
		assert.ok(bunLock.includes(integrity));
	}
	assert.equal(
		npmLock.packages["node_modules/@earendil-works/pi-agent-core"].dependencies["@earendil-works/pi-ai"],
		"^0.80.10",
	);
});
