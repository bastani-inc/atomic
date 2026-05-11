/**
 * pi-mcp-adapter cooperation helpers.
 *
 * Responsibilities:
 *  1. Per-stage server gating: emit `mcp.scope.set` via pi.events so the
 *     adapter can restrict which MCP servers are available during a stage.
 *  2. Scope restore / clear helpers to reset after the stage completes.
 *
 * NOTE: This requires pi-mcp-adapter to expose a `mcp.scope.set` event
 * listener. If the adapter does not yet support this, the emit is a no-op
 * (the adapter simply ignores unknown events). A PR to pi-mcp-adapter should
 * add this surface — we do NOT patch the adapter locally.
 *
 * cross-ref: spec §5.9 Integration with pi-mcp-adapter, §8.1 Phase G
 */

// ---------------------------------------------------------------------------
// Minimal structural types — no hard imports from pi-mcp-adapter
// ---------------------------------------------------------------------------

/** Minimal pi events bus surface used by this module. */
export interface PiEventBus {
  emit: (event: string, payload: Record<string, unknown>) => void;
}

/** Minimal ExtensionAPI surface expected by mcp integration. */
export interface PiMcpExtensionAPI {
  events?: PiEventBus;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Scope types
// ---------------------------------------------------------------------------

/**
 * Per-stage MCP server gating config.
 * Mirrors the stage-level `mcpServers` declaration in a workflow definition.
 */
export interface McpScopeOpts {
  /**
   * Stage ID scoping this restriction. The adapter may use this to
   * namespace the scope so concurrent stages don't interfere.
   */
  stageId: string;
  /**
   * Server IDs to allow exclusively. When provided, all other servers are
   * implicitly denied for this stage.
   */
  allow?: string[];
  /**
   * Server IDs to deny explicitly. Applied after `allow` when both present.
   */
  deny?: string[];
}

/** Payload shape emitted on `mcp.scope.set`. */
export interface McpScopeSetPayload {
  stageId: string;
  allow: string[] | null;
  deny: string[] | null;
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

/**
 * Emits `mcp.scope.set` so pi-mcp-adapter can restrict MCP server access
 * for the named stage. No-op when `pi.events` is absent (adapter not
 * installed or older runtime without events bus).
 *
 * Usage:
 *   setMcpScope(pi, { stageId, allow: ["github", "fetch"], deny: ["filesystem"] });
 */
export function setMcpScope(pi: PiMcpExtensionAPI, opts: McpScopeOpts): void {
  if (!pi.events) return;

  const payload: McpScopeSetPayload = {
    stageId: opts.stageId,
    allow: opts.allow ?? null,
    deny: opts.deny ?? null,
  };

  pi.events.emit("mcp.scope.set", payload as unknown as Record<string, unknown>);
}

/**
 * Emits `mcp.scope.set` with null allow/deny to restore unrestricted access
 * after a stage completes. No-op when `pi.events` is absent.
 *
 * Usage:
 *   clearMcpScope(pi, stageId);
 */
export function clearMcpScope(pi: PiMcpExtensionAPI, stageId: string): void {
  if (!pi.events) return;

  const payload: McpScopeSetPayload = {
    stageId,
    allow: null,
    deny: null,
  };

  pi.events.emit("mcp.scope.set", payload as unknown as Record<string, unknown>);
}

/**
 * Returns `true` if MCP scope gating is supported (pi.events present).
 * When false, per-stage server restrictions silently have no effect.
 */
export function isMcpScopeSupported(pi: PiMcpExtensionAPI): boolean {
  return pi.events !== undefined && pi.events !== null;
}
