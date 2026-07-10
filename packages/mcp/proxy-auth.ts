import type { McpExtensionState } from "./state.js";
import { authenticate, supportsOAuth } from "./mcp-auth-flow.js";
import { formatAuthRequiredMessage } from "./utils.js";

export type AutoAuthResult =
  | { status: "skipped" }
  | { status: "success" }
  | { status: "failed"; message: string };

export function getAuthRequiredMessage(
  state: McpExtensionState,
  serverName: string,
  defaultMessage = `Server "${serverName}" requires OAuth authentication. Run /mcp-auth ${serverName} first.`,
): string {
  return formatAuthRequiredMessage(state.config, serverName, defaultMessage);
}

function getAuthFailedMessage(state: McpExtensionState, serverName: string, message: string): string {
  const customGuidance = state.config.settings?.authRequiredMessage;
  if (customGuidance) {
    return `OAuth authentication failed for "${serverName}": ${message}. ${getAuthRequiredMessage(state, serverName)}`;
  }
  return `OAuth authentication failed for "${serverName}": ${message}. Run /mcp-auth ${serverName} first.`;
}

export async function attemptAutoAuth(
  state: McpExtensionState,
  serverName: string,
): Promise<AutoAuthResult> {
  if (state.config.settings?.autoAuth !== true) {
    return { status: "skipped" };
  }

  const definition = state.config.mcpServers[serverName];
  if (!definition || !supportsOAuth(definition) || !definition.url) {
    return { status: "skipped" };
  }

  const grantType = definition.oauth ? definition.oauth.grantType ?? "authorization_code" : "authorization_code";
  if (!state.ui && grantType !== "client_credentials") {
    return {
      status: "failed",
      message: getAuthRequiredMessage(
        state,
        serverName,
        `Server "${serverName}" requires OAuth authentication. Run /mcp-auth ${serverName} in an interactive session.`,
      ),
    };
  }

  try {
    await authenticate(serverName, definition.url, definition);
    return { status: "success" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      message: getAuthFailedMessage(state, serverName, message),
    };
  }
}
