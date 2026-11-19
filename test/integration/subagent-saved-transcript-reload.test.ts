import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { linkSharedTranspileCache } from "../../packages/coding-agent/test/helpers/shared-transpile-cache.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Loads editable subagents through the real resource loader, then replaces its module generation repeatedly. */
const SDK_RELOAD_TIMEOUT_MS = 120_000;

function registeredSources(): number {
	const key = Symbol.for("@bastani/atomic/tasks/saved-transcripts");
	return (globalThis as { [key]?: ReadonlySet<unknown> })[key]?.size ?? 0;
}

test(
	"reloading subagents keeps only the live owner's transcript source; disposing the owner releases it (#5531)",
	async () => {
		const cwd = makeTempDirectory("saved-transcript-reload-");
		const agentDir = join(cwd, "profile");
		linkSharedTranspileCache(agentDir);
		const entry = join(cwd, "subagents.ts");
		const extension = fileURLToPath(new URL("../../packages/subagents/src/extension/index.ts", import.meta.url));
		await writeFile(
			entry,
			`import subagents from ${JSON.stringify(extension)}; export default pi => subagents(pi);\n`,
		);
		const before = registeredSources();
		const manager = SessionManager.inMemory(cwd);
		const settingsManager = SettingsManager.inMemory();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			builtinPackagePaths: [],
			additionalExtensionPaths: [entry],
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
		});
		try {
			await loader.reload();
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				settingsManager,
				sessionManager: manager,
				resourceLoader: loader,
				builtins: { subagents: false, intercom: false, workflows: false, mcp: false, "web-access": false },
			});
			try {
				for (let generation = 0; generation <= 5; generation++) {
					if (generation) {
						await appendFile(entry, `\n// revision ${generation}\n`);
						await session.reload({ failOnExtensionErrors: true });
					}
					assert.ok(session.extensionRunner.getToolDefinition("subagent"));
					assert.equal(registeredSources(), before + 1, `after generation ${generation}`);
				}
			} finally {
				await session.dispose();
			}
			assert.equal(registeredSources(), before, "no retired sources");
		} finally {
			removeTempDirectory(cwd);
		}
	},
	SDK_RELOAD_TIMEOUT_MS,
);
