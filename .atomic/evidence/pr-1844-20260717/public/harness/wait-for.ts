const [timeoutText, channel] = process.argv.slice(2);
const timeoutSeconds = Number(timeoutText);
if (!channel || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error("usage: bun wait-for.ts TIMEOUT_SECONDS CHANNEL");
  process.exit(2);
}

const child = Bun.spawn(["tmux", "wait-for", channel], {
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill();
}, timeoutSeconds * 1000);
const exitCode = await child.exited;
clearTimeout(timer);
if (timedOut) {
  console.error(`timed out waiting for tmux channel: ${channel}`);
  process.exit(124);
}
process.exit(exitCode);
