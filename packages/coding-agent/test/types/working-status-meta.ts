import type { TUI } from "@bastani/atomic-tui";
import {
	AtomicWorkedStatusComponent,
	type AtomicWorkedStatusOptions,
	AtomicWorkingLoader,
	AtomicWorkingStatusComponent,
	type AtomicWorkingStatusOptions,
} from "../../src/modes/interactive/components/atomic-working-status.ts";
import {
	formatWorkingMeta,
	type LegacyWorkingRunSnapshot,
	normalizeWorkingRunSnapshot,
	type WorkingRunMetaInput,
	type WorkingRunSnapshot,
} from "../../src/modes/interactive/components/working-run-meter.ts";
import {
	WorkingStatusComponent,
	type WorkingStatusComponentOptions,
} from "../../src/modes/interactive/components/working-status.ts";

const legacyMeta: LegacyWorkingRunSnapshot = {
	elapsedMs: 12_000,
	outputTokens: 3_400,
	note: "esc to cancel",
};

const canonicalMeta: WorkingRunSnapshot = {
	elapsedMs: 12_000,
	tokens: 3_400,
	requesting: true,
	note: "esc to cancel",
};

const unionMeta: WorkingRunMetaInput = legacyMeta;
const normalizedSnapshot: WorkingRunSnapshot = normalizeWorkingRunSnapshot(unionMeta);
const formattedLegacy: string = formatWorkingMeta(legacyMeta);
const formattedCanonical: string = formatWorkingMeta(canonicalMeta);

const workingLegacyOpts: WorkingStatusComponentOptions = {
	message: "Working...",
	meta: { elapsedMs: 5_000, outputTokens: 120 },
};

const workingCanonicalOpts: WorkingStatusComponentOptions = {
	message: "Working...",
	meta: { elapsedMs: 5_000, tokens: 120, requesting: false },
};

const atomicLegacyOpts: AtomicWorkingStatusOptions = {
	message: "Working...",
	meta: legacyMeta,
};

const atomicCanonicalOpts: AtomicWorkingStatusOptions = {
	message: "Working...",
	meta: canonicalMeta,
};

const workedLegacyOpts: AtomicWorkedStatusOptions = {
	message: "Brewing...",
	snapshot: { elapsedMs: 9_000, outputTokens: 450 },
};

const workedCanonicalOpts: AtomicWorkedStatusOptions = {
	message: "Brewing...",
	snapshot: canonicalMeta,
};

export function verifyWorkingStatusMetaTypes(ui: TUI): string[] {
	const loader = new AtomicWorkingLoader(ui, undefined, String, "Working...");
	loader.setMeta(() => ({ elapsedMs: 3_000, outputTokens: 80 }));
	loader.setMeta(() => ({ elapsedMs: 3_000, tokens: 80, requesting: true }));
	loader.stop();
	return [
		String(normalizedSnapshot.tokens),
		formattedLegacy,
		formattedCanonical,
		...new WorkingStatusComponent(workingLegacyOpts).render(80),
		...new WorkingStatusComponent(workingCanonicalOpts).render(80),
		...new AtomicWorkingStatusComponent(atomicLegacyOpts).render(80),
		...new AtomicWorkingStatusComponent(atomicCanonicalOpts).render(80),
		...new AtomicWorkedStatusComponent(workedLegacyOpts).render(80),
		...new AtomicWorkedStatusComponent(workedCanonicalOpts).render(80),
	];
}
