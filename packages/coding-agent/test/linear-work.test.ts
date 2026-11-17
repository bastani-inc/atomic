import assert from "node:assert/strict";
import chalk from "chalk";
import { applyPatch, lineDiff, wordDiff } from "diff";
import { beforeAll, describe, it } from "vitest";
import { measureStringWork } from "../../tui/test/string-work.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import { generateEditDiff, generateUnifiedPatch } from "../src/core/tools/edit-diff.js";
import { renderDiff } from "../src/modes/interactive/components/diff.js";
import { SelectorState } from "../src/modes/interactive/components/selector.js";
import { filterAndSortSessions } from "../src/modes/interactive/components/session-selector-search.js";
import { appendNewChildrenBeforeAttachedChild } from "../src/modes/interactive/interactive-child-ordering.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import { reconcileQueuedSubmissions, showSubmissionAsQueued } from "../src/modes/interactive/interactive-queueing.js";
import { StartupChatContainer } from "../src/modes/interactive/interactive-startup-chat-container.js";
import { getModelSelectorSearchText } from "../src/modes/interactive/model-search.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => initTheme("dark"));

const SIZES = [2_000, 20_000] as const;
const WORD_COMPARISONS_PER_WORD = 4;
const LINE_COMPARISONS_PER_LINE = 32;
const SWAP_READS_PER_APPEND = 8;
const CLASSIFICATIONS_PER_CHILD = 2;
const SESSION_SEARCH_WORK_PER_CHARACTER_PER_TOKEN = 3;
const SELECTOR_SEARCH_WORK_PER_CHARACTER_PER_TOKEN = 4;

type Differ = { equals(left: string, right: string, options: object): boolean };

function countComparisons(differ: Differ, run: () => void): number {
	const own = Object.getOwnPropertyDescriptor(differ, "equals");
	const compare = differ.equals;
	let comparisons = 0;
	differ.equals = function (this: Differ, left: string, right: string, options: object): boolean {
		comparisons++;
		return compare.call(this, left, right, options);
	};
	try {
		run();
	} finally {
		if (own) Object.defineProperty(differ, "equals", own);
		else Reflect.deleteProperty(differ, "equals");
	}
	return comparisons;
}

const QUEUE_WORK_PER_MESSAGE = 8;
const QUEUE_LENGTHS = [500, 5_000] as const;

function measureCollectionWork(run: () => void): number {
	const { indexOf, splice } = Array.prototype;
	const { get, set } = Map.prototype;
	let work = 0;
	Array.prototype.indexOf = function <T>(this: T[], item: T, from?: number): number {
		const found = indexOf.call(this, item, from);
		work += found === -1 ? this.length : found + 1;
		return found;
	};
	Array.prototype.splice = function <T>(this: T[], start: number, ...rest: [number?, ...T[]]): T[] {
		work += Math.max(0, this.length - start);
		return splice.apply(this, [start, ...rest] as [number, number, ...T[]]);
	};
	Map.prototype.get = function <K, V>(this: Map<K, V>, key: K): V | undefined {
		work++;
		return get.call(this, key) as V | undefined;
	};
	Map.prototype.set = function <K, V>(this: Map<K, V>, key: K, value: V): Map<K, V> {
		work++;
		return set.call(this, key, value) as Map<K, V>;
	};
	try {
		run();
	} finally {
		Object.assign(Array.prototype, { indexOf, splice });
		Object.assign(Map.prototype, { get, set });
	}
	return work;
}

function words(count: number, step: number, offset: number): string {
	return Array.from({ length: count }, (_, index) => `w${(offset + index * step) % 997}`).join(" ");
}

