import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentHarness,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { loadProjectContextFiles } from "../src/core/resource-loader-context-files.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import type { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import type { InteractiveEngineCommand } from "../src/modes/interactive-engine/protocol.ts";
import { RemoteCustomMessageComponent } from "../src/modes/interactive-engine/remote-renderer.ts";
import "../src/modes/interactive/interactive-resource-paths.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function customMessage(): CustomMessage<string> {
	return { role: "custom", customType: "test", content: "custom", display: true, timestamp: Date.now() };
}

describe("Pi 0.82.1 remaining direct coding-agent parity", () => {
	it("skips context candidates that are directories without EISDIR warnings", () => {
		const root = tempDir("atomic-context-dir-");
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, "AGENTS.md"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, "CLAUDE.md"), "fallback instructions");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const files = loadProjectContextFiles({ cwd, agentDir });

		expect(files).toContainEqual({ path: join(cwd, "CLAUDE.md"), content: "fallback instructions" });
		expect(error.mock.calls.flat().join("\n")).not.toContain("EISDIR");
	});

	it("passes outputPad to normal and isolated custom renderers verbatim", () => {
		initTheme("dark");
		const seen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			seen.push(options);
			return new Text("custom", options.outputPad, 0);
		};
		const component = new CustomMessageComponent(customMessage(), renderer, undefined, 0);
		component.setExpanded(true);
		expect(seen.at(-1)).toEqual({ expanded: true, outputPad: 0 });
		component.setOutputPad(1);
		expect(seen.at(-1)).toEqual({ expanded: true, outputPad: 1 });

		const commands: InteractiveEngineCommand[] = [];
		const runtime = {
			onEngineMessage: () => () => {},
			sendEngineCommand: (command: InteractiveEngineCommand) => commands.push(command),
		} as unknown as IsolatedInteractiveRuntime;
		const remote = new RemoteCustomMessageComponent(customMessage(), runtime, () => {}, 0);
		remote.render(40);
		expect(commands[0]).toMatchObject({ type: "engine_message_render", outputPad: 0 });
		remote.setOutputPad(1);
		remote.render(40);
		expect(commands[1]).toMatchObject({ type: "engine_message_render", outputPad: 1 });
	});

	it("routes every Atomic-owned TUI constructor to the configured agent directory", () => {
		const sources = {
			"cli/startup-ui.ts": "getAgentDir()",
			"cli/config-selector.ts": "options.agentDir",
			"cli/session-picker.ts": "getAgentDir()",
			"main-session.ts": "getAgentDir()",
			"modes/interactive/interactive-mode-base.ts": "runtimeHost.services.agentDir",
			"modes/interactive-engine/engine-render-service.ts": "getAgentDir()",
			"modes/interactive-engine/engine-custom-ui.ts": "getAgentDir()",
		};
		for (const [relativePath, expected] of Object.entries(sources)) {
			const source = readFileSync(join(import.meta.dirname, "../src", relativePath), "utf8");
			expect(source, relativePath).toContain(expected);
			for (const constructorCall of source.match(/new TUI\([\s\S]*?\);/g) ?? []) {
				expect(constructorCall, `${relativePath}: ${constructorCall}`).toContain(expected);
			}
		}
	});

	it("preserves sibling npm extension topology relative to the declaring package", () => {
		const primary = "/tmp/project/.atomic/npm/node_modules/primary-package";
		const getShortPath = Reflect.get(InteractiveModeBase.prototype, "getShortPath") as (
			this: { isPackageSource: () => boolean; formatDisplayPath: (value: string) => string },
			fullPath: string,
			sourceInfo: { baseDir: string; source: string },
		) => string;
		const value = getShortPath.call(
			{ isPackageSource: () => true, formatDisplayPath: (path) => path },
			"/tmp/project/.atomic/npm/node_modules/sibling-package/index.ts",
			{ baseDir: primary, source: "npm:primary-package" },
		);
		expect(value).toBe("../sibling-package/index.ts");
	});
	it("inherits the AgentHarness execution-tool surface from pi-agent-core 0.82.1", () => {
		expect(typeof AgentHarness).toBe("function");
		for (const factory of [createBashTool, createEditTool, createReadTool, createWriteTool]) {
			expect(typeof factory).toBe("function");
		}
	});
});
