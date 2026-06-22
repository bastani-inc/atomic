import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type OverlayHandle, type OverlayOptions, type Component, Text, TUI, KeybindingsManager, Theme, theme } from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.showExtensionNotify = function(this: InteractiveModeBase, message: string, type?: "info" | "warning" | "error"): void {
    if (type === "error") {
      this.showError(message);
    } else if (type === "warning") {
      this.showWarning(message);
    } else {
      this.showStatus(message);
    }
  };

InteractiveModeBase.prototype.showExtensionCustom = async function <T>(this: InteractiveModeBase, factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) =>
      | (Component & { dispose?(): void })
      | Promise<Component & { dispose?(): void }>, options?: {
      overlay?: boolean;
      deferInlineCustomUiFocus?: boolean;
      signal?: AbortSignal;
      overlayOptions?: OverlayOptions | (() => OverlayOptions);
      onHandle?: (handle: OverlayHandle) => void;
    }): Promise<T> {
    const savedText = this.editor.getText();
    const isOverlay = options?.overlay ?? false;

    const restoreEditor = (focusEditor: boolean) => {
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.editor.setText(savedText);
      if (focusEditor) this.ui.setFocus(this.editor);
      this.ui.requestRender();
    };

    return new Promise((resolve, reject) => {
      let component: (Component & { dispose?(): void }) | undefined;
      let closed = false;
      let mounted = false;
      let releaseHostInlineCustomUi: (() => void) | undefined;
      let releaseOverlayInlineCustomUiFocusDeferral: (() => void) | undefined;

      const disposeComponent = () => {
        try {
          component?.dispose?.();
        } catch {
          /* ignore dispose errors */
        }
      };

      const releaseHostCustomUi = () => {
        if (component !== undefined && this.pendingInlineCustomUiFocus === component) {
          this.pendingInlineCustomUiFocus = undefined;
          this.notifyHostCustomUiStateListeners();
        }
        releaseHostInlineCustomUi?.();
      };

      const cleanupAbortListener = () => {
        options?.signal?.removeEventListener("abort", abortCustomUi);
      };

      const closeMountedUi = () => {
        if (!mounted) return;
        if (isOverlay) {
          releaseOverlayInlineCustomUiFocusDeferral?.();
          releaseOverlayInlineCustomUiFocusDeferral = undefined;
          this.ui.hideOverlay();
        } else {
          restoreEditor(
            !this.shouldDeferInlineCustomUiFocus() &&
              this.pendingInlineCustomUiFocus !== component,
          );
        }
      };

      const close = (result: T) => {
        if (closed) return;
        closed = true;
        cleanupAbortListener();
        closeMountedUi();
        disposeComponent();
        releaseHostCustomUi();
        resolve(result);
      };

      const rejectAndClose = (reason: unknown) => {
        if (closed) return;
        closed = true;
        cleanupAbortListener();
        closeMountedUi();
        disposeComponent();
        releaseHostCustomUi();
        reject(reason);
      };

      function abortCustomUi(): void {
        rejectAndClose(options?.signal?.reason ?? new Error("Extension custom UI aborted"));
      }

      if (options?.signal?.aborted) {
        abortCustomUi();
        return;
      }
      releaseHostInlineCustomUi = isOverlay
        ? undefined
        : this.beginHostInlineCustomUi();
      if (options?.signal?.aborted) {
        abortCustomUi();
        return;
      }
      options?.signal?.addEventListener("abort", abortCustomUi, { once: true });

      let factoryResult:
        | (Component & { dispose?(): void })
        | Promise<Component & { dispose?(): void }>;
      try {
        factoryResult = factory(this.ui, theme, this.keybindings, close);
      } catch (err) {
        rejectAndClose(err);
        return;
      }

      Promise.resolve(factoryResult)
        .then((c) => {
          if (closed) {
            try {
              c.dispose?.();
            } catch {
              /* ignore dispose errors */
            }
            return;
          }
          component = c;
          if (isOverlay) {
            // Resolve overlay options - can be static or dynamic function
            const resolveOptions = (): OverlayOptions | undefined => {
              if (options?.overlayOptions) {
                const opts =
                  typeof options.overlayOptions === "function"
                    ? options.overlayOptions()
                    : options.overlayOptions;
                return opts;
              }
              // Fallback: use component's width property if available
              const w = (component as { width?: number } | undefined)?.width;
              return w ? { width: w } : undefined;
            };
            const handle = this.ui.showOverlay(component, resolveOptions());
            mounted = true;
            if (options?.deferInlineCustomUiFocus) {
              let releaseDeferral: (() => void) | undefined = this.beginInlineCustomUiFocusDeferral();
              releaseOverlayInlineCustomUiFocusDeferral = () => {
                releaseDeferral?.();
                releaseDeferral = undefined;
              };
              const release = () => {
                releaseOverlayInlineCustomUiFocusDeferral?.();
                releaseOverlayInlineCustomUiFocusDeferral = undefined;
              };
              const wrappedHandle: OverlayHandle = {
                hide: () => {
                  release();
                  handle.hide();
                },
                setHidden: (hidden) => {
                  if (hidden) release();
                  handle.setHidden(hidden);
                  if (!hidden && releaseDeferral === undefined) {
                    releaseDeferral = this.beginInlineCustomUiFocusDeferral();
                    releaseOverlayInlineCustomUiFocusDeferral = () => {
                      releaseDeferral?.();
                      releaseDeferral = undefined;
                    };
                  }
                },
                isHidden: () => handle.isHidden(),
                focus: () => handle.focus(),
                unfocus: (unfocusOptions) => handle.unfocus(unfocusOptions),
                isFocused: () => handle.isFocused(),
              };
              // Expose handle to caller for visibility control
              options?.onHandle?.(wrappedHandle);
            } else {
              // Expose handle to caller for visibility control
              options?.onHandle?.(handle);
            }
          } else {
            this.editorContainer.clear();
            this.editorContainer.addChild(component);
            if (this.shouldDeferInlineCustomUiFocus()) {
              this.pendingInlineCustomUiFocus = component;
              this.notifyHostCustomUiStateListeners();
            } else {
              this.ui.setFocus(component);
            }
            mounted = true;
            this.ui.requestRender();
          }
        })
        .catch((err) => {
          rejectAndClose(err);
        });
    });
  };

InteractiveModeBase.prototype.showExtensionError = function(this: InteractiveModeBase, extensionPath: string, error: string, stack?: string): void {
    const errorMsg = `Extension "${extensionPath}" error: ${error}`;
    const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
    this.chatContainer.addChild(errorText);
    if (stack) {
      // Show stack trace in dim color, indented
      const stackLines = stack
        .split("\n")
        .slice(1) // Skip first line (duplicates error message)
        .map((line) => theme.fg("dim", `  ${line.trim()}`))
        .join("\n");
      if (stackLines) {
        this.chatContainer.addChild(new Text(stackLines, 1, 0));
      }
    }
    this.ui.requestRender();
  };
