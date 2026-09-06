import { type ChatSessionSubmitMode, createSessionSkillAutocompleteProvider } from "@bastani/atomic";
import type { StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import { currentStage, isBlocked, liveHandle } from "./stage-chat-view-state.js";
import type { StageChatViewContext } from "./stage-chat-view-types.js";

function assertComposerAdmission(ctx: StageChatViewContext, handle: StageControlHandle): void {
	if (liveHandle(ctx) !== handle || isBlocked(ctx)) throw new Error("This stage chat is not editable.");
	if (ctx.mountedCustomUi || currentStage(ctx)?.pendingPrompt) {
		throw new Error("The mounted stage question owns input. Answer it before invoking a skill.");
	}
}

export function stageSkillAutocomplete(ctx: StageChatViewContext) {
	return createSessionSkillAutocompleteProvider(
		async () => {
			const handle = liveHandle(ctx);
			if (!handle || isBlocked(ctx)) throw new Error("This stage chat is not editable.");
			await handle.ensureAttached();
			assertComposerAdmission(ctx, handle);
			return handle.agentSession;
		},
		(message) => ctx.chatHost.showWarning(message),
	);
}

/** Capture one handle, let its admission route expand once, and keep diagnostics in this chat. */
export async function submitStageSkillCommand(
	ctx: StageChatViewContext,
	text: string,
	mode: ChatSessionSubmitMode,
	resume = false,
): Promise<void> {
	const handle = liveHandle(ctx);
	if (!handle) throw new Error("no live handle on this stage");
	assertComposerAdmission(ctx, handle);
	await handle.ensureAttached();
	assertComposerAdmission(ctx, handle);
	if (!handle.sendUserMessage) {
		throw new Error("Skill invocation unavailable: this stage host does not expose user-message admission.");
	}
	let diagnostic: string | undefined;
	const unsubscribe = handle.agentSession?.extensionRunner?.onError((error) => {
		if (error.event !== "skill_expansion") return;
		diagnostic = error.error;
		ctx.chatHost.showWarning(diagnostic);
	});
	try {
		if (resume) {
			await handle.resume(undefined, () => assertComposerAdmission(ctx, handle));
			assertComposerAdmission(ctx, handle);
		}
		await handle.sendUserMessage(
			text,
			{
				deliverAs: mode === "followUp" ? "followUp" : "steer",
				expandPromptTemplates: true,
			},
			() => assertComposerAdmission(ctx, handle),
		);
	} finally {
		unsubscribe?.();
		if (diagnostic) ctx.chatHost.showWarning(diagnostic);
	}
}
