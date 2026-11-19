import { WindowedContainer } from "@bastani/atomic-tui";
import { ThemedText } from "./components/themed-text.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	type Component,
	type Container,
	type ResourceDiagnostic,
	type SourceInfo,
	Spacer,
	Text,
	theme,
} from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.formatDiagnostics = function (
	this: InteractiveModeBase,
	diagnostics: readonly ResourceDiagnostic[],
	sourceInfos: Map<string, SourceInfo>,
): string {
	const lines: string[] = [];

	// Group collision diagnostics by name
	const collisions = new Map<string, ResourceDiagnostic[]>();
	const otherDiagnostics: ResourceDiagnostic[] = [];

	for (const d of diagnostics) {
		if (d.type === "collision" && d.collision) {
			const list = collisions.get(d.collision.name) ?? [];
			list.push(d);
			collisions.set(d.collision.name, list);
		} else {
			otherDiagnostics.push(d);
		}
	}

	// Format collision diagnostics grouped by name
	for (const [name, collisionList] of collisions) {
		const first = collisionList[0]?.collision;
		if (!first) continue;
		lines.push(theme.fg("warning", `  "${name}" collision:`));
		lines.push(
			theme.fg(
				"dim",
				`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}${
					first.winnerSelector ? ` (default /skill:${name}; exact /skill:${first.winnerSelector})` : ""
				}`,
			),
		);
		for (const d of collisionList) {
			if (d.collision) {
				lines.push(
					theme.fg(
						"dim",
						`    ${theme.fg("warning", d.collision.loserSelector ? "•" : "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))}${
							d.collision.loserSelector ? ` (/skill:${d.collision.loserSelector})` : " (skipped)"
						}`,
					),
				);
			}
		}
	}

	for (const d of otherDiagnostics) {
		if (d.path) {
			const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
		} else {
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
		}
	}

	return lines.join("\n");
};

export interface ResourceRow {
	key: string;
	text: string;
}

export type ResourceDetails = Partial<Record<"context" | "skills" | "prompts" | "extensions", ResourceRow[]>>;

// The click belongs to the section; the viewport anchor belongs to the resource (and its wrapped line).
class ResourceSection extends WindowedContainer {
	readonly expandsOnClick = true;
	readonly spacer = new Spacer(1);
	private readonly heading: ThemedText;
	private readonly compact = new Text("", 0, 0);
	private details: ResourceRow[] = [];
	private rows = new Map<string, Text>();

	readonly name: string;
	private expanded: boolean;

	constructor(name: string, expanded: boolean) {
		super();
		this.name = name;
		this.expanded = expanded;
		this.heading = new ThemedText(() => theme.fg("mdHeading", `[${name}]`));
	}

	update(compact: string, details: ResourceRow[]): void {
		this.compact.setText(compact);
		this.details = details;
		this.setExpanded(this.expanded);
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	clickArea(width: number) {
		return { start: 0, end: this.render(width).length };
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		if (!expanded) {
			this.rows.clear();
			this.children = [this.heading, this.compact];
			return;
		}
		const previous = this.rows;
		this.rows = new Map();
		this.children = [this.heading];
		for (const { key, text } of this.details) {
			const row = previous.get(key) ?? new Text("", 0, 0);
			row.setText(text);
			this.rows.set(key, row);
			this.addChild(row);
		}
	}
}

InteractiveModeBase.prototype.addResourceDisclosure = function (
	this: InteractiveModeBase,
	options: {
		contextFiles: ReadonlyArray<{ path: string }>;
		skills: ReadonlyArray<{ filePath: string; name: string }>;
		prompts: ReadonlyArray<{ filePath: string; name: string }>;
		extensions: ReadonlyArray<{ path: string; sourceInfo?: SourceInfo }>;
		expandedSections: ResourceDetails;
		previousSections?: readonly Component[];
		targetContainer?: Container;
	},
): void {
	const targetContainer = options.targetContainer ?? this.chatContainer;
	const compactList = (values: string[], sort = true): string => {
		const labels = values.map((value) => value.trim()).filter((value) => value.length > 0);
		if (sort) labels.sort((left, right) => left.localeCompare(right));
		return theme.fg("dim", `  ${labels.join(", ")}`);
	};
	const addSection = (name: string, labels: string[], details?: ResourceRow[], sort = true): void => {
		if (labels.length === 0) return;
		const collapsedBody = compactList(labels, sort);
		const section =
			options.previousSections?.find(
				(child): child is ResourceSection => child instanceof ResourceSection && child.name === name,
			) ?? new ResourceSection(name, this.getStartupExpansionState());
		section.update(collapsedBody, details ?? [{ key: name, text: collapsedBody }]);
		targetContainer.addChild(section);
		targetContainer.addChild(section.spacer);
	};

	addSection(
		"Context",
		options.contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)),
		options.expandedSections.context,
		false,
	);
	addSection(
		"Skills",
		options.skills.map((skill) => skill.name),
		options.expandedSections.skills,
	);
	addSection(
		"Prompts",
		options.prompts.map((prompt) => `/${prompt.name}`),
		options.expandedSections.prompts,
	);
	addSection(
		"Extensions",
		this.getCompactExtensionLabels([...options.extensions]),
		options.expandedSections.extensions,
	);
};
