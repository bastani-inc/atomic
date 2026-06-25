import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type AliasOptions } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

const workspaceSourceAliases: AliasOptions =
	existsSync(aiSrcIndex) && existsSync(aiSrcOAuth) && existsSync(agentSrcIndex) && existsSync(tuiSrcIndex)
		? [
				{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
				{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
				{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
				{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
				{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
				{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
				{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
			]
		: [];

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: ["test/**/*.test.ts", "test/**/*.spec.ts", "test/**/*.suite.ts"],
		exclude: [
			"**/node_modules/**",
			"test/agent-session-auto-compaction-queue.test.ts",
			"test/agent-session-concurrent.test.ts",
			"test/auth-storage.test.ts",
			"test/context-compaction-deletion-tool.test.ts",
			"test/context-compaction.test.ts",
			"test/context-window-session.test.ts",
			"test/extensions-runner.test.ts",
			"test/interactive-mode-status.test.ts",
			"test/model-registry.test.ts",
			"test/package-command-paths.test.ts",
			"test/package-manager-extra-suites.test.ts",
			"test/package-manager.test.ts",
			"test/resource-loader.test.ts",
			"test/session-manager/build-context.test.ts",
			"test/tools.test.ts",
			"test/tree-selector.test.ts",
			"test/suite/agent-session-runtime.test.ts",
		],
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: workspaceSourceAliases,
	},
});
