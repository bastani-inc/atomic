/**
 * Evidence-only extension that reproduces an admitted async subagent completion.
 *
 * A real workflow stage session loads this extension. On its first agent turn, it
 * waits briefly while the stand-in model is streaming, then sends the same
 * custom message/options used by subagent completion notification: triggerTurn
 * plus a persisted stageAdmissionKey. The model server answers the resulting
 * trailing turn with ACK-<nonce>.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@bastani/atomic";

const NOTIFY_DELAY_MS = 500;

export default function registerStageOutputTranscriptNotify(pi: ExtensionAPI): void {
	let sent = false;
	const nonce = process.env.STAGE_OUTPUT_TRANSCRIPT_NONCE ?? "missing-nonce";
	const statePath = process.env.STAGE_OUTPUT_TRANSCRIPT_STATE;
	const receiptPath = process.env.STAGE_OUTPUT_TRANSCRIPT_RECEIPT_STATE;
	const mark = (value: string): void => {
		if (statePath) void writeFile(statePath, value, "utf8").catch(() => {});
	};

	pi.registerCommand("stage-output-receipt", {
		description: "Render the exact stage file-only receipt for evidence",
		handler: async (_args, context) => {
			if (!receiptPath) {
				context.ui.notify("stage-output-transcript receipt state is not configured", "error");
				return;
			}
			const receipt = await readFile(receiptPath, "utf8");
			await pi.sendMessage(
				{ customType: "stage-output-transcript-receipt", content: receipt, display: true },
				{ triggerTurn: false },
			);
		},
	});

	pi.on("agent_start", (_event, context) => {
		if (sent || context.orchestrationContext?.kind !== "workflow-stage") return;
		sent = true;
		setTimeout(() => {
			mark("notify-dispatching");
			const delivery = pi.sendMessage(
				{
					customType: "subagent-notify",
					content: `ASYNC-COMPLETION-${nonce}`,
					display: true,
				},
				{ triggerTurn: true, stageAdmissionKey: `subagent:e2e-${nonce}` },
			);
			void Promise.resolve(delivery).then(
				() => mark("notify-admitted"),
				() => mark("notify-failed"),
			);
		}, NOTIFY_DELAY_MS).unref?.();
	});
}
