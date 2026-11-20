import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { evalWorkerExecArgv } from "../utils/worker-threads.js";

const QUEUED = 0;
const WRITING = 1;
const LANDED = 2;
const CLAIMED = 3;
const FAILED = 4;

const SOURCE = `
const { parentPort } = require("node:worker_threads");
const { appendFileSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");
parentPort.on("message", ({ id, path, chunk, state: buffer, createDirectory }) => {
	const state = new Int32Array(buffer);
	if (Atomics.compareExchange(state, 0, ${QUEUED}, ${WRITING}) !== ${QUEUED}) {
		while (Atomics.load(state, 0) === ${CLAIMED}) Atomics.wait(state, 0, ${CLAIMED});
		return;
	}
	let error;
	try {
		if (createDirectory) mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, chunk);
		Atomics.store(state, 0, ${LANDED});
	} catch (cause) {
		error = String(cause);
		Atomics.store(state, 0, ${FAILED});
	}
	Atomics.notify(state, 0);
	parentPort.postMessage({ id, error });
});
`;

interface Append {
	readonly id: number;
	readonly path: string;
	readonly chunk: string;
	readonly state: Int32Array;
	readonly worker: Worker;
	readonly done: Promise<void>;
	readonly settle: (error?: Error) => void;
}

let worker: Worker | undefined;
let nextId = 0;
const outstanding = new Map<number, Append>();
const counts = new Map<Worker, number>();

function getWorker(): Worker {
	if (worker !== undefined) return worker;
	const created = new Worker(SOURCE, { eval: true, execArgv: evalWorkerExecArgv() });
	created.on("message", ({ id, error }: { id: number; error?: string }) => {
		outstanding.get(id)?.settle(error === undefined ? undefined : new Error(error));
	});
	const fail = (error: Error): void => {
		if (worker === created) worker = undefined;
		for (const append of outstanding.values()) {
			if (append.worker !== created) continue;
			Atomics.store(append.state, 0, FAILED);
			Atomics.notify(append.state, 0);
			append.settle(error);
		}
	};
	created.on("error", fail);
	created.on("exit", (code) => fail(new Error(`Diagnostic writer exited (${code})`)));
	created.unref();
	worker = created;
	return created;
}

export class DiagnosticWriter {
	private readonly pending = new Set<Append>();
	private readonly onFailure: (path: string, error: Error) => void;
	private readonly createDirectory: boolean;

	constructor(onFailure: (path: string, error: Error) => void, createDirectory = false) {
		this.onFailure = onFailure;
		this.createDirectory = createDirectory;
	}

	append(path: string, chunk: string): Promise<void> {
		try {
			const target = getWorker();
			const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
			const id = nextId++;
			let resolve!: () => void;
			const done = new Promise<void>((settle) => {
				resolve = settle;
			});
			const append: Append = {
				id,
				path,
				chunk,
				state,
				worker: target,
				done,
				settle: (error) => {
					if (!this.pending.delete(append)) return;
					outstanding.delete(id);
					const remaining = (counts.get(target) ?? 1) - 1;
					if (remaining === 0) {
						counts.delete(target);
						target.unref();
					} else counts.set(target, remaining);
					if (error !== undefined) this.onFailure(path, error);
					resolve();
				},
			};
			this.pending.add(append);
			outstanding.set(id, append);
			counts.set(target, (counts.get(target) ?? 0) + 1);
			target.ref();
			try {
				target.postMessage({ id, path, chunk, state: state.buffer, createDirectory: this.createDirectory });
			} catch (error) {
				append.settle(error instanceof Error ? error : new Error(String(error)));
			}
			return done;
		} catch (error) {
			this.onFailure(path, error instanceof Error ? error : new Error(String(error)));
			return Promise.resolve();
		}
	}

	async written(): Promise<void> {
		await Promise.all([...this.pending].map((append) => append.done));
	}

	flushSync(): void {
		for (const append of this.pending) {
			let error: Error | undefined;
			if (Atomics.compareExchange(append.state, 0, QUEUED, CLAIMED) === QUEUED) {
				try {
					if (this.createDirectory) mkdirSync(dirname(append.path), { recursive: true });
					appendFileSync(append.path, append.chunk);
					Atomics.store(append.state, 0, LANDED);
				} catch (cause) {
					error = cause instanceof Error ? cause : new Error(String(cause));
					Atomics.store(append.state, 0, FAILED);
				}
				Atomics.notify(append.state, 0);
			} else {
				while (Atomics.load(append.state, 0) === WRITING) Atomics.wait(append.state, 0, WRITING);
			}
			if (Atomics.load(append.state, 0) === FAILED) error ??= new Error("Diagnostic append failed");
			append.settle(error);
		}
	}
}
