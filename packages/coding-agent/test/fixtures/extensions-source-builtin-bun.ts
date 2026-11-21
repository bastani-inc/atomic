import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Under Bun, Atomic's own packages in a source checkout import TypeBox from the host's copy, so the loader lets Bun
// import them itself, as before it transformed every extension: nothing of theirs is transformed or stored.
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-bun-source-builtin-"));
const agentDir = path.join(root, "agent");
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
fs.mkdirSync(agentDir);

const filesBelow = (dir: string): string[] =>
	fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => /\.[cm]?js$/.test(name)) : [];

try {
	const { clearExtensionCache, loadExtensionModule, prepareExtensionEntries, useExtensionCacheCwd } = await import(
		"../../src/core/extensions/loader-virtual-modules.ts"
	);
	const { getExtensionTranspileCacheDir } = await import("../../src/config.ts");
	const entry = path.resolve(import.meta.dirname, "../../../web-access/index.ts");
	const token = useExtensionCacheCwd(root, agentDir);
	try {
		await prepareExtensionEntries([entry], token, agentDir);
		const factory = await loadExtensionModule(entry, token, agentDir);
		assert.equal(typeof factory, "function");
		assert.deepEqual(filesBelow(getExtensionTranspileCacheDir(agentDir)), []);

		// An extension of the user's own is still transformed and stored, so the cache is where transforms go.
		const own = path.join(root, "own.ts");
		fs.writeFileSync(own, "export default function () {}\n");
		assert.equal(typeof (await loadExtensionModule(own, token, agentDir)), "function");
		const deadline = Date.now() + 10_000;
		while (filesBelow(getExtensionTranspileCacheDir(agentDir)).length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.notDeepEqual(filesBelow(getExtensionTranspileCacheDir(agentDir)), []);
	} finally {
		clearExtensionCache();
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
process.exit(0);
