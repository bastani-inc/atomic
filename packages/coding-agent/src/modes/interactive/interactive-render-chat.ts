import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type AgentMessage, type Component, type VerbatimCompactionResult, type SessionContext, type TruncationResult, type ChatMessageEntry, type ChatMessageRenderOptions, Spacer, Text, parseSkillBlock, AssistantMessageComponent, BashExecutionComponent, BranchSummaryMessageComponent, chatEntriesFromAgentMessages, renderChatMessageEntry, addChatTranscriptEntry, CompactionBoundaryMessageComponent, CustomMessageComponent, SkillInvocationMessageComponent, ToolExecutionComponent, UserMessageComponent, recordTimeSinceReset, theme } from "./interactive-mode-deps.ts";
import { yieldToEventLoop } from "../../utils/event-loop.ts";
import { VERBATIM_COMPACTION_PREFIX } from "../../core/messages.ts";

InteractiveModeBase.prototype.showStatus = function(this: InteractiveModeBase, message: string): void {
    const children = this.chatContainer.children;
    const last =
      children.length > 0 ? children[children.length - 1] : undefined;
    const secondLast =
      children.length > 1 ? children[children.length - 2] : undefined;

    if (
      last &&
      secondLast &&
      last === this.lastStatusText &&
      secondLast === this.lastStatusSpacer
  ) {
      this.lastStatusText.setText(theme.fg("dim", message));
      this.ui.requestRender();
      return;
    }

    const spacer = new Spacer(1);
    const text = new Text(theme.fg("dim", message), 1, 0);
    this.chatContainer.addChild(spacer);
    this.chatContainer.addChild(text);
    this.lastStatusSpacer = spacer;
    this.lastStatusText = text;
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.renderDeferredUserInput = function(this: InteractiveModeBase, text: string): void {
    this.deferredRenderedUserInputs.push(text);
    const startIndex = this.chatContainer.children.length;
    this.addMessageToChat({ role: "user", content: text } as AgentMessage);
    const renderedComponents = this.chatContainer.children.slice(startIndex);
    const trackedComponents = this.deferredRenderedUserInputComponents.get(text) ?? [];
    trackedComponents.push(renderedComponents);
    this.deferredRenderedUserInputComponents.set(text, trackedComponents);
    this.updatePendingMessagesDisplay();
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.consumeDeferredRenderedUserInput = function(this: InteractiveModeBase, text: string): boolean {
    const index = this.deferredRenderedUserInputs.indexOf(text);
    if (index === -1) return false;
    this.deferredRenderedUserInputs.splice(index, 1);
    const trackedComponents = this.deferredRenderedUserInputComponents.get(text);
    trackedComponents?.shift();
    if (trackedComponents && trackedComponents.length === 0) {
      this.deferredRenderedUserInputComponents.delete(text);
    }
    return true;
  };

InteractiveModeBase.prototype.discardDeferredRenderedUserInput = function(this: InteractiveModeBase, text: string): void {
    const index = this.deferredRenderedUserInputs.indexOf(text);
    if (index !== -1) this.deferredRenderedUserInputs.splice(index, 1);
    const trackedComponents = this.deferredRenderedUserInputComponents.get(text);
    const componentsToRemove = trackedComponents?.shift();
    if (trackedComponents && trackedComponents.length === 0) {
      this.deferredRenderedUserInputComponents.delete(text);
    }
    if (!componentsToRemove) return;
    for (const component of componentsToRemove) {
      this.chatContainer.removeChild(component);
    }
    this.updatePendingMessagesDisplay();
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.chatMessageRenderOptions = function(this: InteractiveModeBase): ChatMessageRenderOptions {
    return {
      ui: this.ui,
      cwd: this.sessionManager.getCwd(),
      markdownTheme: this.getMarkdownThemeWithSettings(),
      hideThinkingBlock: this.hideThinkingBlock,
      hiddenThinkingLabel: this.hiddenThinkingLabel,
      toolOutputExpanded: this.toolOutputExpanded,
      showImages: this.settingsManager.getShowImages(),
      imageWidthCells: this.settingsManager.getImageWidthCells(),
      outputPad: this.outputPad,
      getToolDefinition: (toolName) => this.getRegisteredToolDefinition(toolName),
      getCustomMessageRenderer: (customType) =>
        this.session.extensionRunner.getMessageRenderer(customType),
    };
  };

InteractiveModeBase.prototype.addRenderedChatEntry = function(this: InteractiveModeBase, entry: ChatMessageEntry): Component {
    const component = renderChatMessageEntry(entry, this.chatMessageRenderOptions());
    addChatTranscriptEntry(this.chatContainer, component, entry.role);
    return component;
  };

InteractiveModeBase.prototype.addCompactionBoundaryToChat = function(this: InteractiveModeBase, result: VerbatimCompactionResult): void {
    this.chatContainer.addChild(new Spacer(1));
    const component = new CompactionBoundaryMessageComponent(result);
    component.setExpanded(this.toolOutputExpanded);
    this.chatContainer.addChild(component);
  };

InteractiveModeBase.prototype.addMessageToChat = function(this: InteractiveModeBase, message: AgentMessage, options?: { populateHistory?: boolean }): void {
    switch (message.role) {
      case "bashExecution": {
        const component = new BashExecutionComponent(
          message.command,
          this.ui,
          message.excludeFromContext,
        );
        if (message.output) {
          component.appendOutput(message.output);
        }
        component.setComplete(
          message.exitCode,
          message.cancelled,
          message.truncated
            ? ({ truncated: true } as TruncationResult)
            : undefined,
          message.fullOutputPath,
        );
        this.chatContainer.addChild(component);
        break;
      }
      case "custom": {
        if (message.display) {
          const renderer = this.session.extensionRunner.getMessageRenderer(
            message.customType,
          );
          const component = new CustomMessageComponent(
            message,
            renderer,
            this.getMarkdownThemeWithSettings(),
          );
          component.setExpanded(this.toolOutputExpanded);
          this.chatContainer.addChild(component);
        }
        break;
      }
      case "branchSummary": {
        this.chatContainer.addChild(new Spacer(1));
        const component = new BranchSummaryMessageComponent(
          message,
          this.getMarkdownThemeWithSettings(),
        );
        component.setExpanded(this.toolOutputExpanded);
        this.chatContainer.addChild(component);
        break;
      }
      case "user": {
        const textContent = this.getUserMessageText(message);
        if (textContent) {
          if (this.chatContainer.children.length > 0) {
            this.chatContainer.addChild(new Spacer(1));
          }
          const skillBlock = parseSkillBlock(textContent);
          if (skillBlock) {
            // Render skill block (collapsible)
            const component = new SkillInvocationMessageComponent(
              skillBlock,
              this.getMarkdownThemeWithSettings(),
            );
            component.setExpanded(this.toolOutputExpanded);
            this.chatContainer.addChild(component);
            // Render user message separately if present
            if (skillBlock.userMessage) {
              const userComponent = new UserMessageComponent(
                skillBlock.userMessage,
                this.getMarkdownThemeWithSettings(),
                this.outputPad,
              );
              this.chatContainer.addChild(userComponent);
            }
          } else {
            const userComponent = new UserMessageComponent(
              textContent,
              this.getMarkdownThemeWithSettings(),
              this.outputPad,
            );
            this.chatContainer.addChild(userComponent);
          }
          if (options?.populateHistory) {
            this.editor.addToHistory?.(textContent);
          }
        }
        break;
      }
      case "assistant": {
        const assistantComponent = new AssistantMessageComponent(
          message,
          this.hideThinkingBlock,
          this.getMarkdownThemeWithSettings(),
          this.hiddenThinkingLabel,
          this.outputPad,
        );
        this.chatContainer.addChild(assistantComponent);
        break;
      }
      case "toolResult": {
        // Tool results are rendered inline with tool calls, handled separately
        break;
      }
      default:
        break;
    }
  };

InteractiveModeBase.prototype.renderSessionContext = function(this: InteractiveModeBase, sessionContext: SessionContext, options: { updateFooter?: boolean; populateHistory?: boolean } = {}): void {
    this.pendingTools.clear();
    const pendingDeferredInputs = [...this.deferredRenderedUserInputs];
    this.deferredRenderedUserInputs = [];
    this.deferredRenderedUserInputComponents.clear();

    if (options.updateFooter) {
      this.footer.invalidate();
      this.updateEditorBorderColor();
    }

    const entries = chatEntriesFromAgentMessages(sessionContext.messages);
    for (const entry of entries) {
      const component = this.addRenderedChatEntry(entry);
      if (
        entry.kind === "tool" &&
        entry.isPartial !== false &&
        component instanceof ToolExecutionComponent
      ) {
        this.pendingTools.set(entry.toolCallId, component);
      }
      if (options.populateHistory && entry.kind === "user") {
        this.editor.addToHistory?.(entry.text);
      }
    }

    for (const input of pendingDeferredInputs) {
      this.renderDeferredUserInput(input);
    }

    this.ui.requestRender();
  };

InteractiveModeBase.prototype.attachStartupNoticesContainer = function(this: InteractiveModeBase, options: { resetDetached?: boolean } = {}): void {
    const isAttached = this.chatContainer.children.includes(this.startupNoticesContainer);
    if (isAttached) return;
    if (options.resetDetached) {
      this.startupNoticesContainer.clear();
    }
    this.chatContainer.addChild(this.startupNoticesContainer);
  };

InteractiveModeBase.prototype.renderInitialMessages = function(this: InteractiveModeBase): void {
    this.attachStartupNoticesContainer({ resetDetached: true });
    // Get aligned messages and entries from session context
    const context = this.sessionManager.buildSessionContext();
    this.renderSessionContext(context, {
      updateFooter: true,
      populateHistory: true,
    });

  };

InteractiveModeBase.prototype.getUserInput = async function(this: InteractiveModeBase): Promise<string> {
    for (let attempt = 0; !this.startupCookedInputRecovered && attempt < 10; attempt += 1) {
      await yieldToEventLoop();
      if (this.recoverCookedStartupInput?.()) break;
    }
    while (true) {
      const queuedInput = this.pendingUserInputs.shift();
      if (queuedInput !== undefined) {
        return queuedInput;
      }

      if (this.startupReplayActiveInput) {
        await this.drainStartupReplayCommands();
        continue;
      }

      return new Promise((resolve) => {
        this.onInputCallback = (text: string) => {
          this.onInputCallback = undefined;
          resolve(text);
        };
        if (!this.inputHandlerReadyRecorded) {
          this.inputHandlerReadyRecorded = true;
          recordTimeSinceReset("interactive-input-handler-ready");
          void (async () => {
            await yieldToEventLoop();
            // pi parity: the changelog/first-run notices need nothing from
            // extensions — render them right after the input handler is ready
            // instead of gating them behind the deferred extension reload (or,
            // when the user types immediately, behind the whole agent turn).
            this.showStartupNoticesIfNeeded(this.startupNoticesContainer);
            this.footerDataProvider.startGitWatcher();
            if (this.deferredStartupPending) {
              await this.ensureDeferredStartupComplete();
            }
          })().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Deferred input-readiness startup task failed: ${message}`);
          });
        }
      });
    }
  };

InteractiveModeBase.prototype.rebuildChatFromMessages = function(
  this: InteractiveModeBase,
  options: { suppressCompactionBoundary?: VerbatimCompactionResult } = {},
): void {
    this.chatContainer.clear();
    this.attachStartupNoticesContainer();
    let context = this.sessionManager.buildSessionContext();
    const synthesizedBoundary = options.suppressCompactionBoundary;
    if (synthesizedBoundary && isSynthesizedCompactionBoundary(context.messages[0], synthesizedBoundary)) {
      context = { ...context, messages: context.messages.slice(1) };
    }
    this.renderSessionContext(context);
  };

function isSynthesizedCompactionBoundary(
  message: AgentMessage | undefined,
  result: VerbatimCompactionResult,
): boolean {
  if (message?.role !== "custom" || message.customType !== "compaction" || !message.display) return false;
  const details = message.details as { strategy?: string } | undefined;
  if (details?.strategy !== "verbatim-lines") return false;
  const content = Array.isArray(message.content)
    ? message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
    : message.content;
  return content === VERBATIM_COMPACTION_PREFIX + result.compactedText;
}
