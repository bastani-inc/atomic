import type { ExtensionAPI } from "@bastani/atomic";
import type { McpExtensionState } from "./state.js";

interface CommandStateLease {
  readonly state: McpExtensionState;
  readonly assertActive: () => void;
}

export function registerMcpCommands(
  pi: ExtensionAPI,
  earlyConfigPath: string | undefined,
  acquireState: () => Promise<CommandStateLease>,
): void {
  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      let lease: CommandStateLease;
      try {
        lease = await acquireState();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
        return;
      }
      const { showStatus, showTools, reconnectServers, logoutServer, openMcpPanel, openMcpSetup } = await import("./commands.js");
      try { lease.assertActive(); } catch { return; }
      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];
      const rest = parts.slice(1).join(" ");
      switch (subcommand) {
        case "reconnect": await reconnectServers(lease.state, ctx, targetServer); break;
        case "tools": await showTools(lease.state, ctx); break;
        case "setup": {
          const result = await openMcpSetup(lease.state, pi, ctx, earlyConfigPath, "setup");
          if (result?.configChanged) await ctx.reload();
          break;
        }
        case "logout": {
          if (!rest) {
            if (ctx.hasUI) ctx.ui.notify("Usage: /mcp logout <server>", "error");
            return;
          }
          await logoutServer(rest, lease.state, ctx);
          break;
        }
        case "status":
        case "":
        default:
          if (ctx.hasUI) {
            const result = await openMcpPanel(lease.state, pi, ctx, earlyConfigPath);
            if (result?.configChanged) await ctx.reload();
          } else {
            await showStatus(lease.state, ctx);
          }
      }
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName && !ctx.hasUI) return;
      let lease: CommandStateLease;
      try {
        lease = await acquireState();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
        return;
      }
      const { authenticateServer, openMcpAuthPanel } = await import("./commands.js");
      try { lease.assertActive(); } catch { return; }
      if (!serverName) {
        await openMcpAuthPanel(lease.state, pi, ctx, earlyConfigPath);
        return;
      }
      await authenticateServer(serverName, lease.state.config, ctx);
    },
  });
}
