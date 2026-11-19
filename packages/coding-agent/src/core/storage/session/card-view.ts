import { branchRanges, latestCompactionOf, type SessionResumeIndex, stateSeqsBefore } from "./session-resume.js";
import type { ChildDisplayCut, ChildDisplayLaunch } from "./types.js";

/** Reproduce the released launch card's distinction between the held suffix and an explicit older
 * launch entry. No prior message, receipt, checkout or tool result is loaded to decide which rows are eligible. */
export function childDisplayCut(
	index: SessionResumeIndex,
	launch: ChildDisplayLaunch,
	found?: number,
): ChildDisplayCut {
	const leaf = index.leafSeq;
	const branch = branchRanges(index, leaf);
	const owns = (seq: number) => branch.some(([lo, hi]) => seq >= lo && seq <= hi);
	const comp = latestCompactionOf(index, leaf);
	const suffix = comp ? Math.min(comp.retainedStartSeq, comp.coveredThroughSeq ?? comp.retainedStartSeq) : 1;
	const heldMessagesAfter = (seq: number) => {
		// The old tail kept the last assistant and assistant model transitions. Other prefix
		// state (labels, checkout references, delivery receipts) never rendered as message rows.
		const last = index.assistants.findLast(owns);
		const positions = index.models.flatMap(([n]) =>
			n > seq && n < suffix && owns(n) && index.latest[`model-transition:${n}`]?.includes(n) ? [n] : [],
		);
		if (last !== undefined && last > seq && last < suffix && !positions.includes(last)) positions.push(last);
		return positions.sort((a, b) => a - b);
	};
	const base = { epoch: index.epoch, through: index.seq, leaf };
	if (typeof launch.launchLeafId === "string") {
		if (found !== undefined && owns(found)) {
			if (found >= suffix || !stateSeqsBefore(index, suffix).includes(found))
				return { ...base, from: found + 1, earlier: [] };
			return { ...base, from: suffix, earlier: heldMessagesAfter(found) };
		}
		return {
			...base,
			from:
				launch.launchLeafSeq !== undefined && branch.some(([a]) => a <= launch.launchLeafSeq!)
					? launch.launchLeafSeq + 1
					: leaf + 1,
			earlier: [],
		};
	}
	if (launch.launchLeafSeq !== undefined)
		return {
			...base,
			from: Math.max(suffix, launch.launchLeafSeq + 1),
			earlier: heldMessagesAfter(launch.launchLeafSeq),
		};
	return {
		...base,
		from: comp?.retainedStartSeq ?? 1,
		earlier: [],
		model: true,
		...(comp ? { boundary: comp.seq, covered: comp.coveredThroughSeq ?? comp.seq - 1 } : {}),
	};
}
