/**
 * Interactive mode for the coding agent.
 * Public entrypoint preserved while responsibilities live in sibling modules.
 */

import "./interactive-autocomplete.ts";
import "./interactive-onboarding.ts";
import "./interactive-startup.ts";
import "./interactive-deferred-startup.ts";
import "./interactive-resource-paths.ts";
import "./interactive-resource-disclosure.ts";
import "./interactive-resource-rendering.ts";
import "./interactive-session-runtime.ts";
import "./interactive-extension-runtime.ts";
import "./interactive-extension-widgets.ts";
import "./interactive-extension-context.ts";
import "./interactive-extension-dialogs.ts";
import "./interactive-extension-custom-ui.ts";
import "./interactive-input-handling.ts";
import "./interactive-agent-events.ts";
import "./interactive-render-chat.ts";
import "./interactive-process-lifecycle.ts";
import "./interactive-editor-actions.ts";
import "./interactive-queueing.ts";
import "./interactive-selectors.ts";
import "./interactive-model-routing.ts";
import "./interactive-session-routing.ts";
import "./interactive-auth-routing.ts";
import "./interactive-auth-login.ts";
import "./interactive-slash-commands.ts";
import "./interactive-hotkeys-debug.ts";
import "./interactive-bash-compact.ts";

import { InteractiveModeBase } from "./interactive-mode-base.ts";

export { formatResumeCommand, isApiKeyLoginProvider } from "./interactive-mode-helpers.ts";
export type { InteractiveModeOptions } from "./interactive-mode-types.ts";

export class InteractiveMode extends InteractiveModeBase {}
