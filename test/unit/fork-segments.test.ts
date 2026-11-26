import assert from "node:assert/strict";
import { test } from "vitest";
import {
	assertForkSegments,
	type ForkSegment,
	forkPieces,
	forkRunSegments,
	joinForkSegments,
	locateForkSeq,
	prefixForkSegments,
} from "../../packages/coding-agent/src/core/storage/session/fork-segments.js";

/** A session as a store keeps it: its own rows by seq, the segments it inherits, and its view's length. */
interface Kept {
	readonly own: Map<number, string>;
	segments: ForkSegment[];
	length: number;
}

/** A small deterministic generator, so a failure names the seed that found it. */
function random(seed: number) {
	let state = seed >>> 0 || 1;
	return (below: number) => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) % below;
	};
}

/** The view of `id` read through its segments, a piece at a time, as a store reads a range. */
function lazyView(kept: Map<string, Kept>, id: string): string[] {
	const session = kept.get(id)!;
	const view: string[] = [];
	for (const piece of forkPieces(id, session.segments, 1, session.length)) {
		const source = kept.get(piece.sessionId)!;
		for (let seq = piece.fromSeq; seq <= piece.toSeq; seq++) {
			const value = source.own.get(seq);
			assert.ok(value !== undefined, `${piece.sessionId} stores seq ${seq} that ${id} reads`);
			view.push(value);
		}
	}
	return view;
}

test("a fork's segments read exactly what a copied fork holds, across random forks, appends and depths (#6560)", () => {
	for (let seed = 1; seed <= 300; seed++) {
		const next = random(seed);
		const kept = new Map<string, Kept>();
		/** What each session would hold had every fork copied its rows. */
		const copies = new Map<string, string[]>();
		let made = 0;
		const append = (id: string, count: number) => {
			const session = kept.get(id)!;
			for (let i = 0; i < count; i++) {
				session.length++;
				const value = `${id}#${session.length}`;
				session.own.set(session.length, value);
				copies.get(id)!.push(value);
			}
		};
		const root = `s${made++}`;
		kept.set(root, { own: new Map(), segments: [], length: 0 });
		copies.set(root, []);
		append(root, 1 + next(6));
		for (let step = 0; step < 40; step++) {
			const ids = [...kept.keys()];
			const parentId = ids[next(ids.length)]!;
			const parent = kept.get(parentId)!;
			const action = next(4);
			if (action === 0) {
				append(parentId, 1 + next(3));
				continue;
			}
			const id = `s${made++}`;
			const child: Kept = { own: new Map(), segments: [], length: 0 };
			const copy: string[] = [];
			if (action === 1) {
				// A prefix fork at any cut, the parent's whole view and an empty fork included.
				const cut = next(parent.length + 1);
				child.segments = prefixForkSegments(parentId, parent.segments, parent.length, cut);
				child.length = cut;
				copy.push(...copies.get(parentId)!.slice(0, cut));
			} else {
				// A branch fork: increasing runs of the parent's view, with rows of the child's own between them.
				let from = 1 + next(Math.max(1, parent.length));
				while (from <= parent.length) {
					if (next(3) === 0) {
						child.length++;
						const value = `${id}#${child.length}`;
						child.own.set(child.length, value);
						copy.push(value);
					}
					const to = Math.min(parent.length, from + next(4));
					child.segments.push(
						...forkRunSegments(parentId, parent.segments, parent.length, {
							fromSeq: from,
							toSeq: to,
							baseSeq: child.length,
						}),
					);
					copy.push(...copies.get(parentId)!.slice(from - 1, to));
					child.length += to - from + 1;
					from = to + 2 + next(3);
				}
				child.segments = joinForkSegments(child.segments);
			}
			kept.set(id, child);
			copies.set(id, copy);
			if (next(2) === 0) append(id, 1 + next(3));
		}
		for (const [id, session] of kept) {
			assertForkSegments(id, session.segments, session.length);
			assert.deepEqual(lazyView(kept, id), copies.get(id), `seed ${seed}, session ${id}`);
			for (const segment of session.segments)
				assert.equal(
					kept.get(segment.sourceId)!.segments.some((inherited) => inherited.sourceId === id),
					false,
				);
			for (let seq = 1; seq <= session.length; seq++) {
				const at = locateForkSeq(id, session.segments, seq);
				assert.equal(
					kept.get(at.sessionId)!.own.get(at.seq),
					copies.get(id)![seq - 1],
					`seed ${seed}, ${id}@${seq}`,
				);
			}
		}
	}
});

test("a fork at the parent's whole view keeps one segment for each place its rows are stored, at any depth (#6560)", () => {
	const kept = new Map<string, Kept>([["s0", { own: new Map([[1, "a"]]), segments: [], length: 1 }]]);
	let parentId = "s0";
	for (let depth = 1; depth <= 50; depth++) {
		const parent = kept.get(parentId)!;
		const id = `s${depth}`;
		const segments = prefixForkSegments(parentId, parent.segments, parent.length, parent.length);
		kept.set(id, { own: new Map([[parent.length + 1, `${id}`]]), segments, length: parent.length + 1 });
		parentId = id;
	}
	const leaf = kept.get("s50")!;
	assert.equal(leaf.segments.length, 50, "one segment for each ancestor's own rows");
	assert.deepEqual(locateForkSeq("s50", leaf.segments, 1), { sessionId: "s0", seq: 1 });
	assert.deepEqual(locateForkSeq("s50", leaf.segments, 51), { sessionId: "s50", seq: 51 });
	assert.deepEqual(lazyView(kept, "s50"), ["a", ...Array.from({ length: 50 }, (_, i) => `s${i + 1}`)]);
});

test("a fork never takes rows past its parent's view, and an empty fork has no segments (#6560)", () => {
	assert.deepEqual(prefixForkSegments("p", [], 3, 0), []);
	assert.throws(() => prefixForkSegments("p", [], 3, 4), RangeError);
	assert.throws(() => forkRunSegments("p", [], 3, { fromSeq: 2, toSeq: 4, baseSeq: 0 }), RangeError);
	assert.throws(() => assertForkSegments("c", [{ sourceId: "p", fromSeq: 1, toSeq: 3, baseSeq: 0 }], 2), RangeError);
	assert.throws(() => assertForkSegments("c", [{ sourceId: "c", fromSeq: 1, toSeq: 1, baseSeq: 0 }], 2), RangeError);
	assert.throws(
		() =>
			assertForkSegments(
				"c",
				[
					{ sourceId: "p", fromSeq: 2, toSeq: 2, baseSeq: 0 },
					{ sourceId: "p", fromSeq: 2, toSeq: 2, baseSeq: 1 },
				],
				2,
			),
		RangeError,
		"one stored row at two seqs",
	);
	// The inherited part of a child of a child stops at its own cut, inside the grandparent's rows.
	const parent = prefixForkSegments("g", [], 5, 5);
	assert.deepEqual(prefixForkSegments("p", parent, 7, 3), [{ sourceId: "g", fromSeq: 1, toSeq: 3, baseSeq: 0 }]);
	assert.deepEqual(prefixForkSegments("p", parent, 7, 6), [
		{ sourceId: "g", fromSeq: 1, toSeq: 5, baseSeq: 0 },
		{ sourceId: "p", fromSeq: 6, toSeq: 6, baseSeq: 5 },
	]);
});
