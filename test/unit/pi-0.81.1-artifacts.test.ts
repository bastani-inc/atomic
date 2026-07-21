import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const expectedIntegrity = new Map([
	["@earendil-works/pi-agent-core", "sha512-yqbh68CyhqxMov/jUogFJfMqlu2Gd37GAki+tr59YCmAPHfomiCA5ESzusXtpGzABeiZFC/OrRdQ4GwCCOMIHA=="],
	["@earendil-works/pi-ai", "sha512-hzHE7Z8l5mgJk+ke67Lge0rwS2+wbKJrFKl9o5M1R1rh33+cCT7D1AHz1OAtX5wFs90E1/BTGhyJRTUHaMxGvQ=="],
	["@earendil-works/pi-tui", "sha512-OMEe+Zt8oQYi/rCq3upxsTlIScWL0FPhXwQus34TbQb3EmTx88S7Uzx32JxvQiEeWOw8eDCdJf2PBUBE9r6wIg=="],
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

test("Pi v0.81.1 declarations and publish artifacts stay synchronized", async () => {
	let declarationCount = 0;
	for (const [workspace, names] of declarations) {
		const manifest = await Bun.file(join(root, workspace, "package.json")).json();
		assert.equal(manifest.version, "0.0.0");
		for (const name of names) {
			assert.equal(manifest.dependencies?.[name] ?? manifest.peerDependencies?.[name], "^0.81.1");
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
			assert.equal(entry.version, "0.81.1");
			assert.equal(entry.integrity, integrity);
		}
		assert.ok(bunLock.includes(`${name}@0.81.1`));
		assert.ok(bunLock.includes(integrity));
	}
	assert.equal(
		npmLock.packages["node_modules/@earendil-works/pi-agent-core"].dependencies["@earendil-works/pi-ai"],
		"^0.81.1",
	);
});
