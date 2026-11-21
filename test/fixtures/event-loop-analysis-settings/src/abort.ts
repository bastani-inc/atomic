import { existsSync } from "node:fs";

function checkCatalog(): void {
	existsSync("catalog");
}

/** Startup work that stops waiting for the model catalog when its signal aborts, later, on the event loop. */
export function waitForCatalog(signal: AbortSignal): void {
	signal.addEventListener("abort", checkCatalog, { once: true });
}

waitForCatalog(new AbortController().signal);
