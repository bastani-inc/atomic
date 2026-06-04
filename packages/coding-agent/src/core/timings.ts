/**
 * Central timing instrumentation for startup profiling.
 * Enable with the app-specific timing environment variable (for Atomic, ATOMIC_TIMING=1).
 */

import { ENV_TIMING, getEnvValue } from "../config.ts";

const ENABLED = getEnvValue(ENV_TIMING) === "1";
const timings: Array<{ label: string; ms: number }> = [];
let lastTime = Date.now();
let resetTime = lastTime;

export interface TimingSpan {
	label: string;
	start: number;
}

export function isTimingEnabled(): boolean {
	return ENABLED;
}

export function resetTimings(): void {
	if (!ENABLED) return;
	timings.length = 0;
	lastTime = Date.now();
	resetTime = lastTime;
}

export function time(label: string): void {
	if (!ENABLED) return;
	const now = Date.now();
	timings.push({ label, ms: now - lastTime });
	lastTime = now;
}

export function startTimingSpan(label: string): TimingSpan | null {
	if (!ENABLED) return null;
	return { label, start: Date.now() };
}

export function endTimingSpan(span: TimingSpan | null): void {
	if (!ENABLED || !span) return;
	const now = Date.now();
	timings.push({ label: span.label, ms: now - span.start });
	lastTime = now;
}

export function recordTiming(label: string, ms: number): void {
	if (!ENABLED) return;
	timings.push({ label, ms });
}

export function recordTimeSinceReset(label: string): void {
	if (!ENABLED) return;
	timings.push({ label, ms: Date.now() - resetTime });
}

export function printTimings(): void {
	if (!ENABLED || timings.length === 0) return;
	console.error("\n--- Startup Timings ---");
	for (const t of timings) {
		console.error(`  ${t.label}: ${t.ms}ms`);
	}
	console.error(`  TOTAL initialization time: ${Date.now() - resetTime}ms`);
	console.error("------------------------\n");
}
