/**
 * Unit tests for workflow picker overlay mount placement.
 *
 * These exercise the wrappers in `src/tui/session-overlays.ts` and
 * `src/tui/inputs-overlay.ts` to verify they mount via pi's
 * `ctx.ui.custom(factory, { overlay: false })` — i.e. the **inline**
 * mount mode where the host's `ExtensionUiController.custom` REPLACES
 * the editor component with the mounted picker. Inline placement
 * eliminates the bottom-anchored chrome regression captured in
 * `ui/workflows/Screenshot 2026-05-13 at 1.09.32 AM.png` without any
 * overlay padding tricks — the host owns geometry.
 *
 * cross-ref:
 *  - src/tui/session-overlays.ts
 *  - src/tui/inputs-overlay.ts
 *  - pi packages/coding-agent/src/modes/controllers/extension-ui-controller.ts
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { isWorkflowRunResumable } from "../../packages/workflows/src/durable/resume-eligibility.ts";
import type { WorkflowInputEntry } from "../../packages/workflows/src/extension/render-result.ts";
import type {
	PiCustomComponent,
	PiCustomOverlayFactory,
	PiCustomOverlayFactoryTui,
	PiCustomOverlayOptions,
} from "../../packages/workflows/src/extension/wiring.ts";
import { createStore } from "../../packages/workflows/src/shared/store.ts";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.ts";
import {
	ENV_WORKFLOW_ARTIFACT_DIR,
	workflowRunResumeCandidate,
} from "../../packages/workflows/src/shared/workflow-artifacts.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import {
	type InputsPickerResult,
	type InputsUiSurface,
	openInputsPicker,
} from "../../packages/workflows/src/tui/inputs-overlay.ts";
import {
	openSessionPicker,
	type SessionPickerResult,
	type UiSurface,
} from "../../packages/workflows/src/tui/session-overlays.ts";

interface MountCapture {
	factory: PiCustomOverlayFactory;
	options: PiCustomOverlayOptions;
	component: PiCustomComponent;
}

/** Build a `pi.ui.custom`-shaped mock that invokes the factory synchronously. */
function buildCustomSurface(): {
	surface: UiSurface & InputsUiSurface;
	calls: MountCapture[];
} {
	const calls: MountCapture[] = [];
	const surface: UiSurface & InputsUiSurface = {
		custom: (factoryArg, options) => {
			const tui: PiCustomOverlayFactoryTui = {
				requestRender: () => undefined,
			};
			const component = factoryArg(tui, {}, {}, () => undefined);
			if (component instanceof Promise) {
				throw new Error("test factory should be sync");
			}
			calls.push({ factory: factoryArg, options, component });
			return undefined;
		},
	};
	return { surface, calls };
}

function makeRun(over: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: over.id ?? "00000000-0000-0000-0000-000000000000",
		name: over.name ?? "demo",
		inputs: over.inputs ?? {},
		status: over.status ?? "running",
		stages: over.stages ?? [],
		startedAt: over.startedAt ?? Date.now(),
		endedAt: over.endedAt,
		durationMs: over.durationMs,
		result: over.result,
		error: over.error,
		resumable: over.resumable,
	};
}

// ── Session picker ─────────────────────────────────────────────────────────

test("openSessionPicker mounts via ctx.ui.custom with overlay:false (inline mode)", () => {
	const { surface, calls } = buildCustomSurface();
	const store = createStore();
	store.recordRunStart(makeRun({ id: "run-1", name: "alpha" }));
	const theme = deriveGraphTheme({});

	void openSessionPicker(surface as UiSurface, store, theme, "connect");

	assert.equal(calls.length, 1);
	assert.equal(
		calls[0]!.options.overlay,
		false,
		"session picker must mount inline; pi replaces the editor with the picker",
	);
	// No `overlayOptions` / `onHandle` should leak — inline mode is host-managed.
	assert.equal(calls[0]!.options.overlayOptions, undefined);
	assert.equal(calls[0]!.options.onHandle, undefined);
});

test("openSessionPicker renders at the picker's natural inline height", () => {
	const { surface, calls } = buildCustomSurface();
	const store = createStore();
	store.recordRunStart(makeRun({ id: "run-1", name: "alpha" }));
	const theme = deriveGraphTheme({});

	void openSessionPicker(surface as UiSurface, store, theme, "connect");

	const lines = calls[0]!.component.render(80);
	// Natural picker — header / blank / filter / blank / section / row /
	// blank / bottom border / hints. Should never balloon into fullscreen.
	assert.ok(lines.length > 0, "expected non-empty render");
	assert.ok(lines.length < 30, `unexpected line count ${lines.length} — picker should stay inline`);
	// Last line is the keyboard-hint row, not an empty pad. Inline mode
	// does no top-anchor padding.
	assert.notEqual(lines[lines.length - 1], "");
	// First line must be the picker's header border, not a blank pad.
	assert.notEqual(lines[0], "");
});

