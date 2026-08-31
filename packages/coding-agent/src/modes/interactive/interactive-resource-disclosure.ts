import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type Container, type ResourceDiagnostic, type SourceInfo, Spacer, theme } from "./interactive-mode-deps.ts";
import { ExpandableText } from "./interactive-mode-helpers.ts";

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

InteractiveModeBase.prototype.addResourceDisclosure = function (
	this: InteractiveModeBase,
	options: {
		contextFiles: ReadonlyArray<{ path: string }>;
		skills: ReadonlyArray<{ filePath: string; name: string }>;
		prompts: ReadonlyArray<{ filePath: string; name: string }>;
		extensions: ReadonlyArray<{ path: string; sourceInfo?: SourceInfo }>;
		themes: ReadonlyArray<{ name?: string; sourcePath?: string; sourceInfo?: SourceInfo }>;
		expandedSections: {
			context?: string;
			skills?: string;
			prompts?: string;
			extensions?: string;
			themes?: string;
		};
		targetContainer?: Container;
	},
): void {
	const targetContainer = options.targetContainer ?? this.chatContainer;
	const compactList = (values: string[], sort = true): string => {
		const labels = values.map((value) => value.trim()).filter((value) => value.length > 0);
		if (sort) labels.sort((left, right) => left.localeCompare(right));
		return theme.fg("dim", `  ${labels.join(", ")}`);
	};
	const addSection = (name: string, labels: string[], expandedBody?: string, sort = true): void => {
		if (labels.length === 0) return;
		const collapsedBody = compactList(labels, sort);
		targetContainer.addChild(
			new ExpandableText(
				() => `${theme.fg("mdHeading", `[${name}]`)}\n${collapsedBody}`,
				() => `${theme.fg("mdHeading", `[${name}]`)}\n${expandedBody ?? collapsedBody}`,
				this.getStartupExpansionState(),
				0,
				0,
			),
		);
		targetContainer.addChild(new Spacer(1));
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
	addSection(
		"Themes",
		options.themes.map(
			(loadedTheme) =>
				loadedTheme.name ??
				(loadedTheme.sourcePath
					? this.getCompactPathLabel(loadedTheme.sourcePath, loadedTheme.sourceInfo)
					: "theme"),
		),
		options.expandedSections.themes,
	);
};
