import type { Markit, StreamInfo } from "markit-ai";
import { memoizeAsync } from "./memoize-async.js";
import { loadOnDemand } from "./updated-install.ts";

export interface MarkitConversionResult {
	content: string;
	ok: boolean;
	error?: string;
}

/**
 * MuPDF ships as an Emscripten module whose fd 1 and fd 2 sinks default to
 * `console.log` / `console.error` (`mupdf/dist/mupdf-wasm.js`:
 * `t.print&&(T=t.print),t.printErr&&(j=t.printErr)`), and
 * `mupdf/dist/mupdf.js` builds that module at import time from
 * `globalThis["$libmupdf_wasm_Module"]`. A PDF with a damaged `/FlateDecode`
 * stream therefore writes diagnostics straight to the terminal. Capture a
 * bounded batch and deliver it through the active TUI sink or console.log.
 * RPC mode's stdout guard forwards console.log to the host through stderr.
 */
const MUPDF_MODULE_GLOBAL = "$libmupdf_wasm_Module";
const MAX_MUPDF_DIAGNOSTIC_LINES = 32;
const MAX_MUPDF_DIAGNOSTIC_LENGTH = 4096;
let diagnosticSink: ((message: string) => void) | undefined;

/** Bind the in-process interactive renderer for its lifetime. */
export function setMarkitDiagnosticSink(sink: (message: string) => void): () => void {
	const previous = diagnosticSink;
	diagnosticSink = sink;
	return () => {
		if (diagnosticSink === sink) diagnosticSink = previous;
	};
}

function logMupdfDiagnostics(): void {
	if (mupdfDiagnostics.length === 0) return;
	const message = mupdfDiagnostics.join("\n");
	if (diagnosticSink) diagnosticSink(message);
	else console.log(message);
}

// Process-global because the MuPDF module is: concurrent conversions may
// cross-attribute a line. The text is advisory suffix on an error message,
// never a decision input, so that imprecision is acceptable.
let mupdfDiagnostics: string[] = [];

function recordMupdfDiagnostic(line: string): void {
	if (mupdfDiagnostics.length >= MAX_MUPDF_DIAGNOSTIC_LINES) mupdfDiagnostics.shift();
	mupdfDiagnostics.push(line.slice(0, MAX_MUPDF_DIAGNOSTIC_LENGTH));
}

/** Must run before the first `import("markit-ai")`; mupdf reads the global at module evaluation. */
function captureMupdfDiagnostics(): void {
	const globals = globalThis as Record<string, unknown>;
	const existing = (globals[MUPDF_MODULE_GLOBAL] ?? {}) as Record<string, unknown>;
	globals[MUPDF_MODULE_GLOBAL] = { ...existing, print: recordMupdfDiagnostic, printErr: recordMupdfDiagnostic };
}

function withMupdfDiagnostics(message: string): string {
	if (mupdfDiagnostics.length === 0) return message;
	logMupdfDiagnostics();
	const detail = mupdfDiagnostics.join("; ");
	mupdfDiagnostics = [];
	return `${message} (mupdf: ${detail})`;
}

const getMarkit = memoizeAsync(async (): Promise<Markit> => {
	captureMupdfDiagnostics();
	// A shared file of the installation: an update that replaced it while this process runs asks for a restart.
	const { Markit } = await loadOnDemand("document conversion", () => import("markit-ai"));
	return new Markit();
});

function normalizeExtension(extension: string): string {
	const trimmed = extension.trim().toLowerCase();
	return trimmed ? (trimmed.startsWith(".") ? trimmed : `.${trimmed}`) : ".bin";
}

function normalizeError(error: unknown): string {
	return error instanceof Error && error.message.trim().length > 0 ? error.message.trim() : "Conversion failed";
}

function abortError(): Error {
	const error = new Error("Aborted");
	error.name = "AbortError";
	return error;
}

async function runMarkitConversion<T>(task: (markit: Markit) => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) throw abortError();
	const instance = await getMarkit();
	mupdfDiagnostics = [];
	if (!signal) return task(instance);
	return await new Promise<T>((resolve, reject) => {
		const abort = () => reject(abortError());
		signal.addEventListener("abort", abort, { once: true });
		void task(instance)
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}

function finalizeConversion(markdown?: string): MarkitConversionResult {
	if (typeof markdown === "string" && markdown.length > 0) {
		logMupdfDiagnostics();
		mupdfDiagnostics = [];
		return { content: markdown, ok: true };
	}
	return { content: "", ok: false, error: withMupdfDiagnostics("Conversion produced no output") };
}

export async function convertFileWithMarkit(filePath: string, signal?: AbortSignal): Promise<MarkitConversionResult> {
	try {
		return finalizeConversion(
			(await runMarkitConversion((instance) => instance.convertFile(filePath), signal)).markdown,
		);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw error;
		return { content: "", ok: false, error: withMupdfDiagnostics(normalizeError(error)) };
	}
}

export async function convertBufferWithMarkit(
	buffer: Uint8Array,
	extension: string,
	signal?: AbortSignal,
): Promise<MarkitConversionResult> {
	const normalizedExtension = normalizeExtension(extension);
	const streamInfo: StreamInfo = { extension: normalizedExtension, filename: `input${normalizedExtension}` };
	try {
		return finalizeConversion(
			(await runMarkitConversion((instance) => instance.convert(Buffer.from(buffer), streamInfo), signal)).markdown,
		);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw error;
		return { content: "", ok: false, error: withMupdfDiagnostics(normalizeError(error)) };
	}
}
