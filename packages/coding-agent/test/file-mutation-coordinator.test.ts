import { describe, expect, it } from "vitest";
import {
	assertLiveMatchesPrepared,
	assertPriorSessionObservation,
	buildMutationRequester,
	computeConflictEvidence,
	computeLiveState,
	FILE_MUTATION_CONFLICT_CODE,
	FileMutationConflict,
	filesystemErrorCode,
	isExclusiveCreateCollision,
	isMissingTargetError,
} from "../src/core/tools/file-mutation-coordinator.ts";
import { computeFileHash, InMemorySnapshotStore } from "../src/core/tools/hashline-engine/index.ts";

const KEY = "/repo/src/app.ts";

function conflictFrom(run: () => void): FileMutationConflict {
	try {
		run();
	} catch (error) {
		if (error instanceof FileMutationConflict) return error;
		throw error;
	}
	throw new Error("expected a FileMutationConflict");
}

describe("computeConflictEvidence", () => {
	it("returns undefined when the two sides agree", () => {
		expect(computeConflictEvidence("a\nb\n", "a\nb\n")).toBeUndefined();
	});

	it("reports a single changed line as one line replaced by one", () => {
		expect(computeConflictEvidence("a\nb\nc\n", "a\nB\nc\n")).toEqual({
			line: 2,
			assumedLines: 1,
			foundLines: 1,
			assumed: "b",
			found: "B",
		});
	});

	it("localises an insertion at the top instead of blaming every following line", () => {
		// A positional line-by-line comparison reports the first divergence at line 1 and every
		// subsequent line as changed. Trimming the common suffix is what keeps this to one line.
		const before = Array.from({ length: 400 }, (_, index) => `line${index + 1}`).join("\n");
		const after = `NEW\n${before}`;
		expect(computeConflictEvidence(before, after)).toEqual({
			line: 1,
			assumedLines: 0,
			foundLines: 1,
			found: "NEW",
		});
	});

	it("reports a deletion with no live side", () => {
		expect(computeConflictEvidence("a\nb\nc\n", "a\nc\n")).toEqual({
			line: 2,
			assumedLines: 1,
			foundLines: 0,
			assumed: "b",
		});
	});

	it("counts an uneven replacement on both sides", () => {
		const evidence = computeConflictEvidence("a\nb\nc\nd\ne\n", "a\nX\nY\nZ\nQ\nW\ne\n");
		expect(evidence?.assumedLines).toBe(3);
		expect(evidence?.foundLines).toBe(5);
	});

	it("clamps a long line so one excerpt cannot dominate the message", () => {
		const evidence = computeConflictEvidence(`a\n${"x".repeat(400)}\n`, `a\n${"y".repeat(400)}\n`);
		expect(evidence?.assumed).toHaveLength(123);
		expect(evidence?.assumed?.endsWith("...")).toBe(true);
	});
});

describe("computeLiveState", () => {
	it("treats a trailing newline as terminating the last line", () => {
		expect(computeLiveState("a\nb\n").lines).toBe(2);
		expect(computeLiveState("a\nb").lines).toBe(2);
	});

	it("reports a missing target with no tag at all", () => {
		// The absent tag is what `describeLiveState` branches on to say the file is gone, rather
		// than claiming a hash for content that does not exist.
		expect(computeLiveState(undefined)).toEqual({ lines: 0 });
	});

	it("still tags an empty file, which is not the same as a missing one", () => {
		const state = computeLiveState("");
		expect(state.lines).toBe(0);
		expect(state.tag).toBe(computeFileHash(""));
	});

	it("omits the excerpt when the file opens with a blank line", () => {
		expect(computeLiveState("\nb\n").firstLine).toBeUndefined();
	});
});

