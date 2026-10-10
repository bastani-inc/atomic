import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import * as builtinPackages from "../src/core/builtin-packages.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const REAL_BUILTIN_INHERITANCE_TIMEOUT_MS = 120_000;

test(
	"bundled extensions inherit the caller's extension paths and factories across reloads (#3551)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-builtin-inheritance-"));
		const bundled = join(root, "bundled");
		const extensionPath = join(root, "caller.ts");
		mkdirSync(bundled);
		writeFileSync(extensionPath, "export default function () {}\n");
		writeFileSync(
			join(bundled, "package.json"),
			JSON.stringify({ name: "snapshot-builtin", pi: { extensions: ["./index.ts"] } }),
		);
		writeFileSync(
			join(bundled, "index.ts"),
			`import { Type } from "typebox";
export default function (pi) {
	pi.registerTool({
		name: "builtin_snapshot", label: "Builtin snapshot", description: "Read inherited resources",
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: pi.getResourceLoaderInheritanceSnapshot() }),
	});
}
`,
		);
		vi.spyOn(builtinPackages, "getBuiltinPackageLocations").mockReturnValue([
			{ packageName: "@bastani/workflows", distDirName: "workflows", packageDir: bundled },
		]);
		const settingsManager = SettingsManager.inMemory();
		const factory = () => {};
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager,
			builtinPackagePaths: [],
			additionalExtensionPaths: [extensionPath],
			extensionFactories: [factory],
		});
		try {
			await loader.reload();
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: join(root, "agent"),
				resourceLoader: loader,
				settingsManager,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				sessionManager: SessionManager.inMemory(root),
			});
			try {
				for (let generation = 0; generation < 2; generation++) {
					const tool = session.agent.state.tools.find((entry) => entry.name === "builtin_snapshot");
					assert.ok(tool);
					const result = await tool.execute("snapshot", {}, new AbortController().signal);
					const expected = loader.getInheritanceSnapshot();
					assert.deepEqual(expected.additionalExtensionPaths, [extensionPath]);
					assert.ok(expected.extensionFactories?.includes(factory));
					assert.deepEqual(result.details, expected);
					if (generation === 0) await session.reload({ failOnExtensionErrors: true });
				}
			} finally {
				await session.dispose();
			}
		} finally {
			vi.restoreAllMocks();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_BUILTIN_INHERITANCE_TIMEOUT_MS,
);
