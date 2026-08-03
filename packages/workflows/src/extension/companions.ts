/**
 * Companion-package detection helpers.
 *
 * Why this exists:
 *   `@bastani/workflows` orchestrates a few first-party pi packages
 *   at runtime (delegation, MCP access, HIL bridge, web fetch). They are
 *   installed independently of workflows so pi's npm-identity
 *   dedup can share them with any other extensions the user already has
 *   (see pi docs/packages.md → "Scope and Deduplication"). Bundling them
 *   via `bundledDependencies` produced a parallel "local-path" identity
 *   that bypassed dedup and yielded `Tool "mcp" conflicts with ...` /
 *   `Tool "subagent" conflicts with ...` errors on load.
 *
 *   The trade-off of independent installs is that we cannot reach in and
 *   require() them — we instead **detect** their presence by inspecting
 *   pi's slash-command and tool registries.
 *
 * Detection is intentionally best-effort and structural:
 *   1. Path hints (preferred): `pi.getCommands()[].sourceInfo.path` /
 *      `.baseDir` typically include the package name (e.g.
 *      `.../node_modules/pi-subagents/...`). This survives command/tool
 *      renames in upstream packages.
 *   2. Command-name hints (fallback): a distinctive slash command
 *      registered by the companion.
 *   3. Tool-name hints (fallback): a registered tool name (e.g. `mcp`).
 *
 * Any match counts as "installed".
 *
 * cross-ref:
 *  - pi docs/packages.md → "Scope and Deduplication"
 */

import type { ExtensionAPI } from "./index.js";

// ---------------------------------------------------------------------------
// Companion catalogue
// ---------------------------------------------------------------------------

/** One entry per companion pi package workflows can use at runtime. */
export interface CompanionSpec {
	/** Display name, e.g. `pi-subagents`. */
	readonly name: string;
	/** Install spec used for setup hints: `npm:pi-subagents`. */
	readonly installSpec: string;
	/** One-line description shown beside the status. */
	readonly purpose: string;
	/**
	 * Path-fragment hints matched against `sourceInfo.path` / `.baseDir`.
	 * First match wins. Prefer this over name hints — surviving renames.
	 */
	readonly pathHints: readonly string[];
	/** Slash-command names registered by the package (without the leading `/`). */
	readonly commandHints: readonly string[];
	/** Registered tool names (matched against `pi.getAllTools()[].name`). */
	readonly toolHints: readonly string[];
}

/**
 * Ordered companion catalogue. Order is preserved across detection
 * outputs so any UI surfacing companions can render a stable layout.
 */
export const COMPANIONS: readonly CompanionSpec[] = [
	{
		name: "pi-subagents",
		installSpec: "npm:pi-subagents",
		purpose: "delegate stages to focused child agents",
		pathHints: ["/pi-subagents/", "/pi-subagents-", "/pi-subagents."],
		commandHints: ["subagents-doctor", "run", "chain", "parallel", "run-chain"],
		toolHints: ["subagent"],
	},
	{
		name: "pi-mcp-adapter",
		installSpec: "npm:pi-mcp-adapter",
		purpose: "MCP servers through one proxy tool (no context bloat)",
		pathHints: ["/pi-mcp-adapter/", "/pi-mcp-adapter-", "/pi-mcp-adapter."],
		commandHints: ["mcp"],
		toolHints: ["mcp"],
	},
	{
		name: "pi-web-access",
		installSpec: "npm:pi-web-access",
		purpose: "fetch and search the web from inside a stage",
		pathHints: ["/pi-web-access/", "/pi-web-access-", "/pi-web-access."],
		commandHints: ["web", "web-access"],
		toolHints: ["web_fetch", "web_search", "web"],
	},
	{
		name: "pi-intercom",
		installSpec: "npm:pi-intercom",
		purpose: "child agents talk back to the parent session (HIL)",
		pathHints: ["/pi-intercom/", "/pi-intercom-", "/pi-intercom."],
		commandHints: ["intercom"],
		toolHints: ["intercom", "contact_supervisor"],
	},
] as const;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface CompanionStatus {
	readonly companion: CompanionSpec;
	readonly installed: boolean;
	/** Human-readable signal that drove the verdict — empty when missing. */
	readonly evidence?: string;
}

