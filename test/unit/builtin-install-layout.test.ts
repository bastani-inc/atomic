import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "vitest";
import {
	INSTALLED_EXTENSION_ENTRIES,
	requiredEntriesForBuiltin,
	SOURCE_EXTENSION_ENTRIES,
} from "../../packages/coding-agent/src/core/builtin-install-layout.ts";
import { resolveBrokerEntrypoint, resolveIntercomPackageRoot } from "../../packages/intercom/broker/spawn.ts";

describe("builtin install layout", () => {
	test("installed entries are bundles and still accept source checkouts", () => {
		for (const [dirName, sourceEntry] of Object.entries(SOURCE_EXTENSION_ENTRIES)) {
			const installed = INSTALLED_EXTENSION_ENTRIES[dirName as keyof typeof INSTALLED_EXTENSION_ENTRIES];
			assert.match(installed, /\.bundle\.mjs$/u);
			assert.deepEqual(requiredEntriesForBuiltin(dirName as keyof typeof SOURCE_EXTENSION_ENTRIES), [
				installed,
				sourceEntry,
			]);
		}
	});
});

describe("intercom package root after prebundle", () => {
	test("resolves the package root from broker/spawn.ts or an installed bundle", () => {
		const root = mkdtempSync(join(tmpdir(), "intercom-root-"));
		mkdirSync(join(root, "broker"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@bastani/intercom" }), "utf-8");
		writeFileSync(join(root, "broker", "spawn.ts"), "", "utf-8");

		assert.equal(resolveIntercomPackageRoot(pathToFileURL(join(root, "broker", "spawn.ts")).href), root);
		assert.equal(resolveIntercomPackageRoot(pathToFileURL(join(root, "index.bundle.mjs")).href), root);
		assert.equal(resolveBrokerEntrypoint(root), join(root, "broker", "broker.ts"));

		writeFileSync(join(root, "broker", "broker.bundle.mjs"), "", "utf-8");
		assert.equal(resolveBrokerEntrypoint(root), join(root, "broker", "broker.bundle.mjs"));
	});
});
