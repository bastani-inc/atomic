/**
 * Evidence-only extension that reproduces an admitted async subagent completion.
 *
 * A real workflow stage session loads this extension and sends the same custom
 * message/options used by subagent completion notification: triggerTurn plus a
 * persisted stageAdmissionKey. Admission timing is independent of the model's
 * message ordering so every ordering can exercise both runtime provenance values.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@bastani/atomic";

const NOTIFY_DELAY_MS = 500;

export default function registerStageOutputTranscriptNotify(pi: ExtensionAPI): void {
	let sent = false;
	const nonce = process.env.STAGE_OUTPUT_TRANSCRIPT_NONCE ?? "missing-nonce";
	const ordering = process.env.STAGE_OUTPUT_TRANSCRIPT_ORDERING ?? "trailing";
	const admissionTiming =
		process.env.STAGE_OUTPUT_TRANSCRIPT_ADMISSION ?? (ordering === "trailing" ? "settled" : "streaming");
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

	const dispatch = (): void => {
		if (sent) return;
		sent = true;
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
	};

	pi.on("agent_start", (_event, context) => {
		if (admissionTiming !== "streaming" || sent || context.orchestrationContext?.kind !== "workflow-stage") return;
		setTimeout(dispatch, NOTIFY_DELAY_MS).unref?.();
	});
	pi.on("agent_end", (_event, context) => {
		if (admissionTiming !== "settled" || sent || context.orchestrationContext?.kind !== "workflow-stage") return;
		dispatch();
	});
}
