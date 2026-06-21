import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type Component, type ReadonlyFooterDataProvider, Container, Spacer, TUI, Theme, theme } from "./interactive-mode-deps.ts";
import { isExpandable } from "./interactive-mode-helpers.ts";

InteractiveModeBase.prototype.renderWidgets = function(this: InteractiveModeBase): void {
    if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
    this.renderWidgetContainer(
      this.widgetContainerAbove,
      this.extensionWidgetsAbove,
      true,
      true,
    );
    this.renderWidgetContainer(
      this.widgetContainerBelow,
      this.extensionWidgetsBelow,
      false,
      // leadingSpacer: blank line between the footer (model + cwd identity) and
      // below-editor widgets such as the workflow companion counter, so the
      // transient run status is visually separated from the session identity
      // line. Only emitted when a below-editor widget is actually present.
      true,
    );
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.renderWidgetContainer = function(this: InteractiveModeBase, container: Container, widgets: Map<string, Component & { dispose?(): void }>, spacerWhenEmpty: boolean, leadingSpacer: boolean): void {
    container.clear();

    if (widgets.size === 0) {
      if (spacerWhenEmpty) {
        container.addChild(new Spacer(1));
      }
      return;
    }

    if (leadingSpacer) {
      container.addChild(new Spacer(1));
    }
    let firstWidget = true;
    for (const component of widgets.values()) {
      // Separate stacked widgets (e.g. the async-subagent widget and the
      // workflow run counter, both belowEditor) with a blank line so each
      // panel reads as its own block.
      if (!firstWidget) {
        container.addChild(new Spacer(1));
      }
      container.addChild(component);
      firstWidget = false;
    }
  };

InteractiveModeBase.prototype.setExtensionFooter = function(this: InteractiveModeBase, factory:
      | ((
          tui: TUI,
          thm: Theme,
          footerData: ReadonlyFooterDataProvider,
        ) => Component & { dispose?(): void })
      | undefined): void {
    // Dispose existing custom footer
    if (this.customFooter?.dispose) {
      this.customFooter.dispose();
    }

    // Swap the footer IN PLACE so it keeps its slot directly above
    // `widgetContainerBelow`. Using removeChild + addChild would append the new
    // footer to the very end of the UI (after the below-editor widgets), which
    // breaks the ordering invariant established for #1109: the footer must stay
    // pinned under the editor, and the below-editor widget container must remain
    // the last UI child so a live widget's per-tick line stays within the bottom
    // viewport (above-fold ticks trigger pi-tui's full-screen/scrollback clear).
    const currentFooter: Component = this.customFooter ?? this.footer;
    const footerIndex = this.ui.children.indexOf(currentFooter);

    let nextFooter: Component;
    if (factory) {
      const created = factory(this.ui, theme, this.footerDataProvider);
      this.customFooter = created;
      nextFooter = created;
    } else {
      this.customFooter = undefined;
      nextFooter = this.footer;
    }

    if (footerIndex !== -1) {
      this.ui.children[footerIndex] = nextFooter;
    } else {
      // Footer slot not found (e.g. swapped before init attached it): append the
      // footer, then re-attach the below-editor container so it stays last.
      this.ui.addChild(nextFooter);
      this.ui.removeChild(this.widgetContainerBelow);
      this.ui.addChild(this.widgetContainerBelow);
    }

    this.ui.requestRender();
  };

InteractiveModeBase.prototype.setExtensionHeader = function(this: InteractiveModeBase, factory:
      | ((tui: TUI, thm: Theme) => Component & { dispose?(): void })
      | undefined): void {
    // Header may not be initialized yet if called during early initialization
    if (!this.builtInHeader) {
      return;
    }

    // Dispose existing custom header
    if (this.customHeader?.dispose) {
      this.customHeader.dispose();
    }

    // Find the index of the current header in the header container
    const currentHeader = this.customHeader || this.builtInHeader;
    const index = this.headerContainer.children.indexOf(currentHeader);

    if (factory) {
      // Create and add custom header
      this.customHeader = factory(this.ui, theme);
      if (isExpandable(this.customHeader)) {
        this.customHeader.setExpanded(this.toolOutputExpanded);
      }
      if (index !== -1) {
        this.headerContainer.children[index] = this.customHeader;
      } else {
        // If not found (e.g. builtInHeader was never added), add at the top
        this.headerContainer.children.unshift(this.customHeader);
      }
    } else {
      // Restore built-in header
      this.customHeader = undefined;
      if (isExpandable(this.builtInHeader)) {
        this.builtInHeader.setExpanded(this.toolOutputExpanded);
      }
      if (index !== -1) {
        this.headerContainer.children[index] = this.builtInHeader;
      }
    }

    this.ui.requestRender();
  };
