import { basename } from "node:path";
import type { ToolDefinition, ToolExposure } from "./extensions/tool-types.ts";
import { BUILTIN_PATH_PREFIX, type SourceInfo } from "./source-info.ts";

export type ToolSelectionSource =
	| "default-tools-setting"
	| "built-in-defaults"
	| "tools-allowlist"
	| "explicit-selection"
	| "no-built-in-tools"
	| "no-tools";

/** Where the session's starting tool selection came from and what it contained. */
export interface ToolSelectionStatus {
	source: ToolSelectionSource;
	/** Human-readable origin, for example `the defaultTools setting with +codemode`. */
	description: string;
	/** Tool names the selection asked for, in order. */
	names: string[];
	/** `+name`/`-name` entries applied on top of the defaults by the `tools` option or `--tools`. */
	modifiers: string[];
}

export interface ToolStatus {
	name: string;
	active: boolean;
	exposure: ToolExposure;
	/** Human-readable owner, for example `built-in`, `built-in extension "codemode"`, or `extension ./ext.ts`. */
	source: string;
	/** Raw source path: `<builtin:read>`, `builtin:codemode`, an extension file, or `<sdk:name>`. */
	sourcePath: string | undefined;
	/** First line of the tool description. */
	summary: string;
	/** Why the tool is not active and how to enable it. Absent for active tools. */
	inactiveReason?: string;
}

/** A selected tool name with no registered tool behind it, and why. */
export interface UnavailableToolStatus {
	name: string;
	reason: string;
}

export interface ToolStatusReport {
	selection: ToolSelectionStatus;
	/** Every registered tool: active ones first, then inactive ones, each group in registration order. */
	tools: ToolStatus[];
	/** Selected names that no built-in, extension, SDK custom tool, or MCP server registered. */
	missing: UnavailableToolStatus[];
	/** Selected names removed by an exclusion before they could register. */
	excluded: UnavailableToolStatus[];
}

export interface ToolStatusInput {
	tools: ReadonlyArray<{
		definition: Pick<ToolDefinition, "name" | "description" | "exposure" | "namespace" | "defaultActive">;
		sourceInfo?: SourceInfo;
	}>;
	activeToolNames: readonly string[];
	selection: ToolSelectionStatus;
	isExcluded?: (name: string) => boolean;
	/** Present only when the session runs from an explicit tool allowlist. */
	isAllowed?: (name: string) => boolean;
}

export function describeToolSelection(source: ToolSelectionSource, modifiers: readonly string[]): string {
	const origin = {
		"default-tools-setting": "the defaultTools setting",
		"built-in-defaults": "Atomic's default tool set",
		"tools-allowlist": "the --tools allowlist",
		"explicit-selection": "the tools passed to the session",
		"no-built-in-tools": "--no-builtin-tools",
		"no-tools": "--no-tools",
	}[source];
	return modifiers.length > 0 ? `${origin} with ${modifiers.join(" ")}` : origin;
}

function describeSource(sourceInfo: SourceInfo | undefined, namespace: string | undefined): string {
	const owner = (() => {
		if (!sourceInfo) return "unknown";
		const { path, source, origin, configurationOrigin } = sourceInfo;
		if (path.startsWith("<builtin:")) return "built-in";
		if (path.startsWith(BUILTIN_PATH_PREFIX)) return `built-in extension "${path.slice(BUILTIN_PATH_PREFIX.length)}"`;
		if (source === "sdk") return "SDK custom tool";
		if (source === "inline") return `inline extension ${path}`;
		if (configurationOrigin === "bundled") return `bundled package "${basename(source)}"`;
		if (origin === "package") return `package ${source}`;
		return `extension ${path}`;
	})();
	return namespace ? `${owner}, namespace "${namespace}"` : owner;
}

const EXCLUDED_REASON =
	"excluded for this session by --exclude-tools, the excludedTools option, or a mode without user input";

function enableHint(name: string, selection: ToolSelectionStatus): string {
	return selection.names.includes(name)
		? `"${name}" is selected by ${selection.description} but was deactivated during this session`
		: `add "+${name}" to defaultTools or --tools to enable it`;
}

function inactiveReason(
	tool: ToolStatusInput["tools"][number],
	input: ToolStatusInput,
	active: ReadonlySet<string>,
): string {
	const { name, defaultActive } = tool.definition;
	const exposure = tool.definition.exposure ?? "direct";
	if (input.isExcluded?.(name)) return EXCLUDED_REASON;
	if (input.isAllowed && !input.isAllowed(name))
		return `not in the --tools allowlist; add "${name}" to it to enable it`;
	if (exposure === "hidden") return "hidden: never offered to the model";
	if (exposure === "codemode") {
		return active.has("codemode")
			? "callable only from codemode scripts"
			: `callable only from codemode scripts, and codemode is not active; ${enableHint("codemode", input.selection)}`;
	}
	if (exposure === "deferred") {
		return active.has("tool_search")
			? "deferred: the model activates it on demand through tool_search"
			: `deferred until tool_search activates it, and tool_search is not active; ${enableHint("tool_search", input.selection)}`;
	}
	if (input.selection.names.includes(name)) {
		return `selected by ${input.selection.description}, but deactivated during this session`;
	}
	if (defaultActive === false) return `opt-in; ${enableHint(name, input.selection)}`;
	if (tool.sourceInfo?.path.startsWith("<builtin:")) return `not selected; ${enableHint(name, input.selection)}`;
	return "deactivated during this session";
}

