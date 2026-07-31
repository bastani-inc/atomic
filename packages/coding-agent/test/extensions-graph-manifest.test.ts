import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.ts";

function sha256Hex(content: Buffer): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

function manifestFileHash(files: Record<string, string>, filePath: string): string | undefined {
	const normalized = path.normalize(filePath);
	for (const [recordedPath, hash] of Object.entries(files)) {
		// Windows paths compare case-insensitively; resolution may normalize case.
		if (
			recordedPath === normalized ||
			(process.platform === "win32" && recordedPath.toLowerCase() === normalized.toLowerCase())
		) {
			return hash;
		}
	}
	return undefined;
}

describe("extension graph manifest recording", () => {
	const roots: string[] = [];

	afterEach(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
		}
	});

	function writeChainFixture(): { entry: string; chain: string[] } {
		// Realpath the temp root: on macOS os.tmpdir() is a /var -> /private/var
		// symlink, and jiti resolves transitive imports to realpaths, so manifest
		// keys would use /private/var while the fixture paths compared against
		// them kept the literal /var prefix.
		const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-graph-manifest-"));
		roots.push(root);
		const entry = path.join(root, "extension.ts");
		const chainA = path.join(root, "chain-a.ts");
		const chainB = path.join(root, "chain-b.ts");
		const chainC = path.join(root, "chain-c.ts");
		fs.writeFileSync(
			entry,
			`import { valueA } from "./chain-a.js";\nexport default function () {\n\treturn valueA;\n}\n`,
		);
		fs.writeFileSync(chainA, `import { valueB } from "./chain-b.js";\nexport const valueA = valueB + ":a";\n`);
		fs.writeFileSync(chainB, `import { valueC } from "./chain-c.js";\nexport const valueB = valueC + ":b";\n`);
		fs.writeFileSync(chainC, `export const valueC = "c";\n`);
		return { entry, chain: [chainA, chainB, chainC] };
	}

	it("records the complete transitive file graph with content hashes", async () => {
		const { entry, chain } = writeChainFixture();

		const factory = await extensionLoaderTestHooks.loadExtensionModuleTransformed(entry);
		expect(typeof factory).toBe("function");

		const manifest = extensionLoaderTestHooks.readExtensionGraphManifest(entry);
		expect(manifest).toBeDefined();
		expect(manifest?.version).toBe(1);
		expect(manifest?.extensionPath).toBe(entry);

		for (const filePath of [entry, ...chain]) {
			const recordedHash = manifestFileHash(manifest?.files ?? {}, filePath);
			expect(recordedHash, `manifest missing graph file ${filePath}`).toBe(sha256Hex(fs.readFileSync(filePath)));
		}
	});

	it("rewrites the manifest when a transitively imported file changes", async () => {
		const { entry, chain } = writeChainFixture();
		const chainC = chain[2];
		if (!chainC) throw new Error("fixture chain incomplete");

		await extensionLoaderTestHooks.loadExtensionModuleTransformed(entry);
		const before = extensionLoaderTestHooks.readExtensionGraphManifest(entry);
		const beforeHash = manifestFileHash(before?.files ?? {}, chainC);

		fs.writeFileSync(chainC, `export const valueC = "c-edited";\n`);
		await extensionLoaderTestHooks.loadExtensionModuleTransformed(entry);
		const after = extensionLoaderTestHooks.readExtensionGraphManifest(entry);
		const afterHash = manifestFileHash(after?.files ?? {}, chainC);

		expect(beforeHash).toBeDefined();
		expect(afterHash).toBe(sha256Hex(fs.readFileSync(chainC)));
		expect(afterHash).not.toBe(beforeHash);
	});
});
