import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type Container, type ResourceDiagnostic, type SourceInfo, Spacer, theme } from "./interactive-mode-deps.ts";
import { ExpandableText } from "./interactive-mode-helpers.ts";

InteractiveModeBase.prototype.formatDiagnostics = function(this: InteractiveModeBase, diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
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
          `    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
        ),
      );
      for (const d of collisionList) {
        if (d.collision) {
          lines.push(
            theme.fg(
              "dim",
              `    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
            ),
          );
        }
      }
    }

    for (const d of otherDiagnostics) {
      if (d.path) {
        const formattedPath = this.formatPathWithSource(
          d.path,
          this.findSourceInfoForPath(d.path, sourceInfos),
        );
        lines.push(
          theme.fg(
            d.type === "error" ? "error" : "warning",
            `  ${formattedPath}`,
          ),
        );
        lines.push(
          theme.fg(
            d.type === "error" ? "error" : "warning",
            `    ${d.message}`,
          ),
        );
      } else {
        lines.push(
          theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`),
        );
      }
    }

    return lines.join("\n");
  };

InteractiveModeBase.prototype.getResourceDiagnosticsTotal = function(this: InteractiveModeBase, values: ResourceDiagnostic[][]): number {
    return values.reduce((total, diagnostics) => total + diagnostics.length, 0);
  };

InteractiveModeBase.prototype.formatResourceCount = function(this: InteractiveModeBase, count: number, singular: string, plural = `${singular}s`): string | undefined {
    if (count <= 0) {
      return undefined;
    }
    return `${count} ${count === 1 ? singular : plural}`;
  };

InteractiveModeBase.prototype.addResourceDisclosure = function(this: InteractiveModeBase, options: {
    contextFiles: ReadonlyArray<{ path: string }>;
    skills: ReadonlyArray<{ filePath: string; name: string }>;
    prompts: ReadonlyArray<{ filePath: string; name: string }>;
    templates: ReadonlyArray<{ filePath: string; name: string }>;
    extensions: ReadonlyArray<{ path: string; sourceInfo?: SourceInfo }>;
    themes: ReadonlyArray<{ name?: string; sourcePath?: string }>;
    diagnosticsTotal: number;
    expandedBody: string;
    targetContainer?: Container;
  }): void {
    const contextLabels = options.contextFiles.map((contextFile) =>
      this.formatContextPath(contextFile.path),
    );
    const promptCount = options.prompts.length + options.templates.length;
    const summaryParts = [
      contextLabels.length > 0 ? contextLabels.join(", ") : "context ready",
      this.formatResourceCount(options.skills.length, "skill"),
      this.formatResourceCount(promptCount, "prompt"),
      this.formatResourceCount(options.extensions.length, "extension"),
      this.formatResourceCount(options.themes.length, "theme"),
      this.formatResourceCount(options.diagnosticsTotal, "issue"),
    ].filter((part): part is string => part !== undefined && part.length > 0);

    const collapsed = `${theme.bold(theme.fg("muted", "RESOURCES"))} ${theme.fg("muted", summaryParts.join(" · "))}`;

    const ok = theme.fg("success", "✓");
    const pending = theme.fg("dim", "○");
    const sep = theme.fg("dim", " · ");
    const label = (value: string) => theme.bold(theme.fg("text", value.padEnd(10)));
    const mutedList = (values: string[], maxItems = 4) => {
      if (values.length === 0) {
        return theme.fg("dim", "none");
      }
      const shown = values.slice(0, maxItems).join(", ");
      const suffix = values.length > maxItems ? `, +${values.length - maxItems}` : "";
      return theme.fg("dim", `${shown}${suffix}`);
    };

    const extensionLabels = this.getCompactExtensionLabels([...options.extensions]);
    const themeLabels = options.themes.map((loadedTheme) =>
      loadedTheme.name ??
      (loadedTheme.sourcePath
        ? this.getCompactPathLabel(loadedTheme.sourcePath, undefined)
        : "theme"),
    );
    const expandedSummary = [
      `${ok} ${label("Ready")} ${contextLabels.length > 0 ? contextLabels.join(", ") : "context loaded"}`,
      `${ok} ${label("Skills")} ${options.skills.length} available${sep}${mutedList(options.skills.map((skill) => skill.name))}`,
      `${ok} ${label("Prompts")} ${promptCount} available${sep}${mutedList([
        ...options.templates.map((template) => `/${template.name}`),
        ...options.prompts.map((prompt) => prompt.name),
      ])}`,
      `${ok} ${label("Extensions")} ${options.extensions.length} available${sep}${mutedList(extensionLabels)}`,
    ];

    if (themeLabels.length > 0) {
      expandedSummary.push(
        `${ok} ${label("Themes")} ${themeLabels.length} loaded${sep}${mutedList(themeLabels)}`,
      );
    }
    if (options.diagnosticsTotal > 0) {
      expandedSummary.push(
        `${pending} ${label("Issues")} ${options.diagnosticsTotal} noted${sep}${theme.fg("dim", "details below")}`,
      );
    }

    const expanded = `${collapsed}\n${expandedSummary.join("\n")}${
      options.expandedBody.length > 0 ? `\n\n${options.expandedBody}` : ""
    }`;

    const targetContainer = options.targetContainer ?? this.chatContainer;
    targetContainer.addChild(
      new ExpandableText(
        () => collapsed,
        () => expanded,
        this.getStartupExpansionState(),
        0,
        0,
      ),
    );
    targetContainer.addChild(new Spacer(1));
  };
