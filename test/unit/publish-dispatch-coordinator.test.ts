import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function executable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

test("ambiguous dispatch acceptance retains the lock without redispatching", async () => {
  if (process.platform === "win32") return;

  const root = mkdtempSync(join(tmpdir(), "atomic-publish-dispatch-"));
  const bin = join(root, "bin");
  await Bun.$`mkdir -p ${bin}`.quiet();
  try {
    executable(join(bin, "gh"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "api" ]]; then
  if [[ -f "$STATE/accepted" ]]; then
    post=$(cat "$STATE/post" 2>/dev/null || echo 0)
    post=$((post + 1)); echo "$post" > "$STATE/post"
    if [[ "$post" -ge 2 ]]; then
      echo '[{"workflow_runs":[{"path":".github/workflows/publish.yml","head_branch":"main","event":"workflow_dispatch","display_title":"Publish 1.2.3"}]}]'
      exit 0
    fi
  fi
  echo '[{"workflow_runs":[]}]'
  exit 0
fi
count=$(cat "$STATE/dispatches" 2>/dev/null || echo 0)
echo $((count + 1)) > "$STATE/dispatches"
touch "$STATE/accepted"
exit 1
`);
    executable(join(bin, "jq"), `#!/usr/bin/env bash
input=$(cat)
if [[ "$input" == *'"display_title":"Publish 1.2.3"'* ]]; then echo 1; else echo 0; fi
`);
    executable(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");

    const yaml = readFileSync(".github/workflows/publish-dispatch.yml", "utf8");
    const marker = "              run: |\n";
    const block = yaml.slice(yaml.indexOf(marker) + marker.length);
    const script = block.split("\n").map((line) => line.startsWith("                  ") ? line.slice(18) : line).join("\n");
    const processResult = Bun.spawn(["bash", "-c", script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        STATE: root,
        GITHUB_REPOSITORY: "bastani-inc/atomic",
        RELEASE_TAG: "1.2.3",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processResult.exited,
      new Response(processResult.stderr).text(),
    ]);

    assert.equal(exitCode, 0);
    assert.equal(readFileSync(join(root, "dispatches"), "utf8").trim(), "1");
    assert.equal(readFileSync(join(root, "post"), "utf8").trim(), "2");
    assert.match(stderr, /acceptance is ambiguous/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
