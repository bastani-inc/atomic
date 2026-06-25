import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type Api, type Model, type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions, type SlashCommand, type ExtensionRunner, type ResourceDiagnostic, type SourceInfo, CombinedAutocompleteProvider, fuzzyFilter, hasSupportedCodexFastModeModel, BUILTIN_SLASH_COMMANDS, parseGitUrl, getModelSearchText } from "./interactive-mode-deps.ts";
import { BUILTIN_SLASH_COMMAND_NAMES } from "./interactive-mode-helpers.ts";

const AT_MENTION_PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function findLastAtMentionDelimiter(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (AT_MENTION_PATH_DELIMITERS.has(text[index] ?? "")) return index;
  }
  return -1;
}

function isAtMentionTokenStart(text: string, index: number): boolean {
  return index === 0 || AT_MENTION_PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function findUnclosedAtMentionQuoteStart(text: string): number | null {
  let quoteStart = -1;
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) quoteStart = index;
    }
  }
  return inQuotes ? quoteStart : null;
}

function extractAtMentionPrefix(textBeforeCursor: string): string | null {
  const quoteStart = findUnclosedAtMentionQuoteStart(textBeforeCursor);
  if (quoteStart !== null && quoteStart > 0 && textBeforeCursor[quoteStart - 1] === "@") {
    return isAtMentionTokenStart(textBeforeCursor, quoteStart - 1)
      ? textBeforeCursor.slice(quoteStart - 1)
      : null;
  }
  const lastDelimiterIndex = findLastAtMentionDelimiter(textBeforeCursor);
  const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
  return textBeforeCursor[tokenStart] === "@" ? textBeforeCursor.slice(tokenStart) : null;
}

function atMentionPrefixToPathPrefix(atPrefix: string): string {
  return atPrefix.startsWith('@"') ? `"${atPrefix.slice(2)}` : atPrefix.slice(1);
}

function toAtMentionCompletion(item: AutocompleteItem): AutocompleteItem {
  return {
    ...item,
    value: item.value.startsWith("@") ? item.value : `@${item.value}`,
  };
}

class AtMentionFallbackAutocompleteProvider implements AutocompleteProvider {
  private readonly primary: AutocompleteProvider;
  private readonly pathFallback: AutocompleteProvider;

  constructor(primary: AutocompleteProvider, pathFallback: AutocompleteProvider) {
    this.primary = primary;
    this.pathFallback = pathFallback;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const primarySuggestions = await this.primary.getSuggestions(lines, cursorLine, cursorCol, options);
    if (primarySuggestions || options.signal.aborted) return primarySuggestions;

    const currentLine = lines[cursorLine] ?? "";
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    const atPrefix = extractAtMentionPrefix(textBeforeCursor);
    if (!atPrefix) return null;

    const pathPrefix = atMentionPrefixToPathPrefix(atPrefix);
    const prefixStart = cursorCol - atPrefix.length;
    const fallbackLines = [...lines];
    fallbackLines[cursorLine] = `${currentLine.slice(0, prefixStart)}${pathPrefix}${currentLine.slice(cursorCol)}`;
    const fallbackSuggestions = await this.pathFallback.getSuggestions(
      fallbackLines,
      cursorLine,
      prefixStart + pathPrefix.length,
      { ...options, force: true },
    );
    if (!fallbackSuggestions) return null;

    return {
      prefix: atPrefix,
      items: fallbackSuggestions.items.map(toAtMentionCompletion),
    };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.primary.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.primary.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
  }
}

InteractiveModeBase.prototype.getAutocompleteSourceTag = function(this: InteractiveModeBase, sourceInfo?: SourceInfo): string | undefined {
    if (!sourceInfo) {
      return undefined;
    }

    const scopePrefix =
      sourceInfo.scope === "user"
        ? "u"
        : sourceInfo.scope === "project"
          ? "p"
          : "t";
    const source = sourceInfo.source.trim();

    if (source === "auto" || source === "local" || source === "cli") {
      return scopePrefix;
    }

    if (source.startsWith("npm:")) {
      return `${scopePrefix}:${source}`;
    }

    const gitSource = parseGitUrl(source);
    if (gitSource) {
      const ref = gitSource.ref ? `@${gitSource.ref}` : "";
      return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
    }

    return scopePrefix;
  };

InteractiveModeBase.prototype.prefixAutocompleteDescription = function(this: InteractiveModeBase, description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
    const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
    if (!sourceTag) {
      return description;
    }
    return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
  };

