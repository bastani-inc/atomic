import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Exercise Bun's real first-load -> transformed reload transition on every OS,
// selecting only the loader's Windows branch (not native bindings or path APIs).
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const platform = process.platform;
Object.defineProperty(process, "platform", {
	configurable: true,
	get: () => (new Error().stack?.includes("loader-virtual-modules") ? "win32" : platform),
});
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-host-alias-"));
process.env.ATOMIC_CODING_AGENT_DIR = path.join(root, "agent");
fs.mkdirSync(process.env.ATOMIC_CODING_AGENT_DIR);

try {
	const { loadExtensionModule, clearExtensionCache, useExtensionCacheCwd, readExtensionGraphManifest } = await import(
		"../../src/core/extensions/loader-virtual-modules.ts"
	);
	const { loadExtensionFromFactory, createExtensionRuntime } = await import("../../src/core/extensions/loader.ts");
	const { SessionManager, createEventBus } = await import("../../src/index.ts");
	// Make both supported packages resolvable to the real host for native import().
	// Transformed reload must retain that identity via the host registry, rather
	// than re-evaluating the compatibility alias's filesystem target through jiti.
	for (const name of ["@bastani/atomic", "@earendil-works/pi-coding-agent"]) {
		const packageDir = path.join(root, "node_modules", name);
		fs.mkdirSync(packageDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name, type: "module", exports: "./index.js" }),
		);
		fs.writeFileSync(
			path.join(packageDir, "index.js"),
			`export { SessionManager } from ${JSON.stringify(new URL("../../src/index.ts", import.meta.url).href)};\n`,
		);
	}
	const entry = path.join(root, "extension.ts");
	const leaf = path.join(root, "leaf.ts");
	fs.writeFileSync(
		entry,
		`import { SessionManager } from "@bastani/atomic";
import { SessionManager as CompatSessionManager } from "@earendil-works/pi-coding-agent";
import { value } from "./helper.js";
export default function (pi) {
	pi.events.emit("host-alias-probe", {
		SessionManager, CompatSessionManager, value,
		session: SessionManager.inMemory(), compatSession: CompatSessionManager.inMemory(),
	});
}
`,
	);
	fs.writeFileSync(path.join(root, "helper.ts"), 'export { value } from "./leaf.js";\n');
	const bus = createEventBus();
	const observations: object[] = [];
	const liveSession = SessionManager.inMemory();
	bus.on("host-alias-probe", (data) => {
		const observed = data as {
			SessionManager: typeof SessionManager;
			CompatSessionManager: typeof SessionManager;
			session: InstanceType<typeof SessionManager>;
			compatSession: InstanceType<typeof SessionManager>;
			value: string;
		};
		observations.push({
			value: observed.value,
			equal: observed.SessionManager === observed.CompatSessionManager,
			canonicalInstance: observed.session instanceof observed.CompatSessionManager,
			compatInstance: observed.compatSession instanceof observed.SessionManager,
			// Native-first development imports historically share aliases, not the live host.
			// The transformed path must additionally use the live host, never a third copy.
			...(observed.value === "first"
				? {}
				: {
						canonicalHost: observed.SessionManager === SessionManager,
						compatHost: observed.CompatSessionManager === SessionManager,
						liveCanonicalInstance: liveSession instanceof observed.SessionManager,
						liveCompatInstance: liveSession instanceof observed.CompatSessionManager,
					}),
		});
	});
	const hostFileCounts: number[] = [];
	for (const value of ["first", "reload", "edited"]) {
		// Only the two-hop leaf changes; neither entry nor helper is rewritten.
		fs.writeFileSync(leaf, `export const value = ${JSON.stringify(value)};\n`);
		clearExtensionCache();
		const factory = await loadExtensionModule(entry, useExtensionCacheCwd(root));
		assert.ok(factory);
		await loadExtensionFromFactory(factory, root, bus, createExtensionRuntime(), entry);
		const manifest = readExtensionGraphManifest(entry);
		if (value === "first") {
			assert.equal(manifest, undefined, "first load must retain the native-first path");
		} else {
			assert.ok(manifest, "reload must record the transformed editable graph");
			const hostFiles = Object.keys(manifest.files).filter((file) => /[/\\]coding-agent[/\\]src[/\\]/.test(file));
			hostFileCounts.push(hostFiles.length);
		}
	}
	console.log(JSON.stringify({ observations, hostFileCounts }));
	assert.deepEqual(
		observations,
		["first", "reload", "edited"].map((value) => ({
			value,
			equal: true,
			canonicalInstance: true,
			compatInstance: true,
			...(value === "first"
				? {}
				: { canonicalHost: true, compatHost: true, liveCanonicalInstance: true, liveCompatInstance: true }),
		})),
	);
	assert.deepEqual(hostFileCounts, [0, 0], "host sources must not join the editable graph");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
	Object.defineProperty(process, "platform", platformDescriptor);
}
