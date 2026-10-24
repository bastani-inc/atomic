import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, test, vi } from "vitest";
import { resolveBrokerEntrypoint } from "../../intercom/broker/spawn.js";
import { validateInternalIntercomBrokerPath } from "../src/bun/internal-intercom-broker.js";

// A compiled binary's app.js keeps the build machine's module URL. Recreate a host where
// that build tree still exists beside the shipped executable directory.
const scratch = mkdtempSync(join(tmpdir(), "atomic-binary-build-tree-"));
const intercomSource = resolve(import.meta.dirname, "..", "..", "intercom");
function stageIntercom(builtinDir: string): void {
	const dir = join(builtinDir, "intercom");
	mkdirSync(join(dir, "broker"), { recursive: true });
	cpSync(join(intercomSource, "package.json"), join(dir, "package.json"));
	cpSync(join(intercomSource, "index.ts"), join(dir, "index.ts"));
	cpSync(join(intercomSource, "broker", "broker.ts"), join(dir, "broker", "broker.ts"));
}
const buildTree = join(scratch, "checkout", "packages", "coding-agent", "dist");
const executableDir = join(scratch, "release");
const executable = join(executableDir, "atomic");
stageIntercom(join(buildTree, "builtin"));
stageIntercom(join(executableDir, "builtin"));

vi.mock("../src/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/config.js")>()),
	isBunBinary: true,
	getPackageDir: () => executableDir,
}));
vi.mock("../src/utils/split-launcher.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/split-launcher.js")>()),
	moduleDirFromMetaUrl: () => join(buildTree, "core"),
}));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("a compiled binary starts the Intercom broker from its shipped builtin, not a surviving build tree (#3917)", async () => {
	const { getBuiltinPackagePaths } = await import("../src/core/builtin-packages.js");
	const [intercomDir] = getBuiltinPackagePaths({
		workflows: false,
		subagents: false,
		mcp: false,
		"web-access": false,
	});
	assert.equal(intercomDir, join(executableDir, "builtin", "intercom"));
	const brokerPath = resolveBrokerEntrypoint(intercomDir as string);
	assert.equal(validateInternalIntercomBrokerPath(brokerPath, executable, "linux"), brokerPath);
});
