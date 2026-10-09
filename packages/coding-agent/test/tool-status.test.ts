import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, test } from "vitest";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.js";
import {
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../src/core/agent-session-services.js";
import { createAgentSession } from "../src/core/sdk.js";
import type { CreateAgentSessionOptions } from "../src/core/sdk-types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { SourceInfo } from "../src/core/source-info.js";
import { buildToolStatusReport, formatToolStatus, type ToolStatusReport } from "../src/core/tool-status.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import "../src/modes/interactive/interactive-slash-commands.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.js";
import { stripAnsi } from "../src/utils/ansi.js";

beforeAll(() => {
	initTheme(undefined, false);
});

// The interactive engine binds before extensions load, then loads them with reload({ reason: "startup" }).
test.each([
	{ selectedBy: "the defaultTools setting", settings: { defaultTools: ["+codemode"] }, tools: undefined },
	{ selectedBy: "a --tools modifier", settings: {}, tools: ["+codemode"] },
])("codemode selected by $selectedBy activates once deferred extensions load", async ({ settings, tools }) => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-deferred-codemode-"));
	try {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager: SettingsManager.inMemory(settings),
			resourceLoaderReloadOptions: { deferExtensions: true, deferResources: true },
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false },
			tools,
		});
		try {
			assert.equal(
				session.getAllTools().some((tool) => tool.name === "codemode"),
				false,
				"extensions are still deferred",
			);

			await session.reload({ reason: "startup" });

			assert.ok(session.getActiveToolNames().includes("codemode"));
			assert.equal(session.getActiveToolNames().includes("tool_search"), false);
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

async function withSession<T>(
	options: Partial<CreateAgentSessionOptions>,
	use: (session: Awaited<ReturnType<typeof createAgentSession>>["session"], cwd: string) => Promise<T>,
): Promise<T> {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-tool-status-"));
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false },
		settingsManager: SettingsManager.inMemory(),
		sessionManager: SessionManager.inMemory(cwd),
		...options,
	});
	try {
		return await use(session, cwd);
	} finally {
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("a selected opt-in tool turned off during the session stays off after reload", async () => {
	await withSession(
		{ settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"] }) },
		async (session) => {
			assert.ok(session.getActiveToolNames().includes("codemode"));
			session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "codemode"));

			await session.reload();

			assert.equal(session.getActiveToolNames().includes("codemode"), false);
			assert.equal(
				session.getToolStatus().tools.find((tool) => tool.name === "codemode")?.inactiveReason,
				"selected by the defaultTools setting, but deactivated during this session",
			);
		},
	);
});

