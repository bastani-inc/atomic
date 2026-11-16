import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { PiCustomComponent } from "../../packages/workflows/src/extension/wiring.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	invalidDefinitionsFromDiagnostics,
	openWorkflowsListing,
	type WorkflowsListingInvalidDefinition,
	type WorkflowsListingTarget,
	workflowsListingItems,
} from "../../packages/workflows/src/tui/workflows-listing.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
	vi.useFakeTimers({ now: 10_000 });
});
afterEach(() => {
	setKeybindings(previousKeys);
	vi.useRealTimers();
});

const run: RunSnapshot = {
	id: "aaaaaaaa",
	name: "review",
	status: "running",
	inputs: {},
	stages: [],
	toolNodes: [],
	startedAt: 0,
} as RunSnapshot;

function invalid(name: string): WorkflowsListingInvalidDefinition {
	return invalidDefinitionsFromDiagnostics([
		{ level: "error", code: "IMPORT_FAILED", source: `/repo/${name}.ts`, message: `Error: ${name} failed` },
	])[0]!;
}

function mount(initial: readonly WorkflowsListingInvalidDefinition[]) {
	let definitions = initial;
	let invalidation: (() => void) | undefined;
	let component: PiCustomComponent | undefined;
	let reads = 0;
	const pending = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					component = factory({ requestRender() {}, terminal: { rows: 40 } }, undefined, undefined, () =>
						resolve(undefined),
					) as PiCustomComponent;
				}),
		},
		{
			runs: () => [run],
			definitions: () => [],
			invalidDefinitions: () => {
				reads++;
				return definitions;
			},
			subscribe: (listener) => {
				invalidation = listener;
				return () => {
					invalidation = undefined;
				};
			},
		},
	);
	assert.ok(component);
	return {
		component,
		pending,
		reads: () => reads,
		text: () => stripVTControlCharacters(component!.render(100).join("\n")),
		update(next: readonly WorkflowsListingInvalidDefinition[]) {
			definitions = next;
			invalidation?.();
		},
	};
}

test("broken definitions stay visible across compact listing clock ticks without rediscovery (#5255)", async () => {
	const fixture = mount([invalid("greet")]);
	try {
		assert.match(fixture.text(), /failed to load · greet failed/);
		assert.equal(fixture.reads(), 1);
		vi.advanceTimersByTime(2_000);
		assert.match(fixture.text(), /failed to load · greet failed/);
		assert.equal(fixture.reads(), 1);
		fixture.component.handleInput?.("\x1b[B");
		fixture.component.render(100);
		fixture.component.handleInput?.("\r");
		const target: WorkflowsListingTarget | undefined = await fixture.pending;
		assert.equal(target?.kind, "invalid-definition");
		if (target?.kind === "invalid-definition") assert.equal(target.definition.name, "greet");
	} finally {
		fixture.component.dispose?.();
		await fixture.pending;
	}
});

test("a diagnostic refresh keeps the searched broken definition selected and uses its latest reason (#5255)", async () => {
	const fixture = mount([invalid("greet")]);
	try {
		fixture.component.handleInput?.("g");
		assert.match(fixture.text(), /failed to load · greet failed/);
		const updated = { ...invalid("greet"), reason: "greet changed", message: "Error: greet changed" };
		fixture.update([invalid("deploy"), updated]);
		assert.match(fixture.text(), /❯ greet/);
		assert.match(fixture.text(), /failed to load · greet changed/);
		assert.equal(fixture.reads(), 2);
		fixture.component.handleInput?.("\r");
		assert.deepEqual(await fixture.pending, { kind: "invalid-definition", definition: updated });
	} finally {
		fixture.component.dispose?.();
		await fixture.pending;
	}
});

test("removing a broken definition cannot confirm its unpainted replacement (#5255)", async () => {
	const fixture = mount([invalid("deploy"), invalid("greet")]);
	try {
		fixture.component.handleInput?.("\x1b[B");
		assert.match(fixture.text(), /❯ deploy/);
		let settled = false;
		void fixture.pending.then(() => {
			settled = true;
		});
		fixture.update([invalid("greet")]);
		fixture.component.handleInput?.("\r");
		await Promise.resolve();
		assert.equal(settled, false);
		assert.match(fixture.text(), /❯ greet/);
		fixture.component.handleInput?.("\r");
		const target = await fixture.pending;
		assert.equal(target?.kind, "invalid-definition");
		if (target?.kind === "invalid-definition") assert.equal(target.definition.name, "greet");
	} finally {
		fixture.component.dispose?.();
		await fixture.pending;
	}
});

test("compact run and definition rows keep bidirectional controls inert without changing targets (#5255)", () => {
	const name = "review\u202eevil";
	const rows = workflowsListingItems(
		[{ ...run, name, label: "label\u2066evil" }],
		[{ normalizedName: name, description: "description\u202eevil", inputs: {} }],
	);
	for (const row of rows) {
		assert.doesNotMatch(`${row.label} ${row.description}`, /[\u202e\u2066]/);
		assert.match(row.label, /<U\+202E>/);
	}
	assert.deepEqual(rows[1]!.value, { kind: "definition", name });
});
