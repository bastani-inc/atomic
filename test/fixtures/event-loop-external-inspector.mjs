import { access } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  startEventLoopMonitor, waitForEventLoopMonitorReady, markEventLoopShutdown,
} from '../../packages/coding-agent/dist/core/event-loop-monitor.js';

startEventLoopMonitor('engine');
await waitForEventLoopMonitorReady();
console.log('monitor ready');
while (!(await access(process.argv[2]).then(() => true, () => false))) await sleep(10);
console.log('before user breakpoint');
// biome-ignore lint/suspicious/noDebugger: The external client must own and resume this breakpoint.
debugger;
console.log('after user breakpoint');
await sleep(100);
function holdAfterUserBreakpoint() {
  const end = performance.now() + 600;
  while (performance.now() < end) {}
}
holdAfterUserBreakpoint();
await sleep(300);
markEventLoopShutdown();
await sleep(100);
console.log('monitor finished');