describe("buildMutationRequester", () => {
	it("keeps the first child of a fan-out, whose index is 0", () => {
		// `0` is falsy, so the spread idiom used for every other field would drop it and make
		// sibling 0 indistinguishable from a subagent with no index at all.
		const requester = buildMutationRequester({
			sessionId: "s1",
			intercom: { runId: "r1", agent: "reviewer", index: 0 },
		});
		expect(requester.subagentIndex).toBe(0);
	});

	it("takes the parent from the supervisor identity", () => {
		const requester = buildMutationRequester({
			sessionId: "s1",
			intercom: { runId: "r1", agent: "reviewer", supervisor: { supervisorSessionId: "parent-1" } },
		});
		expect(requester.parentSessionId).toBe("parent-1");
	});

	it("ignores an orchestration context that is not a workflow stage", () => {
		const requester = buildMutationRequester({
			sessionId: "s1",
			orchestration: {
				kind: "something-else",
				workflowRunId: "run",
				workflowStageId: "stage",
				workflowStageName: "name",
			},
		});
		expect(requester.workflowRunId).toBeUndefined();
		expect(requester.workflowStageName).toBeUndefined();
	});
});

describe("assertLiveMatchesPrepared", () => {
	it("passes when live content still matches what was prepared", () => {
		expect(() =>
			assertLiveMatchesPrepared({ canonicalKey: KEY, path: "src/app.ts", prepared: "a\n", live: "a\n" }),
		).not.toThrow();
	});

	it("rejects with the divergence attached", () => {
		const conflict = conflictFrom(() =>
			assertLiveMatchesPrepared({
				canonicalKey: KEY,
				path: "src/app.ts",
				prepared: "a\nb\n",
				live: "a\nB\n",
				presentedTag: "AB12",
			}),
		);
		expect(conflict.reason).toBe("changed_before_write");
		expect(conflict.evidence?.line).toBe(2);
		expect(conflict.liveState?.lines).toBe(2);
		expect(conflict.presentedTag).toBe("AB12");
	});
});

describe("assertPriorSessionObservation", () => {
	function storeWith(text?: string): InMemorySnapshotStore {
		const store = new InMemorySnapshotStore();
		if (text !== undefined) store.record(KEY, text);
		return store;
	}

	it("passes when this session recorded exactly the live content", () => {
		const store = storeWith("a\nb\n");
		expect(() =>
			assertPriorSessionObservation({
				canonicalKey: KEY,
				storeKey: KEY,
				path: "src/app.ts",
				store,
				live: "a\nb\n",
			}),
		).not.toThrow();
	});

	it("reports no_prior_observation, with live state but no diff, when nothing was ever read", () => {
		const conflict = conflictFrom(() =>
			assertPriorSessionObservation({
				canonicalKey: KEY,
				storeKey: KEY,
				path: "src/app.ts",
				store: storeWith(),
				live: "a\nb\n",
			}),
		);
		expect(conflict.reason).toBe("no_prior_observation");
		expect(conflict.evidence).toBeUndefined();
		expect(conflict.liveState?.lines).toBe(2);
	});

	it("reports changed_since_observation with a diff when the file moved under the session", () => {
		const conflict = conflictFrom(() =>
			assertPriorSessionObservation({
				canonicalKey: KEY,
				storeKey: KEY,
				path: "src/app.ts",
				store: storeWith("a\nb\n"),
				live: "a\nB\n",
			}),
		);
		expect(conflict.reason).toBe("changed_since_observation");
		expect(conflict.evidence?.assumed).toBe("b");
		expect(conflict.evidence?.found).toBe("B");
	});
});

