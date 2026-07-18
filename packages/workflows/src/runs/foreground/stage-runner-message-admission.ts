export class StageMessageAdmission {
  private tail: Promise<void> | undefined;

  run<T>(operation: (release: () => void) => Promise<T>): Promise<T> {
    const admission = this.acquire();
    if (typeof admission === "function") return this.runAdmitted(operation, admission);
    return admission.then((release) => this.runAdmitted(operation, release));
  }

  private acquire(): (() => void) | Promise<() => void> {
    const previous = this.tail;
    const next = Promise.withResolvers<void>();
    this.tail = next.promise;
    const release = (): void => {
      next.resolve();
      if (this.tail === next.promise) this.tail = undefined;
    };
    return previous === undefined ? release : previous.then(() => release);
  }

  private async runAdmitted<T>(operation: (release: () => void) => Promise<T>, release: () => void): Promise<T> {
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release();
    };
    try {
      return await operation(releaseOnce);
    } finally {
      releaseOnce();
    }
  }
}
