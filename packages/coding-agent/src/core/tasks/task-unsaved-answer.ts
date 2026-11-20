import type { SessionEntry } from "../session-manager-types.ts";
export interface AnswerRecord {
	entry?: SessionEntry;
	chunks?: () => AsyncIterable<Uint8Array>;
}
/** An acknowledgement can be lost after the store has written the final reply. Compare only the newest saved
 * message (ignoring bookkeeping after it); never append an already-saved answer twice. */
export async function taskAnswerMissing(
	unsaved: Extract<SessionEntry, { type: "message" }>,
	records: AsyncIterable<AnswerRecord>,
): Promise<boolean> {
	const { compareTaskAnswer } = await import("./task-reference-stream.js");
	for await (const row of records) {
		if (row.entry) {
			if (row.entry.type !== "message") continue;
			if (row.entry.message.role !== unsaved.message.role) return true;
			// Stored in-packet rows are byte-bounded; the resident unsaved answer can be much larger.
			const data = Buffer.from(JSON.stringify({ type: "message", message: row.entry.message }));
			return (
				(await compareTaskAnswer(async function* () {
					yield data;
				}, unsaved.message)) !== "same"
			);
		}
		if (!row.chunks)
			throw new TypeError("The task history source must implement readHistoryChunks for oversized entries");
		const match = await compareTaskAnswer(row.chunks, unsaved.message);
		if (match !== "not-message") return match === "different";
	}
	return true;
}
