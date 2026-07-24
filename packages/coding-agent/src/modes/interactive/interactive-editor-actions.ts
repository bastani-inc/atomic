import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { getCapabilities, hyperlink, Spacer, Text, APP_NAME, CHANGELOG_URL, openExternalEditorForText, DynamicBorder, theme } from "./interactive-mode-deps.ts";
import { ExpandableText, isExpandable } from "./interactive-mode-helpers.ts";
import { StartupIdentityComponent } from "./components/startup-identity.ts";

InteractiveModeBase.prototype.refreshBuiltInHeader = function(this: InteractiveModeBase): void {
    if (this.builtInHeader instanceof ExpandableText || this.builtInHeader instanceof StartupIdentityComponent) {
      this.builtInHeader.refresh();
    }
  };

InteractiveModeBase.prototype.updateEditorBorderColor = function(this: InteractiveModeBase): void {
    if (this.isBashMode) {
      this.editor.borderColor = theme.getBashModeBorderColor();
    } else {
      const level = this.session.thinkingLevel || "off";
      this.editor.borderColor = theme.getThinkingBorderColor(level);
    }
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.cycleThinkingLevel = function(this: InteractiveModeBase): void {
    const newLevel = this.session.cycleThinkingLevel();
    if (newLevel === undefined) {
      this.showStatus("Current model does not support thinking");
    } else {
      this.footer.invalidate();
      this.updateEditorBorderColor();
      this.showStatus(`Thinking level: ${newLevel}`);
    }
  };

InteractiveModeBase.prototype.cycleModel = async function(this: InteractiveModeBase, direction: "forward" | "backward"): Promise<void> {
    try {
      const result = await this.session.cycleModel(direction);
      if (result === undefined) {
        const msg =
          this.session.scopedModels.length > 0
            ? "Only one model in scope"
            : "Only one model available";
        this.showStatus(msg);
      } else {
        this.footer.invalidate();
        this.updateEditorBorderColor();
        const thinkingStr =
          result.model.reasoning && result.thinkingLevel !== "off"
            ? ` (thinking: ${result.thinkingLevel})`
            : "";
        this.showStatus(
          `Switched to ${result.model.name || result.model.id}${thinkingStr}`,
        );
        void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
      }
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  };

InteractiveModeBase.prototype.toggleToolOutputExpansion = function(this: InteractiveModeBase): void {
    this.setToolsExpanded(!this.toolOutputExpanded);
  };

InteractiveModeBase.prototype.setToolsExpanded = function(this: InteractiveModeBase, expanded: boolean): void {
    this.toolOutputExpanded = expanded;
    const activeHeader = this.customHeader ?? this.builtInHeader;
    if (isExpandable(activeHeader)) {
      activeHeader.setExpanded(expanded);
    }
    for (const child of this.chatContainer.children) {
      if (isExpandable(child)) {
        child.setExpanded(expanded);
      }
    }
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.toggleThinkingBlockVisibility = function(this: InteractiveModeBase): void {
    this.hideThinkingBlock = !this.hideThinkingBlock;
    this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

    // Rebuild chat from session messages
    this.chatContainer.clear();
    this.rebuildChatFromMessages();

    // If streaming, re-add the streaming component with updated visibility and re-render
    if (this.streamingComponent && this.streamingMessage) {
      this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
      this.streamingComponent.updateContent(this.streamingMessage);
      this.chatContainer.addChild(this.streamingComponent);
    }

    this.showStatus(
      `Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`,
    );
  };

InteractiveModeBase.prototype.openExternalEditor = function(this: InteractiveModeBase): void {
    const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
    const updated = openExternalEditorForText(currentText, this.ui, {
      editorCommand: this.settingsManager.getExternalEditorCommand(),
      showWarning: (message) => this.showWarning(message),
    });
    if (updated !== undefined) this.editor.setText(updated);
  };

InteractiveModeBase.prototype.clearEditor = function(this: InteractiveModeBase): void {
    this.editor.setText("");
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.showError = function(this: InteractiveModeBase, errorMessage: string): void {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(
      new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0),
    );
    this.chatContainer.addChild(new Spacer(1));
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.showWarning = function(this: InteractiveModeBase, warningMessage: string, targetContainer = this.chatContainer): void {
    targetContainer.addChild(new Spacer(1));
    targetContainer.addChild(
      new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0),
    );
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.showNewVersionNotification = function(this: InteractiveModeBase, newVersion: string, targetContainer = this.chatContainer): void {
    const action = theme.fg("accent", `${APP_NAME} update`);
    const updateInstruction =
      theme.fg("muted", `New version ${newVersion} is available. Run `) +
      action;
    const changelogLine = CHANGELOG_URL
      ? `\n${theme.fg("muted", "Changelog: ")}${
          getCapabilities().hyperlinks
            ? hyperlink(theme.fg("accent", "open changelog"), CHANGELOG_URL)
            : theme.fg("accent", CHANGELOG_URL)
        }`
      : "";

    targetContainer.addChild(new Spacer(1));
    targetContainer.addChild(
      new DynamicBorder((text) => theme.fg("warning", text)),
    );
    targetContainer.addChild(
      new Text(
        `${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}${changelogLine}`,
        1,
        0,
      ),
    );
    targetContainer.addChild(
      new DynamicBorder((text) => theme.fg("warning", text)),
    );
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.showPackageUpdateNotification = function(this: InteractiveModeBase, packages: string[], targetContainer = this.chatContainer): void {
    const action = theme.fg("accent", `${APP_NAME} update --extensions`);
    const updateInstruction =
      theme.fg("muted", "Package updates are available. Run ") + action;
    const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

    targetContainer.addChild(new Spacer(1));
    targetContainer.addChild(
      new DynamicBorder((text) => theme.fg("warning", text)),
    );
    targetContainer.addChild(
      new Text(
        `${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
        1,
        0,
      ),
    );
    targetContainer.addChild(
      new DynamicBorder((text) => theme.fg("warning", text)),
    );
    this.ui.requestRender();
  };
