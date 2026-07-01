/**
 * Central timing instrumentation for startup profiling.
 * Enable with the app-specific timing environment variable (for Atomic, ATOMIC_TIMING=1).
 */

import { ENV_TIMING, getEnvValue } from "../config.ts";

const ENABLED = getEnvValue(ENV_TIMING) === "1";

interface TimingNamespace {
	timings: Array<{ label: string; ms: number }>;
	lastTime: number;
	resetTime: number;
}

export type TimingLabel = "main" | "extensions";

const timingNamespaces = new Map<TimingLabel, TimingNamespace>();

export interface TimingSpan {
	label: string;
	start: number;
	namespace: TimingLabel;
}

export function isTimingEnabled(): boolean {
	return ENABLED;
}

function ensureNamespace(namespace: TimingLabel): TimingNamespace {
	let entry = timingNamespaces.get(namespace);
	if (!entry) {
		const now = Date.now();
		entry = { timings: [], lastTime: now, resetTime: now };
		timingNamespaces.set(namespace, entry);
	}
	return entry;
}

export function resetTimings(namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	const now = Date.now();
	timingNamespaces.set(namespace, { timings: [], lastTime: now, resetTime: now });
}

export function time(label: string, namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	const now = Date.now();
	const timingNamespace = ensureNamespace(namespace);
	timingNamespace.timings.push({ label, ms: now - timingNamespace.lastTime });
	timingNamespace.lastTime = now;
}

export function startTimingSpan(label: string, namespace: TimingLabel = "main"): TimingSpan | null {
	if (!ENABLED) return null;
	return { label, start: Date.now(), namespace };
}

export function endTimingSpan(span: TimingSpan | null): void {
	if (!ENABLED || !span) return;
	const now = Date.now();
	const timingNamespace = ensureNamespace(span.namespace);
	timingNamespace.timings.push({ label: span.label, ms: now - span.start });
	timingNamespace.lastTime = now;
}

export function recordTiming(label: string, ms: number, namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	const timingNamespace = ensureNamespace(namespace);
	timingNamespace.timings.push({ label, ms });
}

export function recordTimeSinceReset(label: string, namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	const timingNamespace = ensureNamespace(namespace);
	timingNamespace.timings.push({ label, ms: Date.now() - timingNamespace.resetTime });
}

function printTimingGroup(title: string, namespace: TimingNamespace): void {
	const printableTimings = namespace.timings.filter((timing) => timing.ms >= 0);
	if (printableTimings.length === 0) return;
	console.error(`\n--- ${title} ---`);
	for (const t of printableTimings) {
		console.error(`  ${t.label}: ${t.ms}ms`);
	}
	console.error(`  TOTAL initialization time: ${Date.now() - namespace.resetTime}ms`);
	console.error(`${"-".repeat(title.length + 8)}\n`);
}

export function printTimings(): void {
	if (!ENABLED) return;
	for (const [namespace, timingNamespace] of timingNamespaces) {
		printTimingGroup(`Startup Timings: ${namespace}`, timingNamespace);
	}
}