describe("diff rendering does work linear in its input", () => {
	it("renderDiff highlights a long modified line with word comparisons linear in its length", () => {
		for (const count of SIZES) {
			const diff = `-1 ${words(count, 7, 0)}\n+1 ${words(count, 13, 3)}`;
			const made = countComparisons(wordDiff, () => {
				assert.equal(renderDiff(diff).split("\n").length, 2);
			});
			const bound = WORD_COMPARISONS_PER_WORD * 2 * count;
			assert.ok(made > 0);
			assert.ok(made <= bound, `${count} words: ${made} token comparisons, bound ${bound}`);
		}
	});

	it("generateEditDiff diffs a rewritten block with line comparisons linear in its length", () => {
		for (const count of SIZES) {
			const block = (prefix: string) => Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join("");
			const base = `head\n${block("old")}tail\n`;
			const changed = `head\n${block("new")}tail\n`;
			const replacements = [{ matchIndex: 5, matchLength: base.length - 10, newText: block("new") }];
			const made = countComparisons(lineDiff, () => {
				const { patch } = generateEditDiff("f.txt", base, changed, replacements);
				assert.equal(applyPatch(base, patch), changed);
			});
			const bound = LINE_COMPARISONS_PER_LINE * 2 * count;
			assert.ok(made > 0);
			assert.ok(made <= bound, `${count} lines: ${made} line comparisons, bound ${bound}`);
		}
	});
});

describe("transcript append does work linear in the transcript", () => {
	it("counting messages after each append classifies each child a bounded number of times", () => {
		for (const count of SIZES) {
			let classifications = 0;
			const chat = new StartupChatContainer(() => {
				classifications++;
				return true;
			});
			for (let index = 0; index < count; index++) {
				chat.addChild({ render: () => [`message ${index}`], invalidate() {} });
				assert.equal(chat.countedChildren(), index + 1);
			}
			const bound = CLASSIFICATIONS_PER_CHILD * count;
			assert.ok(classifications > 0);
			assert.ok(classifications <= bound, `${count} children: ${classifications} classifications`);
		}
	});

	it("appending a prompt's replacement before its echo reads the transcript a bounded number of times", () => {
		for (const count of SIZES) {
			const chat = new StartupChatContainer();
			const child = (index: number) => ({ render: () => [`message ${index}`], invalidate() {} });
			for (let index = 0; index < count; index++) chat.addChild(child(index));
			const echo = child(count);
			chat.addChild(echo);
			const reads = { count: 0 };
			chat.children = new Proxy(chat.children, {
				get(target, property, receiver) {
					if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) reads.count++;
					return Reflect.get(target, property, receiver);
				},
			});
			const replacement = child(count + 1);
			appendNewChildrenBeforeAttachedChild(chat, echo, () => chat.addChild(replacement));
			assert.equal(chat.children.at(-2), replacement);
			assert.equal(chat.children.at(-1), echo);
			assert.ok(reads.count > 0);
			assert.ok(
				reads.count <= SWAP_READS_PER_APPEND,
				`${count} children: ${reads.count} child reads, bound ${SWAP_READS_PER_APPEND}`,
			);
		}
	});
});

describe("selector search does work linear in its input", () => {
	it("filterAndSortSessions searches each session's fields a bounded number of times per query token", () => {
		const query = 'render "event loop" fix';
		const tokens = 3;
		for (const count of SIZES) {
			const sessions: SessionInfo[] = Array.from({ length: count }, (_, index) => ({
				path: `/sessions/${index}.jsonl`,
				id: `session-${index}`,
				cwd: `/work/project-${index % 17}`,
				name: index % 5 === 0 ? `Render fix ${index}` : undefined,
				summary: `Summary ${index} of the event loop work`,
				created: new Date(index),
				modified: new Date(index),
				messageCount: 3,
				firstMessage: "hello",
				allMessagesText: `fix the render path ${index}. the event loop stays responsive.`,
			}));
			const searched = sessions.reduce(
				(sum, session) =>
					sum +
					session.id.length +
					session.cwd.length +
					(session.name?.length ?? 0) +
					(session.summary?.length ?? 0) +
					session.allMessagesText.length,
				0,
			);
			const { value, work } = measureStringWork(() => filterAndSortSessions(sessions, query, "relevance"));
			assert.ok(value.length > 0);
			const bound = SESSION_SEARCH_WORK_PER_CHARACTER_PER_TOKEN * tokens * searched;
			assert.ok(work > 0);
			assert.ok(work <= bound, `${count} sessions: ${work} string work, bound ${bound}`);
		}
	});
});

