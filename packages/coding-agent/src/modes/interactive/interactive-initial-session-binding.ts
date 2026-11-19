import { AsyncLocalStorage } from "node:async_hooks";
import { type InitialBind, initialBindScope } from "../../core/extension-startup-close.ts";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";
import { releaseStartupChatOutput } from "./interactive-startup-chat-container.ts";

export interface EventStartup {
	mode: WeakRef<InteractiveModeBase>;
	strict: boolean;
	open?: WeakRef<object>;
}
export const eventStartupScope = new AsyncLocalStorage<EventStartup>();

/** Bind the eager startup session without letting the reusable runtime path append its disclosure. */
export async function bindInitialEagerSession(mode: InteractiveModeBase): Promise<void> {
	try {
		mode.initialStartupBinding = true;
		const startup = mode.sessionStartup;
		const delivery = eventStartupScope.getStore();
		const event = delivery?.mode.deref() === mode ? delivery : undefined;
		const bind: InitialBind = { mode, active: !event?.strict, deliveredWhileOpen: event?.open?.deref() };
		try {
			await initialBindScope.run(new WeakRef(bind), () => mode.rebindCurrentSession());
		} finally {
			bind.active = false;
			mode.initialStartupBinding = false;
		}
		if (bind.cancelled) {
			startup.cancelled = true;
			return;
		}
		mode.showLoadedResources({
			force: true,
			showDiagnosticsWhenQuiet: true,
			targetContainer: mode.resourceDisclosureContainer,
		});
		mode.showStartupNoticesIfNeeded(mode.startupNoticesContainer);
		// A suppressed derived `-fast` duplicate is a startup notice, so it renders here on the eager
		// path and again after deferred extension loading on the other branch of `run()`.
		mode.reportModelCatalogWarning(mode.startupNoticesContainer);
	} finally {
		releaseStartupChatOutput(mode);
	}
}
