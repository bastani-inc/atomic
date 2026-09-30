import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const examplesDir = join(import.meta.dirname, "../examples/extensions");

describe("tool renderer examples", () => {
	let tempDir: string;
	let agentDir: string;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-tool-renderer-example-test-"));
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});
	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	async function getSessionState(extensionPath: string | undefined, tools: string[]) {
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: extensionPath ? [extensionPath] : [],
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5"),
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
			builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false },
			tools,
		});
		try {
			return { systemPrompt: session.systemPrompt, editToolDefinition: session.getToolDefinition("edit") };
		} finally {
			session.dispose();
		}
	}

	it.each([
		{
			name: "built-in tool renderer",
			extensionPath: join(examplesDir, "built-in-tool-renderer.ts"),
			tools: ["read", "bash", "edit", "write"],
		},
		{
			name: "minimal mode",
			extensionPath: join(examplesDir, "minimal-mode.ts"),
			tools: ["read", "bash", "write", "edit", "find", "search", "ls"],
		},
	])("keeps the system prompt unchanged for the $name example (#10072)", async ({ extensionPath, tools }) => {
		const baseline = await getSessionState(undefined, tools);
		const withRenderer = await getSessionState(extensionPath, tools);
		assert.equal(withRenderer.systemPrompt, baseline.systemPrompt);
	});

	it("keeps minimal mode's edit tool in the default shell (#10072)", async () => {
		const minimalMode = await getSessionState(join(examplesDir, "minimal-mode.ts"), ["edit"]);
		const definition = minimalMode.editToolDefinition;
		assert(definition);
		const { renderShell: _renderShell, ...defaultShellDefinition } = definition;
		assert.deepEqual(renderEditTool(definition, tempDir), renderEditTool(defaultShellDefinition, tempDir));
	});
});

function renderEditTool(definition: ToolDefinition, cwd: string): string[] {
	const component = new ToolExecutionComponent(
		"edit",
		"edit-shell-test",
		{ input: "[notes.txt#A1B2]\nreplace 1..1:\n+after" },
		{},
		definition,
		{ requestRender() {} } as TUI,
		cwd,
	);
	return component.render(40);
}
