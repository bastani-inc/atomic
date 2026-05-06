/**
 * Agent configuration definitions for atomic CLI
 */

/**
 * Embedded-asset kind whose extracted tree is a provider config root
 * (`.claude`, `.opencode`, `.github`). Used by onboarding-file declarations
 * to identify their source bundle.
 */
export type ProviderConfigKind = "claude" | "opencode" | "github";

/**
 * Full embedded-asset kind — superset of {@link ProviderConfigKind} that
 * also covers the `skills` bundle. Accepted by `getEmbeddedAsset`.
 */
export type EmbeddedAssetKind = ProviderConfigKind | "skills";

export interface AgentConfig {
  /** Display name for the agent */
  name: string;
  /** Command to execute the agent */
  cmd: string;
  /** Flags used when spawning the agent in interactive chat mode */
  chat_flags: string[];
  /** Environment variables to set when spawning the agent (merged with process env) */
  env_vars: Record<string, string>;
  /** Config folder relative to repo root */
  folder: string;
  /** URL for installation instructions */
  install_url: string;
  /** Paths to exclude when copying (relative to folder) */
  exclude: string[];
  /** Project files applied during `atomic chat` preflight for provider onboarding */
  onboarding_files: Array<{
    /** Embedded-asset kind whose extracted tree is the source root. */
    kind: ProviderConfigKind;
    /** Path to the source file relative to the kind's extracted tree root. */
    source: string;
    destination: string;
    merge: boolean;
    /**
     * Top-level keys to strip from the source before copying or merging.
     * Useful when a key is project-local by design (e.g. Claude's
     * `disabledMcpjsonServers`) and must not leak into a global
     * destination like `~/.claude/settings.json`.
     */
    excludeConfigKeys?: readonly string[];
    /**
     * Top-level keys for which Atomic's source forcibly overwrites the
     * destination's existing value, opting out of the default
     * user-precedence merge. Use sparingly — only for keys whose
     * canonical state is owned by Atomic (e.g. forced security
     * defaults). Anything else should follow the golden rule and let
     * the user's value win.
     */
    overwriteConfigKeys?: readonly string[];
  }>;
}

const AGENT_KEYS = ["claude", "opencode", "copilot"] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

export const AGENT_CONFIG: Record<AgentKey, AgentConfig> = {
  claude: {
    name: "Claude Code",
    cmd: "claude",
    chat_flags: [
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
    ],
    env_vars: {},
    folder: ".claude",
    install_url: "https://code.claude.com/docs/en/setup",
    exclude: [],
    onboarding_files: [
      {
        kind: "claude",
        source: ".mcp.json",
        destination: ".mcp.json",
        merge: true,
      },
      {
        kind: "claude",
        source: "settings.json",
        destination: ".claude/settings.json",
        merge: true,
      },
      {
        kind: "claude",
        source: "settings.json",
        destination: "~/.claude/settings.json",
        merge: true,
        // `disabledMcpjsonServers` is reconciled per-project by scm-sync
        // and must not leak into the user's global Claude settings.
        excludeConfigKeys: ["disabledMcpjsonServers"],
      },
    ],
  },
  opencode: {
    name: "OpenCode",
    cmd: "opencode",
    chat_flags: [],
    env_vars: { OPENCODE_EXPERIMENTAL_LSP_TOOL: "true" },
    folder: ".opencode",
    install_url: "https://opencode.ai",
    exclude: [".gitignore", "package.json"],
    onboarding_files: [
      {
        kind: "opencode",
        source: "opencode.json",
        destination: ".opencode/opencode.json",
        merge: true,
      },
    ],
  },
  copilot: {
    name: "GitHub Copilot CLI",
    cmd: "copilot",
    chat_flags: ["--add-dir", ".", "--yolo", "--experimental"],
    env_vars: {
      COPILOT_ALLOW_ALL: "true",
    },
    folder: ".github",
    install_url:
      "https://github.com/github/copilot-cli?tab=readme-ov-file#installation",
    exclude: ["workflows", "dependabot.yml"],
    onboarding_files: [
      // Workspace `.mcp.json` is shared with Claude — Copilot reads the
      // same file at the project root. We source it from the `claude`
      // bundle so a single canonical template ships in both providers.
      {
        kind: "claude",
        source: ".mcp.json",
        destination: ".mcp.json",
        merge: true,
      },
    ],
  },
};

/**
 * Per-provider overrides that users can set in `.atomic/settings.json`
 * (local) or `~/.atomic/settings.json` (global).
 *
 * - `chatFlags`: when set, replaces the agent's default `chat_flags` entirely.
 * - `envVars`: environment variables merged on top of the agent's default
 *   `env_vars` (user values win on conflict).
 */
export interface ProviderOverrides {
  chatFlags?: string[];
  envVars?: Record<string, string>;
}

export function isValidAgent(key: string): key is AgentKey {
  return key in AGENT_CONFIG;
}

export function getAgentConfig(key: AgentKey): AgentConfig {
  return AGENT_CONFIG[key];
}

export function getAgentKeys(): AgentKey[] {
  return [...AGENT_KEYS];
}
