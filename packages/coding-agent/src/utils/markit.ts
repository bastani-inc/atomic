import type { Markit, StreamInfo } from "markit-ai";

export interface MarkitConversionResult { content: string; ok: boolean; error?: string }

let markit: () => Markit | Promise<Markit> = async () => {
	const promise = import("markit-ai").then(({ Markit }) => {
		const instance = new Markit();
		markit = () => instance;
		return instance;
	});
	markit = () => promise;
	return promise;
};

function normalizeExtension(extension: string): string {
	const trimmed = extension.trim().toLowerCase();
	return trimmed ? trimmed.startsWith(".") ? trimmed : `.${trimmed}` : ".bin";
}

function normalizeError(error: unknown): string { return error instanceof Error && error.message.trim().length > 0 ? error.message.trim() : "Conversion failed"; }

function abortError(): Error { const error = new Error("Aborted"); error.name = "AbortError"; return error; }

async function runMarkitConversion<T>(task: (markit: Markit) => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) throw abortError();
	const instance = await markit();
	if (!signal) return task(instance);
	return await new Promise<T>((resolve, reject) => {
		const abort = () => reject(abortError());
		signal.addEventListener("abort", abort, { once: true });
		void task(instance).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

function finalizeConversion(markdown?: string): MarkitConversionResult {
	return typeof markdown === "string" && markdown.length > 0 ? { content: markdown, ok: true } : { content: "", ok: false, error: "Conversion produced no output" };
}

export async function convertFileWithMarkit(filePath: string, signal?: AbortSignal): Promise<MarkitConversionResult> {
	try { return finalizeConversion((await runMarkitConversion((instance) => instance.convertFile(filePath), signal)).markdown); }
	catch (error) { if (error instanceof Error && error.name === "AbortError") throw error; return { content: "", ok: false, error: normalizeError(error) }; }
}

export async function convertBufferWithMarkit(buffer: Uint8Array, extension: string, signal?: AbortSignal): Promise<MarkitConversionResult> {
	const normalizedExtension = normalizeExtension(extension);
	const streamInfo: StreamInfo = { extension: normalizedExtension, filename: `input${normalizedExtension}` };
	try { return finalizeConversion((await runMarkitConversion((instance) => instance.convert(Buffer.from(buffer), streamInfo), signal)).markdown); }
	catch (error) { if (error instanceof Error && error.name === "AbortError") throw error; return { content: "", ok: false, error: normalizeError(error) }; }
}
