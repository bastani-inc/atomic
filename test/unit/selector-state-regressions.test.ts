import assert from "node:assert/strict";
import { test } from "vitest";
import {
	type SelectorItem,
	SelectorState,
} from "../../packages/coding-agent/src/modes/interactive/components/selector.js";

test("catalog search can exclude displayed effort without changing default label search (#5237)", () => {
	const rows: SelectorItem<string>[] = [
		{
			id: "o3",
			value: "o3",
			label: "o3 medium",
			description: "medium",
			tag: "medium",
			searchText: "openai o3",
			searchTextMode: "replace",
		},
		{
			id: "mistral",
			value: "mistral",
			label: "Mistral Medium high",
			searchText: "mistral medium",
			searchTextMode: "replace",
		},
		{ id: "anthropic", value: "anthropic", label: "Anthropic", searchText: "provider oauth" },
	];
	const state = new SelectorState({ items: rows });
	state.setQuery("medium");
	assert.deepEqual(
		state.getVisible().map((row) => row.id),
		["mistral"],
	);
	state.setQuery("anthropic");
	assert.deepEqual(
		state.getVisible().map((row) => row.id),
		["anthropic"],
	);
});

test("disabled initial and replacement rows never hide an enabled choice (#5237)", () => {
	const rows = [
		{ id: "enabled", value: "enabled", label: "enabled" },
		{ id: "disabled", value: "disabled", label: "disabled", disabled: true },
	];
	const initial = new SelectorState({ items: rows, initialId: "disabled" });
	assert.equal(initial.getSelected()?.id, "enabled");
	const replaced = new SelectorState({
		items: [rows[0]!, { id: "removed", value: "removed", label: "removed" }],
		initialId: "removed",
	});
	replaced.setItems(rows);
	assert.equal(replaced.getSelected()?.id, "enabled");
	replaced.setQuery("disabled");
	assert.equal(replaced.getSelected(), undefined);
	replaced.setQuery("");
	assert.equal(replaced.getSelected()?.id, "enabled");
});

test("invalid selection and movement numbers leave the highlighted row unchanged (#5237)", () => {
	const state = new SelectorState({
		items: ["a", "b", "c"].map((id) => ({ id, value: id, label: id })),
		initialId: "b",
	});
	for (const index of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		state.select(index);
		assert.equal(state.getSelected()?.id, "b");
		state.move(index);
		assert.equal(state.getSelected()?.id, "b");
	}
});

test("cached selector metadata and item lists cannot be changed outside state updates (#5237)", () => {
	const rows = [{ id: "a", value: "a", label: "a" }];
	const state = new SelectorState({ items: rows });
	const stats = state.getVisibleStats();
	assert.equal(Object.isFrozen(stats), true);
	assert.equal(Reflect.set(stats, "enabledCount", 0), false);
	assert.equal(state.getVisibleStats().enabledCount, 1);
	const revision = state.getRevision();
	assert.equal(Reflect.set(state, "items", []), false);
	rows.push({ id: "b", value: "b", label: "b" });
	assert.deepEqual(
		state.items.map((row) => row.id),
		["a"],
	);
	assert.equal(Reflect.set(state.items, "0", { id: "c", value: "c", label: "c" }), false);
	state.setItems(rows);
	assert.ok(state.getRevision() > revision);
	assert.deepEqual(
		state.items.map((row) => row.id),
		["a", "b"],
	);
});