InteractiveModeBase.prototype.getBuiltInCommandConflictDiagnostics = function(this: InteractiveModeBase, extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
    return extensionRunner
      .getRegisteredCommands()
      .filter((command) => BUILTIN_SLASH_COMMAND_NAMES.has(command.name))
      .map((command) => ({
        type: "warning" as const,
        message:
          command.invocationName === command.name
            ? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
            : `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
        path: command.sourceInfo.path,
      }));
  };

InteractiveModeBase.prototype.getCodexFastModeCandidateModels = function(this: InteractiveModeBase): Model<Api>[] {
    if (this.session.scopedModels.length > 0) {
      return this.session.scopedModels
        .map((scoped) => scoped.model)
        .filter((model) => this.session.modelRegistry.hasConfiguredAuth(model));
    }

    return this.session.modelRegistry.getAvailable();
  };

InteractiveModeBase.prototype.hasCodexFastModeSupportedModels = function(this: InteractiveModeBase): boolean {
    return hasSupportedCodexFastModeModel(
      this.getCodexFastModeCandidateModels(),
    );
  };

InteractiveModeBase.prototype.createBaseAutocompleteProvider = function(this: InteractiveModeBase): AutocompleteProvider {
    // Define commands for autocomplete
    const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.filter(
      (command) => command.name !== "fast" || this.hasCodexFastModeSupportedModels(),
    ).map((command) => ({
      name: command.name,
      description: command.description,
      getArgumentCompletions: command.getArgumentCompletions,
    }));

    const modelCommand = slashCommands.find(
      (command) => command.name === "model",
    );
    if (modelCommand) {
      modelCommand.getArgumentCompletions = (
        prefix: string,
      ): AutocompleteItem[] | null => {
        // Get available models (scoped or from registry)
        const models =
          this.session.scopedModels.length > 0
            ? this.session.scopedModels.map((s) => s.model)
            : this.session.modelRegistry.getAvailable();

        if (models.length === 0) return null;

        // Create items with provider/id format
        const items = models.map((m) => ({
          id: m.id,
          provider: m.provider,
          name: m.name,
          label: `${m.provider}/${m.id}`,
        }));

        // Fuzzy filter by model ID + provider in either order.
        const filtered = fuzzyFilter(items, prefix, getModelSearchText);

        if (filtered.length === 0) return null;

        return filtered.map((item) => ({
          value: item.label,
          label: item.id,
          description: item.provider,
        }));
      };
    }

    // Convert prompt templates to SlashCommand format for autocomplete
    const templateCommands: SlashCommand[] = this.session.promptTemplates.map(
      (cmd) => ({
        name: cmd.name,
        description: this.prefixAutocompleteDescription(
          cmd.description,
          cmd.sourceInfo,
        ),
        ...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
      }),
    );

    // Convert extension commands to SlashCommand format. Built-in command names
    // stay reserved even when a built-in is contextually hidden (for example,
    // /fast without a supported OpenAI model) so extension visibility cannot
    // change as auth/model state changes.
    const extensionCommands: SlashCommand[] = this.session.extensionRunner
      .getRegisteredCommands()
      .filter((cmd) => !BUILTIN_SLASH_COMMAND_NAMES.has(cmd.name))
      .map((cmd) => ({
        name: cmd.invocationName,
        description: this.prefixAutocompleteDescription(
          cmd.description,
          cmd.sourceInfo,
        ),
        getArgumentCompletions: cmd.getArgumentCompletions,
      }));

    // Build skill commands from session.skills (if enabled)
    this.skillCommands.clear();
    const skillCommandList: SlashCommand[] = [];
    if (this.settingsManager.getEnableSkillCommands()) {
      for (const skill of this.session.resourceLoader.getSkills().skills) {
        const commandName = `skill:${skill.name}`;
        this.skillCommands.set(commandName, skill.filePath);
        skillCommandList.push({
          name: commandName,
          description: this.prefixAutocompleteDescription(
            skill.description,
            skill.sourceInfo,
          ),
        });
      }
    }

    const commands = [
      ...slashCommands,
      ...templateCommands,
      ...extensionCommands,
      ...skillCommandList,
    ];
    const cwd = this.sessionManager.getCwd();
    return new AtMentionFallbackAutocompleteProvider(
      new CombinedAutocompleteProvider(commands, cwd, this.fdPath),
      new CombinedAutocompleteProvider(commands, cwd, null),
    );
  };

InteractiveModeBase.prototype.setupAutocompleteProvider = function(this: InteractiveModeBase): void {
    let provider = this.createBaseAutocompleteProvider();
    for (const wrapProvider of this.autocompleteProviderWrappers) {
      provider = wrapProvider(provider);
    }

    this.autocompleteProvider = provider;
    this.defaultEditor.setAutocompleteProvider(provider);
    if (this.editor !== this.defaultEditor) {
      this.editor.setAutocompleteProvider?.(provider);
    }
  };
