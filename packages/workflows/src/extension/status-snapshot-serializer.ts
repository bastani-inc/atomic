import { Worker } from "node:worker_threads";
import type { StoreSnapshot } from "../shared/store-types.js";

const SERIALIZE_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (snapshot) => {
	try {
		parentPort.postMessage({ text: JSON.stringify(snapshot, null, 2) });
	} catch (error) {
		parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
	}
});
`;

interface SerializeReply {
	readonly text?: string;
	readonly error?: string;
}

export class StatusSnapshotSerializer {
	private worker: Worker | undefined;
	private pending: { resolve(text: string): void; reject(error: Error): void } | undefined;

	serialize(snapshot: StoreSnapshot): Promise<string> {
		const worker = this.worker ?? this.open();
		worker.ref();
		return new Promise<string>((resolve, reject) => {
			this.pending = { resolve, reject };
			try {
				worker.postMessage(snapshot);
			} catch (error) {
				this.pending = undefined;
				worker.unref();
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	close(): void {
		const worker = this.worker;
		this.worker = undefined;
		this.pending?.reject(new Error("Status serialization stopped"));
		this.pending = undefined;
		void worker?.terminate().catch(() => {});
	}

	private open(): Worker {
		const worker = new Worker(SERIALIZE_SOURCE, { eval: true });
		this.worker = worker;
		worker.unref();
		worker.on("message", (reply: SerializeReply) => {
			if (this.worker !== worker) return;
			const pending = this.pending;
			this.pending = undefined;
			worker.unref();
			if (reply.text !== undefined) pending?.resolve(reply.text);
			else pending?.reject(new Error(reply.error ?? "Status serializer returned no content"));
		});
		worker.on("error", (error: Error) => {
			if (this.worker !== worker) return;
			this.worker = undefined;
			this.pending?.reject(error);
			this.pending = undefined;
		});
		worker.on("exit", (code) => {
			if (this.worker !== worker) return;
			this.worker = undefined;
			this.pending?.reject(new Error(`Status serializer exited with code ${code}`));
			this.pending = undefined;
		});
		return worker;
	}
}
