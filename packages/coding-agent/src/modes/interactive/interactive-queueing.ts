import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { Spacer, TruncatedText, combineQueuedMessagesForEditor, theme } from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.getAllQueuedMessages = function(this: InteractiveModeBase): { steering: string[]; followUp: string[] } {
    return {
      steering: [
        ...this.session.getSteeringMessages(),
        ...this.compactionQueuedMessages
          .filter((msg) => msg.mode === "steer")
          .map((msg) => msg.text),
      ],
      followUp: [
        ...this.session.getFollowUpMessages(),
        ...this.compactionQueuedMessages
          .filter((msg) => msg.mode === "followUp")
          .map((msg) => msg.text),
      ],
    };
  };

InteractiveModeBase.prototype.clearAllQueues = function(this: InteractiveModeBase): { steering: string[]; followUp: string[] } {
    const { steering, followUp } = this.session.clearQueue();
    const compactionSteering = this.compactionQueuedMessages
      .filter((msg) => msg.mode === "steer")
      .map((msg) => msg.text);
    const compactionFollowUp = this.compactionQueuedMessages
      .filter((msg) => msg.mode === "followUp")
      .map((msg) => msg.text);
    this.compactionQueuedMessages = [];
    return {
      steering: [...steering, ...compactionSteering],
      followUp: [...followUp, ...compactionFollowUp],
    };
  };

InteractiveModeBase.prototype.updatePendingMessagesDisplay = function(this: InteractiveModeBase): void {
    this.pendingMessagesContainer.clear();
    const { steering: steeringMessages, followUp: followUpMessages } =
      this.getAllQueuedMessages();
    if (steeringMessages.length > 0 || followUpMessages.length > 0) {
      this.pendingMessagesContainer.addChild(new Spacer(1));
      for (const message of steeringMessages) {
        const text = theme.fg("dim", `Steering: ${message}`);
        this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
      }
      for (const message of followUpMessages) {
        const text = theme.fg("dim", `Follow-up: ${message}`);
        this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
      }
      const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
      const hintText = theme.fg(
        "dim",
        `↳ ${dequeueHint} to edit all queued messages`,
      );
      this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
    }
  };

InteractiveModeBase.prototype.restoreQueuedMessagesToEditor = function(this: InteractiveModeBase, options?: {
    abort?: boolean;
    currentText?: string;
  }): number {
    const { steering, followUp } = this.clearAllQueues();
    const allQueued = [...steering, ...followUp];
    if (allQueued.length === 0) {
      this.updatePendingMessagesDisplay();
      if (options?.abort) {
        void this.session.abort();
      }
      return 0;
    }
    const currentText = options?.currentText ?? this.editor.getText();
    const combinedText = combineQueuedMessagesForEditor(allQueued, currentText);
    this.editor.setText(combinedText);
    this.updatePendingMessagesDisplay();
    if (options?.abort) {
      void this.session.abort();
    }
    return allQueued.length;
  };

InteractiveModeBase.prototype.queueCompactionMessage = function(this: InteractiveModeBase, text: string, mode: "steer" | "followUp"): void {
    this.compactionQueuedMessages.push({ text, mode });
    this.editor.addToHistory?.(text);
    this.editor.setText("");
    this.updatePendingMessagesDisplay();
    this.showStatus("Queued message for after compaction");
  };

InteractiveModeBase.prototype.isExtensionCommand = function(this: InteractiveModeBase, text: string): boolean {
    if (!text.startsWith("/")) return false;

    const extensionRunner = this.session.extensionRunner;

    const spaceIndex = text.indexOf(" ");
    const commandName =
      spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    return !!extensionRunner.getCommand(commandName);
  };

InteractiveModeBase.prototype.flushCompactionQueue = async function(this: InteractiveModeBase, options?: {
    willRetry?: boolean;
  }): Promise<void> {
    if (this.compactionQueuedMessages.length === 0) {
      return;
    }

    const queuedMessages = [...this.compactionQueuedMessages];
    this.compactionQueuedMessages = [];
    this.updatePendingMessagesDisplay();

    const restoreQueue = (error: unknown) => {
      this.session.clearQueue();
      this.compactionQueuedMessages = queuedMessages;
      this.updatePendingMessagesDisplay();
      this.showError(
        `Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    };

    try {
      if (options?.willRetry) {
        // When retry is pending, queue messages for the retry turn
        for (const message of queuedMessages) {
          if (this.isExtensionCommand(message.text)) {
            await this.session.prompt(message.text);
          } else if (message.mode === "followUp") {
            await this.session.followUp(message.text);
          } else {
            await this.session.steer(message.text);
          }
        }
        this.updatePendingMessagesDisplay();
        return;
      }

      // Find first non-extension-command message to use as prompt
      const firstPromptIndex = queuedMessages.findIndex(
        (message) => !this.isExtensionCommand(message.text),
      );
      if (firstPromptIndex === -1) {
        // All extension commands - execute them all
        for (const message of queuedMessages) {
          await this.session.prompt(message.text);
        }
        return;
      }

      // Execute any extension commands before the first prompt
      const preCommands = queuedMessages.slice(0, firstPromptIndex);
      const firstPrompt = queuedMessages[firstPromptIndex];
      const rest = queuedMessages.slice(firstPromptIndex + 1);

      for (const message of preCommands) {
        await this.session.prompt(message.text);
      }

      // Send first prompt (starts streaming)
      const promptPromise = this.session
        .prompt(firstPrompt.text)
        .catch((error) => {
          restoreQueue(error);
        });

      // Queue remaining messages
      for (const message of rest) {
        if (this.isExtensionCommand(message.text)) {
          await this.session.prompt(message.text);
        } else if (message.mode === "followUp") {
          await this.session.followUp(message.text);
        } else {
          await this.session.steer(message.text);
        }
      }
      this.updatePendingMessagesDisplay();
      void promptPromise;
    } catch (error) {
      restoreQueue(error);
    }
  };

InteractiveModeBase.prototype.flushPendingBashComponents = function(this: InteractiveModeBase): void {
    for (const component of this.pendingBashComponents) {
      this.pendingMessagesContainer.removeChild(component);
      this.chatContainer.addChild(component);
    }
    this.pendingBashComponents = [];
  };