function normalizedName(name: string): string {
	return name.toLowerCase().replace(/[-_\s]/g, "");
}

function editDistance(left: string, right: string): number {
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row++) {
		const current = [row];
		for (let column = 1; column <= right.length; column++) {
			const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
			current.push(Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution));
		}
		previous = current;
	}
	return previous[right.length]!;
}

function closestName(name: string, candidates: readonly string[]): string | undefined {
	const target = normalizedName(name);
	const ranked = candidates
		.map((candidate) => ({ candidate, distance: editDistance(target, normalizedName(candidate)) }))
		.filter(({ distance }) => distance <= Math.min(2, Math.floor(target.length / 3)))
		.sort((left, right) => left.distance - right.distance);
	return ranked[0]?.candidate;
}

function missingReason(name: string, selection: ToolSelectionStatus, registered: readonly string[]): string {
	const reason = `selected by ${selection.description}, but no built-in, extension, SDK custom tool, or MCP server has registered a tool named "${name}"`;
	const suggestion = closestName(name, registered);
	return suggestion ? `${reason}; did you mean "${suggestion}"?` : reason;
}

export function buildToolStatusReport(input: ToolStatusInput): ToolStatusReport {
	const active = new Set(input.activeToolNames);
	const statuses = input.tools.map((tool): ToolStatus => {
		const { name, description, namespace } = tool.definition;
		const isActive = active.has(name);
		return {
			name,
			active: isActive,
			exposure: tool.definition.exposure ?? "direct",
			source: describeSource(tool.sourceInfo, namespace?.name),
			sourcePath: tool.sourceInfo?.path,
			summary: description.split("\n")[0]?.trim() ?? "",
			...(isActive ? {} : { inactiveReason: inactiveReason(tool, input, active) }),
		};
	});
	const registered = input.tools.map((tool) => tool.definition.name);
	const unregistered = [...new Set(input.selection.names)].filter(
		(name) => !name.includes("*") && !registered.includes(name),
	);
	return {
		selection: input.selection,
		tools: [...statuses.filter((tool) => tool.active), ...statuses.filter((tool) => !tool.active)],
		missing: unregistered
			.filter((name) => !input.isExcluded?.(name))
			.map((name) => ({ name, reason: missingReason(name, input.selection, registered) })),
		excluded: unregistered
			.filter((name) => input.isExcluded?.(name))
			.map((name) => ({ name, reason: EXCLUDED_REASON })),
	};
}

export interface ToolStatusFormatStyle {
	heading(text: string): string;
	dim(text: string): string;
	warning(text: string): string;
}

const plainStyle: ToolStatusFormatStyle = { heading: (text) => text, dim: (text) => text, warning: (text) => text };

/** Render a report as plain multi-line text; pass a style to add terminal colors. */
export function formatToolStatus(report: ToolStatusReport, style: ToolStatusFormatStyle = plainStyle): string {
	const nameWidth = Math.max(0, ...report.tools.map((tool) => tool.name.length));
	const exposureWidth = Math.max(0, ...report.tools.map((tool) => tool.exposure.length));
	const row = (tool: ToolStatus) =>
		`  ${tool.name.padEnd(nameWidth)}  ${style.dim(tool.exposure.padEnd(exposureWidth))}  ${style.dim(tool.source)}`;
	const lines = [`${style.heading("Tool selection:")} ${report.selection.description}`];
	lines.push(`  ${report.selection.names.length > 0 ? report.selection.names.join(", ") : style.dim("(empty)")}`);
	const activeTools = report.tools.filter((tool) => tool.active);
	const inactiveTools = report.tools.filter((tool) => !tool.active);
	if (report.tools.length === 0) lines.push("", style.dim("No tools are registered."));
	if (activeTools.length > 0) lines.push("", style.heading(`Active (${activeTools.length})`), ...activeTools.map(row));
	if (inactiveTools.length > 0) {
		lines.push("", style.heading(`Inactive (${inactiveTools.length})`));
		for (const tool of inactiveTools) lines.push(row(tool), `    ${style.dim(tool.inactiveReason ?? "")}`);
	}
	if (report.excluded.length > 0) {
		lines.push("", style.heading(`Excluded (${report.excluded.length})`));
		for (const tool of report.excluded) lines.push(`  ${tool.name}`, `    ${style.dim(tool.reason)}`);
	}
	if (report.missing.length > 0) {
		lines.push("", style.warning(`Missing (${report.missing.length})`));
		for (const tool of report.missing) lines.push(`  ${style.warning(tool.name)}`, `    ${style.dim(tool.reason)}`);
	}
	return lines.join("\n");
}
