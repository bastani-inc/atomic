import { Container } from "./interactive-mode-deps.ts";

/**
 * Holds startup chat output off-screen until the resource disclosure slot has
 * been filled. Terminal scrollback cannot reorder lines that were painted
 * before an earlier container received content.
 */
export class StartupChatContainer extends Container {
	private startupOutputReleased = false;

	releaseStartupOutput(): void {
		this.startupOutputReleased = true;
		this.invalidate();
	}

	override render(width: number): string[] {
		return this.startupOutputReleased ? super.render(width) : [];
	}
}

interface StartupChatOutputHost {
	chatContainer: Container;
	ui: { requestRender(): void };
}

export function releaseStartupChatOutput(host: StartupChatOutputHost): void {
	if (host.chatContainer instanceof StartupChatContainer) {
		host.chatContainer.releaseStartupOutput();
		host.ui.requestRender();
	}
}
