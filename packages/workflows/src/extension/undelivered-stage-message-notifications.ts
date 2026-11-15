import { reportDebug } from "@bastani/atomic";
import type { Store } from "../shared/store.js";
import { readGraphStoreSnapshot, subscribeStoreInvalidation } from "../shared/store-observation.js";
import type { StoreSnapshot } from "../shared/store-types.js";
import { deriveGraphThemeFromPiTheme } from "../tui/graph-theme.js";
import { renderWorkflowNoticeCard } from "../tui/workflow-notice-card.js";
import type { ExtensionAPI, PiMessageRenderComponent, PiMessageRenderer } from "./index.js";

export const UNDELIVERED_STAGE_MESSAGE_CUSTOM_TYPE = "workflows:undelivered-stage-message";
const SNIPPET_LIMIT = 240;

export interface UndeliveredStageMessageNoticeDetails {
	readonly runId: string;
	readonly workflowName: string;
	readonly stageId: string;
	readonly stageName: string;
	/** The message that never reached the stage. */
	readonly text: string;
	readonly noticeId: string;
}

export interface UndeliveredStageMessageNotificationOptions {
	readonly store: Store;
	readonly sendMessage?: ExtensionAPI["sendMessage"];
	readonly registerMessageRenderer?: ExtensionAPI["registerMessageRenderer"];
	readonly rendererHost?: object;
}

const rendererRegisteredHosts = new WeakSet<object>();

/**
 * Tells the parent session, once per message, that a stage finished before a message sent to it was delivered
 * (#4884). The stage records an `undelivered` notice; this turns each new one into a chat notice naming the message
 * and the stage. Notices present when it is installed are counted as told.
 */
export function installUndeliveredStageMessageNotifications(
	options: UndeliveredStageMessageNotificationOptions,
): () => void {
	registerUndeliveredStageMessageRenderer(options);
	const send = options.sendMessage;
	if (typeof send !== "function") return () => undefined;
	const told = new Set<string>();
	const inspect = (snapshot: StoreSnapshot, notify: boolean): void => {
		for (const run of snapshot.runs)
			for (const stage of run.stages)
				for (const notice of stage.notices ?? []) {
					if (notice.kind !== "undelivered" || told.has(notice.id)) continue;
					told.add(notice.id);
					if (!notify) continue;
					sendNotice(send, {
						runId: run.id,
						workflowName: run.name,
						stageId: stage.id,
						stageName: stage.name,
						text: notice.to,
						noticeId: notice.id,
					});
				}
	};
	inspect(readGraphStoreSnapshot(options.store), false);
	return subscribeStoreInvalidation(options.store, () => inspect(readGraphStoreSnapshot(options.store), true));
}

export function formatUndeliveredStageMessageNoticeText(details: UndeliveredStageMessageNoticeDetails): string {
	return `✗ Stage "${details.stageName}" of workflow "${details.workflowName}" (run ${details.runId}) finished before this message was delivered: ${JSON.stringify(snippet(details.text))}. Send it to another stage if it still matters.`;
}

export function registerUndeliveredStageMessageRenderer(
	options: Pick<UndeliveredStageMessageNotificationOptions, "registerMessageRenderer" | "rendererHost">,
): void {
	const register = options.registerMessageRenderer;
	if (typeof register !== "function") return;
	const host = options.rendererHost ?? register;
	if (rendererRegisteredHosts.has(host)) return;
	const renderer: PiMessageRenderer = (raw, _options, piTheme) => {
		const details = (raw as { readonly details?: UndeliveredStageMessageNoticeDetails }).details;
		if (details === undefined) return undefined;
		return noticeComponent(details, piTheme);
	};
	register(UNDELIVERED_STAGE_MESSAGE_CUSTOM_TYPE, renderer);
	rendererRegisteredHosts.add(host);
}

function sendNotice(
	send: NonNullable<ExtensionAPI["sendMessage"]>,
	details: UndeliveredStageMessageNoticeDetails,
): void {
	const warn = (error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		reportDebug("workflow", "undelivered-stage-message-notice-send-failed", { message }, () =>
			console.warn("[workflows] undelivered stage message notice send failed", message),
		);
	};
	try {
		void Promise.resolve(
			send(
				{
					customType: UNDELIVERED_STAGE_MESSAGE_CUSTOM_TYPE,
					content: formatUndeliveredStageMessageNoticeText(details),
					display: true,
					details,
				},
				{ triggerTurn: false, deliverAs: "nextTurn" },
			),
		).catch(warn);
	} catch (error) {
		warn(error);
	}
}

function snippet(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= SNIPPET_LIMIT ? normalized : `${normalized.slice(0, SNIPPET_LIMIT - 1)}…`;
}

function noticeComponent(details: UndeliveredStageMessageNoticeDetails, piTheme: unknown): PiMessageRenderComponent {
	const theme = piTheme === undefined ? undefined : deriveGraphThemeFromPiTheme(piTheme);
	return {
		render(width: number): string[] {
			return renderWorkflowNoticeCard({
				title: "MESSAGE NOT DELIVERED",
				glyph: "✗",
				headline: `Stage "${details.stageName}" finished before this message was delivered`,
				tone: "warning",
				fields: [
					{ label: "workflow", value: details.workflowName },
					{ label: "run", value: details.runId },
					{ label: "stage", value: details.stageName },
					{ label: "message", value: snippet(details.text) },
				],
				footer: "Send it to another stage if it still matters.",
				fallbackText: formatUndeliveredStageMessageNoticeText(details),
				width,
				...(theme ? { theme } : {}),
			});
		},
		invalidate() {
			/* undelivered-message notices are immutable */
		},
	};
}
