import { join } from "node:path";
import { Text } from "@bastani/atomic-tui";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../config.js";
import { pathExists } from "../../../utils/path-exists.ts";
import type { SessionEntry } from "../../session-manager.ts";
import type { LazyBuiltinSpec } from "../lazy-builtin.js";
import type { BeforeAgentStartEventResult } from "../types.ts";

const MCP_TOOL_RECORD_ENTRY_TYPE = "atomic.mcp-tool-definitions";

function shouldActivateMcpAtStart(
	hasConfigFiles: boolean,
	hasRegisteredServers: boolean,
	hasRecordedTools: boolean,
): boolean {
	return hasConfigFiles || hasRegisteredServers || hasRecordedTools;
}

function hasMcpSessionHistory(entries: readonly SessionEntry[]): boolean {
	return entries.some(
		(entry) =>
			(entry.type === "custom" && entry.customType === MCP_TOOL_RECORD_ENTRY_TYPE) ||
			(entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName.startsWith("mcp__")),
	);
}

export const mcpLazyBuiltinSpec: LazyBuiltinSpec = {
	label: "mcp",
	managedEvents: ["before_agent_start"],
	interceptsMcpContributions: true,
	register(atomic, controller) {
		let checkedGlobalConfig = false;
		let checkedProjectConfig = false;
		let pendingContributionActivation: Promise<unknown> | null = null;

		controller.onDormantShutdown(() => {
			checkedGlobalConfig = false;
			checkedProjectConfig = false;
			pendingContributionActivation = null;
		});

		const checkAndActivateForContext = async (
			ctx: Parameters<Parameters<typeof controller.onSessionStart>[0]>[1],
			forceConfigCheck: boolean,
		) => {
			if (controller.active) return;
			if (pendingContributionActivation) {
				await pendingContributionActivation;
				if (controller.active) return;
			}
			const hasRegisteredServers = (atomic.getMcpServerContributions?.().length ?? 0) > 0;
			let hasRecordedTools = false;
			try {
				hasRecordedTools = hasMcpSessionHistory(ctx.sessionManager.getBranch());
			} catch {
				hasRecordedTools = false;
			}
			const shouldCheckGlobal = forceConfigCheck || !checkedGlobalConfig;
			const projectTrusted = ctx.isProjectTrusted();
			const shouldCheckProject = projectTrusted && (forceConfigCheck || !checkedProjectConfig);
			const [globalConfigExists, projectConfigExists] = await Promise.all([
				shouldCheckGlobal ? pathExists(join(getAgentDir(), "mcp.json")) : Promise.resolve(false),
				shouldCheckProject ? pathExists(join(ctx.cwd, CONFIG_DIR_NAME, "mcp.json")) : Promise.resolve(false),
			]);
			if (shouldCheckGlobal) checkedGlobalConfig = true;
			if (shouldCheckProject) checkedProjectConfig = true;
			const hasConfigFiles = globalConfigExists || projectConfigExists;
			if (shouldActivateMcpAtStart(hasConfigFiles, hasRegisteredServers, hasRecordedTools)) {
				await controller.activate(ctx);
			}
		};

		controller.onSessionStart(async (_event, ctx) => {
			checkedGlobalConfig = false;
			checkedProjectConfig = false;
			await checkAndActivateForContext(ctx, true);
		});

		controller.onSessionTree(async (_event, ctx) => {
			if (controller.active) return;
			let hasRecordedTools = false;
			try {
				hasRecordedTools = hasMcpSessionHistory(ctx.sessionManager.getBranch());
			} catch {
				hasRecordedTools = false;
			}
			if (hasRecordedTools) {
				await controller.activate(ctx);
			}
		});

		atomic.on("before_agent_start", async (event, ctx) => {
			if (!controller.active) {
				await checkAndActivateForContext(ctx, false);
			}
			if (!controller.active) return undefined;
			return (await controller.dispatchHandlers("before_agent_start", event, ctx)) as
				| BeforeAgentStartEventResult
				| undefined;
		});

		// Register as an MCP consumer immediately so reportUnhandledMcpServers does not report
		// false positives while MCP is dormant, and activate on demand when an extension registers a server.
		atomic.onMcpServerContributionsChanged?.(() => {
			const active = controller.active;
			if (active) {
				for (const listener of [...active.captured.mcpContributionListeners]) {
					listener();
				}
				return;
			}
			if (!controller.isCurrentLease()) return;
			const activation = controller.activate(controller.latestContext());
			pendingContributionActivation = activation;
			void activation.then(
				() => {
					if (pendingContributionActivation === activation) pendingContributionActivation = null;
				},
				() => {
					if (pendingContributionActivation === activation) pendingContributionActivation = null;
				},
			);
		});

		// Fallback renderer for resumed mcp__* calls while dormant; once active, defer to MCP's own renderer.
		atomic.registerToolRenderer((toolName, next) => {
			if (controller.active) return next();
			const registered = next();
			if (registered) return registered;
			if (!toolName.startsWith("mcp__")) return undefined;
			return {
				renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold(toolName)), 0, 0),
				renderResult: (result, _options, theme) => {
					const firstText = result.content.find((block) => block.type === "text")?.text ?? "";
					return new Text(theme.fg("toolOutput", firstText), 0, 0);
				},
			};
		});

		atomic.registerCommand("mcp", {
			description: "Manage MCP servers: sign in, reconnect, enable or disable, and change exposure",
			getArgumentCompletions: (prefix) => {
				const loaded = controller.active?.captured.commands.get("mcp")?.getArgumentCompletions;
				if (loaded) return loaded(prefix);
				const [action, server, ...rest] = prefix.trimStart().split(/\s+/);
				if (rest.length > 0) return null;
				if (server === undefined) {
					return ["login", "logout", "reconnect"]
						.filter((item) => item.startsWith(action ?? ""))
						.map((item) => ({ value: `${item} `, label: item }));
				}
				return null;
			},
			handler: (args, ctx) => controller.runCommand("mcp", args, ctx),
		});
	},
};
