import { markLifecycleTiming } from "../../core/lifecycle-timings.ts";
import { disposeRemoteRenderers } from "../interactive-engine/remote-renderer.ts";
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

	/** A cleared transcript is rebuilt from new rows; the engine-rendered rows it drops are disposed. */
	override clear(): void {
		disposeRemoteRenderers(this.children);
		super.clear();
	}
}

interface StartupChatOutputHost {
	chatContainer: Container;
	ui: { requestRender(): void };
}

export function releaseStartupChatOutput(host: StartupChatOutputHost): void {
	if (host.chatContainer instanceof StartupChatContainer) {
		host.chatContainer.releaseStartupOutput();
		markLifecycleTiming("chat-output-release");
		host.ui.requestRender();
	}
}