/**
 * Surface used for detection. Kept narrow so tests can stub it without
 * the full `ExtensionAPI`.
 */
export interface CompanionProbeApi {
	readonly getCommands?: () => ReadonlyArray<CommandProbe>;
	readonly getAllTools?: () => ReadonlyArray<ToolProbe>;
}

interface CommandProbe {
	readonly name: string;
	readonly sourceInfo?: { readonly path?: string; readonly baseDir?: string };
}

interface ToolProbe {
	readonly name: string;
	readonly sourceInfo?: { readonly path?: string; readonly baseDir?: string };
}

/**
 * Inspect pi's registries and return one status per companion in the
 * catalogue order. Pure of side effects.
 */
export function detectCompanions(pi: ExtensionAPI | CompanionProbeApi): readonly CompanionStatus[] {
	const probe = pi as CompanionProbeApi;
	const commands = safeProbeList(probe.getCommands);
	const tools = safeProbeList(probe.getAllTools);

	return COMPANIONS.map((companion) => detectOne(companion, commands, tools));
}

function detectOne(
	companion: CompanionSpec,
	commands: readonly CommandProbe[],
	tools: readonly ToolProbe[],
): CompanionStatus {
	// 1. Path hints — most reliable (survives upstream renames).
	const pathHit = findPathHit(commands, tools, companion.pathHints);
	if (pathHit) return { companion, installed: true, evidence: `path ${pathHit}` };

	// 2. Command-name hints.
	for (const name of companion.commandHints) {
		if (commands.some((c) => c.name === name)) {
			return { companion, installed: true, evidence: `command /${name}` };
		}
	}

	// 3. Tool-name hints.
	for (const name of companion.toolHints) {
		if (tools.some((t) => t.name === name)) {
			return { companion, installed: true, evidence: `tool ${name}` };
		}
	}

	return { companion, installed: false };
}

function findPathHit(
	commands: readonly CommandProbe[],
	tools: readonly ToolProbe[],
	hints: readonly string[],
): string | undefined {
	const haystacks: string[] = [];
	for (const c of commands) {
		if (c.sourceInfo?.path) haystacks.push(c.sourceInfo.path);
		if (c.sourceInfo?.baseDir) haystacks.push(c.sourceInfo.baseDir);
	}
	for (const t of tools) {
		if (t.sourceInfo?.path) haystacks.push(t.sourceInfo.path);
		if (t.sourceInfo?.baseDir) haystacks.push(t.sourceInfo.baseDir);
	}
	for (const hint of hints) {
		const hit = haystacks.find((p) => p.includes(hint));
		if (hit) return shortenForEvidence(hit);
	}
	return undefined;
}

function safeProbeList<T>(probe: undefined | (() => ReadonlyArray<T>)): readonly T[] {
	if (typeof probe !== "function") return [];
	try {
		const result = probe();
		return Array.isArray(result) ? result : [];
	} catch {
		return [];
	}
}

/**
 * Shorten a node_modules path so the evidence row stays readable.
 * `…/node_modules/pi-subagents/dist/extension.ts` → `pi-subagents/dist/extension.ts`.
 */
function shortenForEvidence(p: string): string {
	const marker = "/node_modules/";
	const idx = p.lastIndexOf(marker);
	if (idx >= 0) return p.slice(idx + marker.length);
	// Some installs (git, local) land under `~/.atomic/extensions/<name>` —
	// surface the trailing `extensions/<name>/…` segment instead.
	const extMarker = "/extensions/";
	const extIdx = p.lastIndexOf(extMarker);
	if (extIdx >= 0) return p.slice(extIdx + 1);
	return p;
}