test("tool status explains active, opt-in, unselected, and missing tools", async () => {
	await withSession(
		{ settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode", "+tool-search"] }) },
		async (session) => {
			const report = session.getToolStatus();
			const byName = new Map(report.tools.map((tool) => [tool.name, tool]));

			assert.equal(report.selection.source, "default-tools-setting");
			assert.equal(report.selection.description, "the defaultTools setting");
			assert.ok(report.selection.names.includes("codemode"));
			assert.equal(byName.get("read")?.source, "built-in");
			assert.equal(byName.get("codemode")?.active, true);
			assert.equal(byName.get("codemode")?.source, 'built-in extension "codemode"');
			assert.match(byName.get("tool_search")?.inactiveReason ?? "", /^opt-in; add "\+tool_search" to defaultTools/);
			assert.match(byName.get("ls")?.inactiveReason ?? "", /^not selected; add "\+ls" to defaultTools/);
			assert.deepEqual(
				report.missing.map((tool) => tool.name),
				["tool-search"],
			);
			assert.match(report.missing[0]!.reason, /did you mean "tool_search"\?$/);
			assert.deepEqual(report.excluded, []);
			const firstInactive = report.tools.findIndex((tool) => !tool.active);
			assert.ok(report.tools.slice(firstInactive).every((tool) => !tool.active));

			const text = formatToolStatus(report);
			assert.match(text, /^Tool selection: the defaultTools setting$/m);
			assert.match(text, /^Inactive \(\d+\)$/m);
			assert.match(text, /^Missing \(1\)$/m);
		},
	);
});

test("tool status reports allowlisted, excluded, and unregistered names", async () => {
	await withSession({ tools: ["read", "bash", "reads"], excludedTools: ["bash"] }, async (session) => {
		const report = session.getToolStatus();

		assert.equal(report.selection.source, "tools-allowlist");
		assert.deepEqual(report.selection.names, ["read", "bash", "reads"]);
		assert.deepEqual(
			report.tools.filter((tool) => tool.active).map((tool) => tool.name),
			["read"],
		);
		assert.deepEqual(
			report.excluded.map((tool) => tool.name),
			["bash"],
		);
		assert.match(report.excluded[0]!.reason, /--exclude-tools/);
		assert.deepEqual(
			report.missing.map((tool) => tool.name),
			["reads"],
		);
		assert.match(report.missing[0]!.reason, /^selected by the --tools allowlist, .*did you mean "read"\?$/);
	});
});

test("tool status explains codemode-only, deferred, and hidden exposures", () => {
	const extension: SourceInfo = { path: "/ext/docs.ts", source: "local", scope: "user", origin: "top-level" };
	const codemode: SourceInfo = { path: "builtin:codemode", source: "builtin", scope: "user", origin: "top-level" };
	const tools = [
		{
			definition: { name: "codemode", description: "Run scripts", exposure: "model-only" as const },
			sourceInfo: codemode,
		},
		{
			definition: {
				name: "docs_search",
				description: "Search docs\nwith more detail",
				exposure: "codemode" as const,
				namespace: { name: "docs" },
			},
			sourceInfo: extension,
		},
		{ definition: { name: "lazy", description: "Lazy", exposure: "deferred" as const }, sourceInfo: extension },
		{ definition: { name: "secret", description: "Secret", exposure: "hidden" as const }, sourceInfo: extension },
	];
	const selection = {
		source: "built-in-defaults" as const,
		description: "Atomic's default tool set",
		names: [],
		modifiers: [],
	};
	const reasons = (activeToolNames: string[]) =>
		new Map(
			buildToolStatusReport({ tools, activeToolNames, selection }).tools.map((tool) => [
				tool.name,
				tool.inactiveReason,
			]),
		);

	const withoutCodemode = reasons([]);
	assert.match(withoutCodemode.get("docs_search") ?? "", /codemode is not active; add "\+codemode"/);
	assert.match(withoutCodemode.get("lazy") ?? "", /tool_search is not active; add "\+tool_search"/);
	assert.equal(withoutCodemode.get("secret"), "hidden: never offered to the model");
	assert.equal(reasons(["codemode"]).get("docs_search"), "callable only from codemode scripts");

	const selectedButOff = new Map(
		buildToolStatusReport({
			tools,
			activeToolNames: [],
			selection: { ...selection, names: ["codemode"], description: "the defaultTools setting" },
		}).tools.map((tool) => [tool.name, tool.inactiveReason]),
	);
	assert.equal(
		selectedButOff.get("codemode"),
		"selected by the defaultTools setting, but deactivated during this session",
	);
	assert.match(selectedButOff.get("docs_search") ?? "", /"codemode" is selected by the defaultTools setting/);
	assert.doesNotMatch([...selectedButOff.values()].join("\n"), /add "\+codemode"/);

	const docs = buildToolStatusReport({ tools, activeToolNames: [], selection }).tools.find(
		(tool) => tool.name === "docs_search",
	);
	assert.equal(docs?.source, 'extension /ext/docs.ts, namespace "docs"');
	assert.equal(docs?.summary, "Search docs");
});

test("get_tools RPC returns the session's tool status", async () => {
	await withSession(
		{ settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"] }) },
		async (session, cwd) => {
			const unusedRuntimeFactory: CreateAgentSessionRuntimeFactory = async () => {
				throw new Error("unused runtime factory");
			};
			const runtimeHost = new AgentSessionRuntime(
				session,
				{
					cwd,
					agentDir: join(cwd, "agent"),
					settingsManager: session.settingsManager,
					resourceLoader: session.resourceLoader,
				} as AgentSessionServices,
				unusedRuntimeFactory,
			);
			const handler = createRpcCommandHandler({
				runtimeHost,
				getSession: () => session,
				rebindSession: async () => {},
				output: () => {},
			});

			const response = await handler({ id: "tools", type: "get_tools" });

			assert.ok(response?.success && response.command === "get_tools");
			assert.deepEqual(response.data, session.getToolStatus());
		},
	);
});

test("/tools in the isolated host shows the engine's tool status, not the host session's", async () => {
	const engineReport: ToolStatusReport = {
		selection: {
			source: "default-tools-setting",
			description: "the defaultTools setting",
			names: ["read", "codemode"],
			modifiers: [],
		},
		tools: [
			{
				name: "read",
				active: true,
				exposure: "direct",
				source: "built-in",
				sourcePath: "<builtin:read>",
				summary: "Read files",
			},
		],
		missing: [{ name: "codemode", reason: "selected by the defaultTools setting, but nothing registered it" }],
		excluded: [],
	};
	const runtimeHost: IsolatedInteractiveRuntime = Object.create(IsolatedInteractiveRuntime.prototype);
	runtimeHost.getToolStatus = async () => engineReport;
	const chatContainer = new Container();
	const errors: string[] = [];

	await InteractiveModeBase.prototype.handleToolsCommand.call({
		runtimeHost,
		session: {
			getToolStatus: () => {
				throw new Error("the host session has no extensions and must not be asked");
			},
		},
		chatContainer,
		ui: { requestRender() {} },
		showError: (message: string) => errors.push(message),
	} as never);

	assert.deepEqual(errors, []);
	const output = stripAnsi(chatContainer.render(120).join("\n"));
	assert.match(output, /Tool selection: the defaultTools setting/);
	assert.match(output, /Active \(1\)/);
	assert.match(output, /Missing \(1\)\s+codemode\s+selected by the defaultTools setting/);
});
