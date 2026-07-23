import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type Keybinding, type AppKeybinding, fs, path, Markdown, Spacer, Text, visibleWidth, getDebugLogPath, ArminComponent, DaxnutsComponent, DynamicBorder, EarendilAnnouncementComponent, formatKeyText, keyDisplayText, theme } from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.getAppKeyDisplay = function(this: InteractiveModeBase, action: AppKeybinding): string {
    return keyDisplayText(action);
  };

InteractiveModeBase.prototype.getEditorKeyDisplay = function(this: InteractiveModeBase, action: Keybinding): string {
    return keyDisplayText(action);
  };

InteractiveModeBase.prototype.handleHotkeysCommand = function(this: InteractiveModeBase): void {
    // Navigation keybindings
    const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
    const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
    const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
    const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
    const cursorWordLeft = this.getEditorKeyDisplay(
      "tui.editor.cursorWordLeft",
    );
    const cursorWordRight = this.getEditorKeyDisplay(
      "tui.editor.cursorWordRight",
    );
    const cursorLineStart = this.getEditorKeyDisplay(
      "tui.editor.cursorLineStart",
    );
    const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
    const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
    const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
    const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
    const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

    // Editing keybindings
    const submit = this.getEditorKeyDisplay("tui.input.submit");
    const newLine = this.getEditorKeyDisplay("tui.input.newLine");
    const deleteWordBackward = this.getEditorKeyDisplay(
      "tui.editor.deleteWordBackward",
    );
    const deleteWordForward = this.getEditorKeyDisplay(
      "tui.editor.deleteWordForward",
    );
    const deleteToLineStart = this.getEditorKeyDisplay(
      "tui.editor.deleteToLineStart",
    );
    const deleteToLineEnd = this.getEditorKeyDisplay(
      "tui.editor.deleteToLineEnd",
    );
    const yank = this.getEditorKeyDisplay("tui.editor.yank");
    const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
    const undo = this.getEditorKeyDisplay("tui.editor.undo");
    const tab = this.getEditorKeyDisplay("tui.input.tab");

    // App keybindings
    const interrupt = this.getAppKeyDisplay("app.interrupt");
    const clear = this.getAppKeyDisplay("app.clear");
    const exit = this.getAppKeyDisplay("app.exit");
    const suspend = this.getAppKeyDisplay("app.suspend");
    const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
    const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
    const selectModel = this.getAppKeyDisplay("app.model.select");
    const expandTools = this.getAppKeyDisplay("app.tools.expand");
    const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
    const externalEditor = this.getAppKeyDisplay("app.editor.external");
    const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
    const followUp = this.getAppKeyDisplay("app.message.followUp");
    const dequeue = this.getAppKeyDisplay("app.message.dequeue");
    const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");

    let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (ctrl+enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

    // Add extension-registered shortcuts
    const extensionRunner = this.session.extensionRunner;
    const shortcuts = extensionRunner.getShortcuts(
      this.keybindings.getEffectiveConfig(),
    );
    if (shortcuts.size > 0) {
      hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
      for (const [key, shortcut] of shortcuts) {
        const description = shortcut.description ?? shortcut.extensionPath;
        const keyDisplay = formatKeyText(key, { capitalize: true });
        hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
      }
    }

    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new DynamicBorder());
    this.chatContainer.addChild(
      new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0),
    );
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(
      new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()),
    );
    this.chatContainer.addChild(new DynamicBorder());
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.handleClearCommand = async function(this: InteractiveModeBase): Promise<void> {
    await this.ensureDeferredStartupComplete();
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = undefined;
    }
    this.statusContainer.clear();
    try {
      const result = await this.runtimeHost.newSession();
      if (result.cancelled) {
        return;
      }
      this.renderCurrentSessionState();
      if (this.firstRunNoticeVisible) {
        this.clearFirstRunOnboardingUi();
      }
      this.chatContainer.addChild(new Spacer(1));
      this.chatContainer.addChild(
        new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1),
      );
      this.ui.requestRender();
    } catch (error: unknown) {
      await this.handleFatalRuntimeError("Failed to create session", error);
    }
  };

InteractiveModeBase.prototype.handleDebugCommand = function(this: InteractiveModeBase): void {
    const width = this.ui.terminal.columns;
    const height = this.ui.terminal.rows;
    const allLines = this.ui.render(width);

    const debugLogPath = getDebugLogPath();
    const debugData = [
      `Debug output at ${new Date().toISOString()}`,
      `Terminal: ${width}x${height}`,
      `Total lines: ${allLines.length}`,
      "",
      "=== All rendered lines with visible widths ===",
      ...allLines.map((line, idx) => {
        const vw = visibleWidth(line);
        const escaped = JSON.stringify(line);
        return `[${idx}] (w=${vw}) ${escaped}`;
      }),
      "",
      "=== Agent messages (JSONL) ===",
      ...this.session.messages.map((msg) => JSON.stringify(msg)),
      "",
    ].join("\n");

    fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
    fs.writeFileSync(debugLogPath, debugData);

    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(
      new Text(
        `${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`,
        1,
        1,
      ),
    );
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.handleArminSaysHi = function(this: InteractiveModeBase): void {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new ArminComponent(this.ui));
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.handleDementedDelves = function(this: InteractiveModeBase): void {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new EarendilAnnouncementComponent());
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.handleDaxnuts = function(this: InteractiveModeBase): void {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new DaxnutsComponent(this.ui));
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.checkDaxnutsEasterEgg = function(this: InteractiveModeBase, model: { provider: string; id: string }): void {
    if (
      model.provider === "opencode" &&
      model.id.toLowerCase().includes("kimi-k2.5")
  ) {
      this.handleDaxnuts();
    }
  };
