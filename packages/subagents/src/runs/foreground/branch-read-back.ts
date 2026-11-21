import type { SessionEntry, SessionManager } from "@bastani/atomic";

/** The ids of the tool calls an assistant message issued. */
export function issuedCallIds(message: { readonly role: string; readonly content?: unknown }): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return (message.content as ReadonlyArray<{ readonly type: string; readonly id?: unknown }>).flatMap((part) =>
		part.type === "toolCall" && typeof part.id === "string" ? [part.id] : [],
	);
}

/**
 * Visits the child's branch from its newest entry back, one entry at a time, until `visit` returns true: the entries the
 * manager holds as far as they run on without a gap (a manager holding only its window links its older held entries
 * past the ones it does not hold), then the stored branch before them, read back a page at a time.
 */
export async function visitBranchBack(
	sessionManager: Pick<SessionManager, "getBranch" | "readHistory" | "getLeafId" | "getEntrySeq">,
	visit: (entry: SessionEntry) => boolean,
): Promise<void> {
	const branch = sessionManager.getBranch();
	let oldest = Math.max(0, branch.length - 1);
	while (oldest > 0 && branch[oldest]?.parentId === branch[oldest - 1]?.id) oldest--;
	for (let index = branch.length - 1; index >= oldest; index--) {
		const entry = branch[index];
		if (entry !== undefined && visit(entry)) return;
	}
	const first = branch[oldest];
	const leaf = sessionManager.getLeafId();
	const branchLeafSeq = leaf === null ? undefined : sessionManager.getEntrySeq(leaf);
	const firstSeq = first?.parentId ? sessionManager.getEntrySeq(first.id) : undefined;
	if (branchLeafSeq === undefined || firstSeq === undefined) return;
	for await (const page of sessionManager.readHistory({ branchLeafSeq, toSeq: firstSeq - 1, direction: "backward" }))
		for (let index = page.items.length - 1; index >= 0; index--) {
			const item = page.items[index];
			if (item !== undefined && "entry" in item && visit(item.entry)) return;
		}
}

/**
 * The entry that issued the newest call with each of these ids, by id: it tells a call apart from an earlier one a
 * provider gave the same id (#3274).
 */
export async function issuingCallEntries(
	sessionManager: Pick<SessionManager, "getBranch" | "readHistory" | "getLeafId" | "getEntrySeq">,
	toolCallIds: readonly string[],
): Promise<Map<string, string>> {
	const open = new Set(toolCallIds);
	const issued = new Map<string, string>();
	if (open.size === 0) return issued;
	await visitBranchBack(sessionManager, (entry) => {
		if (entry.type === "message")
			for (const id of issuedCallIds(entry.message)) if (open.delete(id)) issued.set(id, entry.id);
		return open.size === 0;
	});
	return issued;
}
