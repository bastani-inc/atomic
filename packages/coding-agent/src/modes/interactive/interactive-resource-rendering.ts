import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type ResourceDiagnostic, type SourceInfo, Spacer, Text, theme } from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.showLoadedResources = function(this: InteractiveModeBase, options?: {
    extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
    force?: boolean;
    showDiagnosticsWhenQuiet?: boolean;
  }): void {
    const showListing =
      options?.force ||
      this.options.verbose ||
      !this.settingsManager.getQuietStartup();
    const showDiagnostics =
      showListing || options?.showDiagnosticsWhenQuiet === true;
    if (!showListing && !showDiagnostics) {
      return;
    }

    const skillsResult = this.session.resourceLoader.getSkills();
    const promptsResult = this.session.resourceLoader.getPrompts();
    const themesResult = this.session.resourceLoader.getThemes();
    const extensions =
      options?.extensions ??
      this.session.resourceLoader
        .getExtensions()
        .extensions.map((extension) => ({
          path: extension.path,
          sourceInfo: extension.sourceInfo,
        }));
    const sourceInfos = new Map<string, SourceInfo>();
    for (const extension of extensions) {
      if (extension.sourceInfo) {
        sourceInfos.set(extension.path, extension.sourceInfo);
      }
    }
    for (const skill of skillsResult.skills) {
      if (skill.sourceInfo) {
        sourceInfos.set(skill.filePath, skill.sourceInfo);
      }
    }
    for (const prompt of promptsResult.prompts) {
      if (prompt.sourceInfo) {
        sourceInfos.set(prompt.filePath, prompt.sourceInfo);
      }
    }
    for (const loadedTheme of themesResult.themes) {
      if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
        sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
      }
    }

    if (showListing) {
      const contextFiles =
        this.session.resourceLoader.getAgentsFiles().agentsFiles;
      const templates = this.session.promptTemplates;
      const customThemes = themesResult.themes.filter((t) => t.sourcePath);

      const expandedSections: string[] = [];
      if (contextFiles.length > 0) {
        expandedSections.push(
          `${theme.bold(theme.fg("muted", "CONTEXT"))}\n${contextFiles
            .map((contextFile) => theme.fg("dim", `  ${this.formatDisplayPath(contextFile.path)}`))
            .join("\n")}`,
        );
      }

      const skills = skillsResult.skills;
      if (skills.length > 0) {
        const groups = this.buildScopeGroups(
          skills.map((skill) => ({
            path: skill.filePath,
            sourceInfo: skill.sourceInfo,
          })),
        );
        expandedSections.push(
          `${theme.bold(theme.fg("muted", "SKILLS"))}\n${this.formatScopeGroups(groups, {
            formatPath: (item) => this.formatDisplayPath(item.path),
            formatPackagePath: (item) =>
              this.getShortPath(item.path, item.sourceInfo),
          })}`,
        );
      }

      if (templates.length > 0) {
        const groups = this.buildScopeGroups(
          templates.map((template) => ({
            path: template.filePath,
            sourceInfo: template.sourceInfo,
          })),
        );
        const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
        expandedSections.push(
          `${theme.bold(theme.fg("muted", "PROMPTS"))}\n${this.formatScopeGroups(groups, {
            formatPath: (item) => {
              const template = templateByPath.get(item.path);
              return template
                ? `/${template.name}`
                : this.formatDisplayPath(item.path);
            },
            formatPackagePath: (item) => {
              const template = templateByPath.get(item.path);
              return template
                ? `/${template.name}`
                : this.formatDisplayPath(item.path);
            },
          })}`,
        );
      }

      const prompts = promptsResult.prompts;
      if (prompts.length > 0) {
        const groups = this.buildScopeGroups(
          prompts.map((prompt) => ({
            path: prompt.filePath,
            sourceInfo: prompt.sourceInfo,
          })),
        );
        const promptByPath = new Map(prompts.map((prompt) => [prompt.filePath, prompt]));
        expandedSections.push(
          `${theme.bold(theme.fg("muted", "PROMPTS"))}\n${this.formatScopeGroups(groups, {
            formatPath: (item) => promptByPath.get(item.path)?.name ?? this.formatDisplayPath(item.path),
            formatPackagePath: (item) => promptByPath.get(item.path)?.name ?? this.formatDisplayPath(item.path),
          })}`,
        );
      }

      if (extensions.length > 0) {
        const groups = this.buildScopeGroups(extensions);
        expandedSections.push(
          `${theme.bold(theme.fg("muted", "EXTENSIONS"))}\n${this.formatScopeGroups(groups, {
            formatPath: (item) => this.formatExtensionDisplayPath(item.path),
            formatPackagePath: (item) =>
              this.formatExtensionDisplayPath(
                this.getShortPath(item.path, item.sourceInfo),
              ),
          })}`,
        );
      }

      if (customThemes.length > 0) {
        const groups = this.buildScopeGroups(
          customThemes.map((loadedTheme) => ({
            path: loadedTheme.sourcePath!,
            sourceInfo: loadedTheme.sourceInfo,
          })),
        );
        expandedSections.push(
          `${theme.bold(theme.fg("muted", "THEMES"))}\n${this.formatScopeGroups(groups, {
            formatPath: (item) => this.formatDisplayPath(item.path),
            formatPackagePath: (item) =>
              this.getShortPath(item.path, item.sourceInfo),
          })}`,
        );
      }

      const extensionDiagnostics: ResourceDiagnostic[] = [];
      const extensionErrors =
        this.session.resourceLoader.getExtensions().errors;
      for (const error of extensionErrors) {
        extensionDiagnostics.push({
          type: "error",
          message: error.error,
          path: error.path,
        });
      }
      extensionDiagnostics.push(
        ...this.session.extensionRunner.getCommandDiagnostics(),
        ...this.getBuiltInCommandConflictDiagnostics(
          this.session.extensionRunner,
        ),
        ...this.session.extensionRunner.getShortcutDiagnostics(),
      );

      this.addResourceDisclosure({
        contextFiles,
        skills,
        prompts,
        templates,
        extensions,
        themes: customThemes,
        diagnosticsTotal: this.getResourceDiagnosticsTotal([
          skillsResult.diagnostics,
          promptsResult.diagnostics,
          extensionDiagnostics,
          themesResult.diagnostics,
        ]),
        expandedBody: this.options.verbose ? expandedSections.join("\n\n") : "",
      });
    }

    if (showDiagnostics) {
      const skillDiagnostics = skillsResult.diagnostics;
      if (skillDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(
          skillDiagnostics,
          sourceInfos,
        );
        this.chatContainer.addChild(
          new Text(
            `${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`,
            0,
            0,
          ),
        );
        this.chatContainer.addChild(new Spacer(1));
      }

      const promptDiagnostics = promptsResult.diagnostics;
      if (promptDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(
          promptDiagnostics,
          sourceInfos,
        );
        this.chatContainer.addChild(
          new Text(
            `${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`,
            0,
            0,
          ),
        );
        this.chatContainer.addChild(new Spacer(1));
      }

      const extensionDiagnostics: ResourceDiagnostic[] = [];
      const extensionErrors =
        this.session.resourceLoader.getExtensions().errors;
      if (extensionErrors.length > 0) {
        for (const error of extensionErrors) {
          extensionDiagnostics.push({
            type: "error",
            message: error.error,
            path: error.path,
          });
        }
      }

      const commandDiagnostics =
        this.session.extensionRunner.getCommandDiagnostics();
      extensionDiagnostics.push(...commandDiagnostics);
      extensionDiagnostics.push(
        ...this.getBuiltInCommandConflictDiagnostics(
          this.session.extensionRunner,
        ),
      );

      const shortcutDiagnostics =
        this.session.extensionRunner.getShortcutDiagnostics();
      extensionDiagnostics.push(...shortcutDiagnostics);

      if (extensionDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(
          extensionDiagnostics,
          sourceInfos,
        );
        this.chatContainer.addChild(
          new Text(
            `${theme.fg("warning", "[Extension issues]")}\n${warningLines}`,
            0,
            0,
          ),
        );
        this.chatContainer.addChild(new Spacer(1));
      }

      const themeDiagnostics = themesResult.diagnostics;
      if (themeDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(
          themeDiagnostics,
          sourceInfos,
        );
        this.chatContainer.addChild(
          new Text(
            `${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`,
            0,
            0,
          ),
        );
        this.chatContainer.addChild(new Spacer(1));
      }
    }
  };
