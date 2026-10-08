import net from "net";

export const SOCKET_PROBE_TIMEOUT_MS = 1000;

/** True when something accepts a connection on the Unix socket or Windows named pipe at `socketPath`. */
export function isSocketAnswering(socketPath: string, timeoutMs: number = SOCKET_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const finish = (isConnected: boolean) => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      resolve(isConnected);
    };
    const onConnect = () => {
      // end() starts a half-close; a reset can still arrive before close. Keep a handler until then.
      socket.on("error", () => {});
      socket.end();
      finish(true);
    };
    const onError = () => {
      socket.destroy();
      finish(false);
    };
    socket.on("connect", onConnect);
    socket.on("error", onError);
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(false);
    }, timeoutMs);
  });
}
