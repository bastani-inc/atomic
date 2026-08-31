interface ResourceGate {
	readonly promise: Promise<void>;
	resolve(): void;
	reject(error: Error): void;
}

function createResourceGate(): ResourceGate {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	promise.catch(() => {});
	return { promise, resolve, reject };
}

/** Retryable readiness gate for deferred interactive-engine resources. */
export class RpcResourceReadiness {
	private gate = createResourceGate();
	private available = false;
	private failed = false;
	private attempt: Promise<void> | undefined;

	wait(): Promise<void> | undefined {
		return this.available ? undefined : this.gate.promise;
	}

	needsRetry(): boolean {
		return this.failed;
	}

	run(load: () => Promise<void>): Promise<void> {
		if (this.available) return Promise.resolve();
		if (this.attempt) return this.attempt;
		if (this.failed) {
			this.gate = createResourceGate();
			this.failed = false;
		}
		const attempt = load().then(
			() => {
				this.available = true;
				this.gate.resolve();
			},
			(error: unknown) => {
				this.failed = true;
				const resourceError = error instanceof Error ? error : new Error(String(error));
				this.gate.reject(resourceError);
				throw resourceError;
			},
		);
		let tracked!: Promise<void>;
		tracked = attempt.finally(() => {
			if (this.attempt === tracked) this.attempt = undefined;
		});
		this.attempt = tracked;
		return tracked;
	}
}
