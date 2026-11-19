import { historyChunks } from "../storage/session/history-pages.js";
import { type ReferenceCut, watchReferenceCut } from "../storage/session/history-snapshot.js";
import type { SessionHistoryReadOptions } from "../storage/session/types.js";
import type { TaskTranscriptSource } from "./supervisor.js";
import { type RawTaskReader, savedTaskReferences } from "./task-reference-pages.js";
import { taskAnswerMissing } from "./task-unsaved-answer.js";
import { taskTranscriptFile, taskTranscriptUnsavedAnswer } from "./task-view-source.js";

/** Keep raw SDK item names and cursors apart from the chat's display pages. First-party stores expose the
 * pinned physical cut for metadata-only candidate checks; custom sources need not implement a native index. */
export async function readArchivedTaskReferences(
	session: TaskTranscriptSource,
	taskId: string,
	cursor: string | undefined,
	earlier: string | undefined,
) {
	const file = taskTranscriptFile(session),
		read = session.readHistory?.bind(session),
		chunks = session.readHistoryChunks?.bind(session);
	if (!file && !read) return undefined;
	let fileCut: string | undefined;
	try {
		const base: RawTaskReader = async function* (at, metadataOnly) {
			if (file) {
				const { taskFilePages, taskFileEntryChunks } = await import("./task-file-history.js");
				for await (const p of taskFilePages(file.path, file.sessionId, {
					cursor: at,
					metadataOnly,
					expectedGeneration: fileCut,
				})) {
					fileCut ??= p.generation;
					const rows = p.items.map((item) =>
						"entry" in item
							? item
							: {
									...item,
									chunks: () =>
										taskFileEntryChunks(file.path, file.sessionId, p.adjacent.current, item.seq, item.bytes),
								},
					);
					yield { current: p.adjacent.current, latest: !p.adjacent.newer, rows };
				}
				return;
			}
			if (!at && !session.loadHistory) {
				const current = session.getEntries();
				// These possibly mutated or unsaved SDK entries follow the stored prefix and have no indexed location.
				for (let end = current.length; end > 0; end -= 64) {
					const start = Math.max(0, end - 64);
					yield {
						rows: current
							.slice(start, end)
							.map((entry, i) => ({ entry, seq: Number.MAX_SAFE_INTEGER - current.length + start + i })),
					};
				}
			}
			const raw = at ?? earlier;
			const options: SessionHistoryReadOptions = {
				...(raw ? { cursor: raw } : { direction: "backward" }),
				adjacent: true,
			};
			let cut: ReferenceCut | undefined;
			watchReferenceCut(
				options,
				(observed) => {
					cut = observed;
				},
				metadataOnly,
			);
			for await (const page of read!(options)) {
				const pinned = cut;
				yield {
					current: page.adjacent?.current,
					latest: !page.adjacent?.newer,
					cut: pinned,
					rows: page.items.map((item) =>
						"entry" in item
							? item
							: {
									...item,
									chunks: chunks
										? () => chunks(item)
										: pinned?.store.readEntryChunk
											? () => historyChunks(pinned.store, pinned.sessionId, pinned.epoch, item, {})
											: undefined,
								},
					),
				};
			}
		};
		const answer = taskTranscriptUnsavedAnswer(session);
		if (answer?.type !== "message") return await savedTaskReferences(session, taskId, cursor, base);
		let missing: Promise<boolean> | undefined;
		return await savedTaskReferences(session, taskId, cursor, async function* (at, metadataOnly) {
			let empty = true;
			for await (const p of base(at, metadataOnly)) {
				if (empty && p.latest) {
					missing ??= taskAnswerMissing(
						answer,
						(async function* () {
							for await (const span of base(p.current))
								for (let r = span.rows.length - 1; r >= 0; r--) yield span.rows[r]!;
						})(),
					);
					if (await missing) yield { rows: [{ seq: Number.MAX_SAFE_INTEGER, entry: answer }] };
				}
				empty = false;
				yield p;
			}
			if (empty && !at) yield { rows: [{ seq: Number.MAX_SAFE_INTEGER, entry: answer }] };
		});
	} catch (error) {
		if (file) {
			const { taskFileUnavailable } = await import("./task-file-history.js");
			return {
				ok: false as const,
				error: { code: "TranscriptUnavailable" as const, message: await taskFileUnavailable(file.path, error) },
			};
		}
		throw error;
	}
}