test("resume picker matches live eligibility when only a stage result references missing artifacts", async () => {
	const root = await mkdtemp(join(tmpdir(), "overlay-resume-artifacts-"));
	const previousRoot = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
	try {
		process.env[ENV_WORKFLOW_ARTIFACT_DIR] = root;
		const { surface, calls } = buildCustomSurface();
		const store = createStore();
		const runId = "stage-artifact-only";
		store.recordRunStart(
			makeRun({
				id: runId,
				status: "paused",
				resumable: true,
				stages: [
					{
						id: "artifact-stage",
						name: "artifact-stage",
						status: "paused",
						parentIds: [],
						toolEvents: [],
						result: `/runs/${runId}/missing/transcript.md`,
					},
				],
			}),
		);
		const fullRun = store.runs()[0]!;
		const projectedRun = store.graphSnapshot().runs[0]!;
		assert.equal(projectedRun.stages[0]?.result, undefined);
		const fullEligibility = isWorkflowRunResumable(workflowRunResumeCandidate(fullRun));
		assert.equal(fullEligibility, false);

		void openSessionPicker(surface as UiSurface, store, deriveGraphTheme({}), "resume");
		const projectedPickerOffersRun = calls[0]!.component.render(80).join("\n").includes(runId);
		assert.equal(projectedPickerOffersRun, fullEligibility);
	} finally {
		if (previousRoot === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});
test("openSessionPicker resolves close when ui.custom is absent (no mount)", async () => {
	const surface: UiSurface = {};
	const store = createStore();
	const theme = deriveGraphTheme({});
	const result: SessionPickerResult = await openSessionPicker(surface, store, theme, "connect");
	assert.deepEqual(result, { kind: "close" });
});

// ── Inputs picker ──────────────────────────────────────────────────────────

const SAMPLE_FIELDS: WorkflowInputEntry[] = [
	{ name: "prompt", type: "text", required: true, description: "task to do" },
];

test("openInputsPicker mounts via ctx.ui.custom with overlay:false (inline mode)", () => {
	const { surface, calls } = buildCustomSurface();
	const theme = deriveGraphTheme({});

	void openInputsPicker(surface as InputsUiSurface, {
		workflowName: "demo",
		fields: SAMPLE_FIELDS,
		theme,
	});

	assert.equal(calls.length, 1);
	assert.equal(
		calls[0]!.options.overlay,
		false,
		"inputs picker must mount inline; pi replaces the editor with the picker",
	);
	assert.equal(calls[0]!.options.overlayOptions, undefined);
	// Dispose to clean up the cursor-blink interval.
	calls[0]!.component.dispose?.();
});

test("openInputsPicker renders at the form's natural inline height", () => {
	const { surface, calls } = buildCustomSurface();
	const theme = deriveGraphTheme({});

	void openInputsPicker(surface as InputsUiSurface, {
		workflowName: "demo",
		fields: SAMPLE_FIELDS,
		theme,
	});

	const lines = calls[0]!.component.render(80);
	assert.ok(lines.length > 0 && lines.length < 30, `unexpected line count ${lines.length}`);
	// Footer hint row is the last natural line — no trailing pad.
	assert.notEqual(lines[lines.length - 1], "");
	calls[0]!.component.dispose?.();
});

test("openInputsPicker resolves cancel when ui.custom is absent (no mount)", async () => {
	const surface: InputsUiSurface = {};
	const theme = deriveGraphTheme({});
	const result: InputsPickerResult = await openInputsPicker(surface, {
		workflowName: "demo",
		fields: SAMPLE_FIELDS,
		theme,
	});
	assert.deepEqual(result, { kind: "cancel" });
});

test("openInputsPicker short-circuits run when fields are empty (no mount)", async () => {
	const { surface, calls } = buildCustomSurface();
	const theme = deriveGraphTheme({});
	const result: InputsPickerResult = await openInputsPicker(surface as InputsUiSurface, {
		workflowName: "demo",
		fields: [],
		theme,
	});
	assert.equal(result.kind, "run");
	assert.equal(calls.length, 0, "no overlay should mount when there are no fields to collect");
});
