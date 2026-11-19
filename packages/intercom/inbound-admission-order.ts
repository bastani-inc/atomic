/** One place in the inbound admission line, taken when a message arrives. */
export interface AdmissionPlace {
  /**
   * Runs `operation` once every earlier place has finished, and finishes before any later place starts; with nothing
   * ahead it starts at once, synchronously. An operation must not wait for a later place, nor for a model turn to
   * end: it admits, it does not await the work it admits.
   */
  run<T>(operation: () => T | Promise<T>): Promise<T>;
  /** Gives up this place without running anything, so later places need not wait for it. */
  cancel(): void;
}

interface Place {
  start?: () => void;
  started: boolean;
}

/**
 * The order in which a session admits what reaches it: each arriving message takes a place when it arrives, before its
 * save, and every path that writes a message to the session (at once, from the idle queue, on resume) runs in one
 * of these places. One sender's messages therefore reach the session in the order they arrived,
 * whichever path each takes, and a slow save never lets a later message overtake an earlier one.
 */
export class InboundAdmissionOrder {
  private readonly line: Place[] = [];

  reserve(): AdmissionPlace {
    const place: Place = { started: false };
    this.line.push(place);
    let used = false;
    return {
      run: <T>(operation: () => T | Promise<T>): Promise<T> => {
        if (used) return Promise.reject(new Error("Inbound admission place was already used"));
        used = true;
        return new Promise<T>((resolve, reject) => {
          place.start = () => {
            place.started = true;
            let result: T | Promise<T>;
            try {
              result = operation();
            } catch (error) {
              this.finish(place);
              reject(error);
              return;
            }
            Promise.resolve(result).then(
              (value) => {
                this.finish(place);
                resolve(value);
              },
              (error: unknown) => {
                this.finish(place);
                reject(error);
              },
            );
          };
          if (this.line[0] === place) place.start();
        });
      },
      cancel: () => {
        if (used) return;
        used = true;
        this.finish(place);
      },
    };
  }

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.reserve().run(operation);
  }

  /**
   * A place behind everything already in line, or undefined when the line is empty and the caller can go on at once,
   * as a finished child's completion notice does: it follows every message that arrived before it, and nothing that
   * arrives after it can take that child's queued messages ahead of it.
   */
  reserveBehindBusyLine(): AdmissionPlace | undefined {
    return this.line.length === 0 ? undefined : this.reserve();
  }

  private finish(place: Place): void {
    const index = this.line.indexOf(place);
    if (index < 0) return;
    this.line.splice(index, 1);
    const head = this.line[0];
    if (index === 0 && head !== undefined && head.start !== undefined && !head.started) head.start();
  }
}