describe("conflict message", () => {
	it("leads with the code so it survives truncation of the tail", () => {
		const message = FileMutationConflict.formatMessage({
			reason: "changed_before_write",
			path: "src/app.ts",
			canonicalKey: KEY,
		});
		expect(message.startsWith(`${FILE_MUTATION_CONFLICT_CODE}:changed_before_write`)).toBe(true);
	});

	it("never tells the model to read a file that no longer exists", () => {
		// A single shared instruction used to say "Read the file again" for every reason,
		// including the one that fails because there is nothing left to read.
		const message = FileMutationConflict.formatMessage({
			reason: "target_missing",
			path: "src/app.ts",
			canonicalKey: KEY,
			liveState: computeLiveState(undefined),
		});
		expect(message).toContain("Do not read it");
		expect(message).toContain("The target does not exist.");
	});

	it("does not claim a prior read for the reasons that fail from never having read", () => {
		for (const reason of ["no_prior_observation", "target_exists"] as const) {
			const message = FileMutationConflict.formatMessage({ reason, path: "src/app.ts", canonicalKey: KEY });
			expect(message).not.toContain("again");
		}
	});

	it("quotes an excerpt so a template literal cannot close the delimiter early", () => {
		// Assembled rather than written literally: a plain string containing `${` reads to biome
		// as a template literal someone forgot to mark. The subject under test is source code
		// that legitimately contains both backticks and quotes.
		const dollar = "$";
		const templateLine = `const a = \`x${dollar}{y}\`;`;
		const evidence = computeConflictEvidence(`${templateLine}\n`, 'const a = "z";\n');
		const message = FileMutationConflict.formatMessage({
			reason: "changed_before_write",
			path: "src/app.ts",
			canonicalKey: KEY,
			...(evidence ? { evidence } : {}),
		});
		expect(message).toContain(`assumed "${templateLine}"`);
		expect(message).toContain('found "const a = \\"z\\";"');
	});

	it("renders sibling index 0 rather than dropping it", () => {
		const message = FileMutationConflict.formatMessage({
			reason: "changed_before_write",
			path: "src/app.ts",
			canonicalKey: KEY,
			requester: { sessionId: "s1", subagentAgent: "reviewer", subagentIndex: 0 },
		});
		expect(message).toContain("index=0");
	});

	it("quotes a workflow stage name so spaces cannot split the identity blob", () => {
		const message = FileMutationConflict.formatMessage({
			reason: "changed_before_write",
			path: "src/app.ts",
			canonicalKey: KEY,
			requester: { sessionId: "s1", workflowStageName: "fix it up" },
		});
		expect(message).toContain('stageName="fix it up"');
	});
});

describe("an unreadable target", () => {
	it("names the filesystem cause, which is all that is knowable once the read fails", () => {
		const message = FileMutationConflict.formatMessage({
			reason: "target_unreadable",
			path: "src/app.ts",
			canonicalKey: KEY,
			causeCode: "EISDIR",
		});
		expect(message).toContain("target_unreadable");
		expect(message).toContain("(EISDIR)");
	});

	it("claims neither a size nor a tag for a file it could not read", () => {
		// The failure mode this guards: reusing the missing-target live state would print
		// "The target does not exist." for a path that is very much still occupied.
		const message = FileMutationConflict.formatMessage({
			reason: "target_unreadable",
			path: "src/app.ts",
			canonicalKey: KEY,
			causeCode: "EACCES",
		});
		expect(message).not.toContain("does not exist");
		expect(message).not.toContain("Target now holds");
	});
});

describe("filesystem error predicates", () => {
	it("recognises the exclusive-create collision", () => {
		expect(isExclusiveCreateCollision({ code: "EEXIST" })).toBe(true);
		expect(isExclusiveCreateCollision({ code: "ENOENT" })).toBe(false);
		expect(isExclusiveCreateCollision(new Error("nope"))).toBe(false);
	});

	it("treats an unreachable parent directory as a missing target", () => {
		expect(isMissingTargetError({ code: "ENOENT" })).toBe(true);
		expect(isMissingTargetError({ code: "ENOTDIR" })).toBe(true);
		expect(isMissingTargetError({ code: "EACCES" })).toBe(false);
	});

	it("extracts a string code and ignores anything else", () => {
		expect(filesystemErrorCode({ code: "EISDIR" })).toBe("EISDIR");
		// A numeric errno is not the symbolic code the message is meant to carry.
		expect(filesystemErrorCode({ code: 21 })).toBeUndefined();
		expect(filesystemErrorCode(new Error("plain"))).toBeUndefined();
		expect(filesystemErrorCode(undefined)).toBeUndefined();
	});
});
