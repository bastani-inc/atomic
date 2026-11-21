import { Script } from 'node:vm';
import { setTimeout as sleep } from 'node:timers/promises';
import { startEventLoopMonitor, waitForEventLoopMonitorReady, markEventLoopShutdown } from '../../packages/coding-agent/src/core/event-loop-monitor.ts';

startEventLoopMonitor('engine');
await waitForEventLoopMonitorReady();
const until = performance.now() + Number(process.argv[2]);
let scripts = 0;
while (performance.now() < until) {
  for (let i = 0; i < 100; i++) {
    const script = new Script('1 + 1', { filename: `temporary-profile-script-${scripts++}-${'x'.repeat(4096)}` });
    script.runInThisContext();
  }
  await sleep(50);
  global.gc();
}
markEventLoopShutdown();
await sleep(100);
global.gc();
await sleep(100);
global.gc();
await sleep(100);
console.log(JSON.stringify({ scripts, ...globalThis.profileLifetimeReport() }));