describe("model search does work linear in its input", () => {
	it("the model selector filters its rows with work linear in their search text for each query token", () => {
		const query = "anthropic sonnet 4";
		const tokens = 3;
		for (const count of SIZES) {
			const items = Array.from({ length: count }, (_, index) => {
				const model = {
					id: `model-${index}-sonnet-4`,
					provider: index % 2 === 0 ? "anthropic" : `openrouter-${index % 40}`,
					name: `Model ${index}`,
				};
				return {
					id: `${model.provider}/${model.id}`,
					value: model,
					label: model.id,
					description: model.name,
					searchText: getModelSelectorSearchText(model),
				};
			});
			const state = new SelectorState({ items });
			const { work } = measureStringWork(() => state.setQuery(query));
			assert.ok(state.getVisible().length > 0);
			const searched = items.reduce(
				(sum, item) => sum + item.label.length + item.description.length + item.searchText.length + 3,
				0,
			);
			const bound = SELECTOR_SEARCH_WORK_PER_CHARACTER_PER_TOKEN * tokens * searched;
			assert.ok(work > 0);
			assert.ok(work <= bound, `${count} models: ${work} string work, bound ${bound}`);
		}
	});
});

describe("queue updates do work linear in the queue", () => {
	it("a queue update confirms the editor's queued copies with work linear in the queue", () => {
		for (const length of QUEUE_LENGTHS) {
			const mode: InteractiveModeBase = Object.create(InteractiveModeBase.prototype, {
				session: { value: { getSteeringMessages: () => [], getFollowUpMessages: () => [] } },
			});
			Object.assign(mode, {
				compactionQueuedMessages: [],
				ui: { requestRender() {} },
				updatePendingMessagesDisplay() {},
			});
			const texts = Array.from({ length }, (_, index) => `message ${index % (length / 4)}`);
			for (const text of texts) showSubmissionAsQueued(mode, text, "steer");
			reconcileQueuedSubmissions(mode, { steering: texts.slice(0, length / 2), followUp: [] });
			const work = measureCollectionWork(() => reconcileQueuedSubmissions(mode, { steering: texts, followUp: [] }));
			assert.deepEqual(mode.getAllQueuedMessages(), { steering: [], followUp: [] });
			const bound = QUEUE_WORK_PER_MESSAGE * length;
			assert.ok(work > 0);
			assert.ok(work <= bound, `${length} messages: ${work} collection work, bound ${bound}`);
		}
	});
});

describe("bounded diffs keep their output", () => {
	it("renderDiff still highlights the changed words of a long line with few changes", () => {
		const before = words(SIZES[1], 1, 0);
		const after = before.replace("w10 ", "changed ").replace("w500 ", "edited ");
		const level = chalk.level;
		chalk.level = 1;
		try {
			const [removed, added] = renderDiff(`-1 ${before}\n+1 ${after}`).split("\n");
			assert.match(removed!, /\x1b\[7mw10\x1b\[27m/);
			assert.match(added!, /\x1b\[7mchanged\x1b\[27m/);
			assert.match(added!, /\x1b\[7medited\x1b\[27m/);
		} finally {
			chalk.level = level;
		}
	});

	it("generateEditDiff shows a block rewritten past the diff bound as the whole-file diff does", () => {
		for (const ending of ["\n", ""]) {
			for (const [before, after] of [
				[30, 30],
				[0, 30],
				[30, 0],
				[2, 1],
			] as const) {
				const lines = (prefix: string, count: number) =>
					Array.from({ length: count }, (_, index) => `${prefix} ${index}`);
				const context = (prefix: string, count: number) => lines(prefix, count).map((line) => `${line}\n`);
				const head = context("head", before).join("");
				const oldBlock = lines("old", 600).join("\n");
				const newBlock = lines("new", 500).join("\n");
				const tail = after > 0 ? `\n${lines("tail", after).join("\n")}${ending}` : ending;
				const base = `${head}${oldBlock}${tail}`;
				const changed = `${head}${newBlock}${tail}`;
				const replacements = [{ matchIndex: head.length, matchLength: oldBlock.length, newText: newBlock }];
				const windowed = generateEditDiff("f.txt", base, changed, replacements);
				assert.equal(windowed.patch, generateUnifiedPatch("f.txt", base, changed), `${before}/${after}`);
				assert.equal(applyPatch(base, windowed.patch), changed);
				const shown = windowed.diff.split("\n");
				assert.equal(shown.filter((line) => line.startsWith("-")).length, 600);
				assert.equal(shown.filter((line) => line.startsWith("+")).length, 500);
			}
		}
	});
});
