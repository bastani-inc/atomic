import { test } from "bun:test";
import assert from "node:assert/strict";

interface ChoiceInput {
  default: string;
  options: string[];
  required: boolean;
  type: string;
}

interface Step {
  uses?: string;
  with?: { ref?: string };
}

interface MatrixEntry {
  platform: string;
  runner: string;
  target: string;
}

interface PublishWorkflow {
  on: {
    workflow_dispatch: {
      inputs: Record<string, ChoiceInput>;
    };
  };
  jobs: {
    "linux-binary-smoke": { "runs-on": string; steps: Step[] };
    "windows-binary-smoke": { "runs-on": string; steps: Step[] };
    "atomic-native-artifacts": {
      "runs-on": string;
      steps: Step[];
      strategy: { matrix: { include: MatrixEntry[] } };
    };
    publish: { "runs-on": string; steps: Step[] };
  };
}

const workflowPath = new URL("../../.github/workflows/publish.yml", import.meta.url);
const docsPath = new URL("../../docs/ci.md", import.meta.url);

async function loadWorkflow(): Promise<PublishWorkflow> {
  return Bun.YAML.parse(await Bun.file(workflowPath).text()) as PublishWorkflow;
}

const providerExpression = (github: string, blacksmith: string): string =>
  `\${{ inputs.runner_provider == 'github' && '${github}' || '${blacksmith}' }}`;

test("publish workflow exposes one Blacksmith-default provider choice", async () => {
  const inputs = (await loadWorkflow()).on.workflow_dispatch.inputs;

  assert.deepEqual(Object.keys(inputs).sort(), ["runner_provider", "tag"]);
  assert.deepEqual(inputs.runner_provider, {
    description: "Runner provider for Blacksmith-backed jobs",
    required: true,
    default: "blacksmith",
    type: "choice",
    options: ["blacksmith", "github"],
  });
  assert.equal("windows_runner" in inputs, false);
});

test("smoke jobs retain Blacksmith for tag pushes and map manual GitHub fallback by architecture", async () => {
  const jobs = (await loadWorkflow()).jobs;

  assert.equal(
    jobs["linux-binary-smoke"]["runs-on"],
    providerExpression("ubuntu-24.04", "blacksmith-4vcpu-ubuntu-2404"),
  );
  assert.equal(
    jobs["windows-binary-smoke"]["runs-on"],
    providerExpression("windows-2025", "blacksmith-4vcpu-windows-2025"),
  );
});

test("every native matrix entry preserves its architecture across providers", async () => {
  const workflow = await loadWorkflow();
  const entries = Object.fromEntries(
    workflow.jobs["atomic-native-artifacts"].strategy.matrix.include.map((entry) => [entry.platform, entry]),
  );

  assert.deepEqual(entries, {
    "linux-x64": {
      runner: providerExpression("ubuntu-24.04", "blacksmith-4vcpu-ubuntu-2404"),
      platform: "linux-x64",
      target: "",
    },
    "linux-arm64": {
      runner: providerExpression("ubuntu-24.04-arm", "blacksmith-4vcpu-ubuntu-2404-arm"),
      platform: "linux-arm64",
      target: "",
    },
    "darwin-x64": { runner: "macos-26-intel", platform: "darwin-x64", target: "" },
    "darwin-arm64": {
      runner: providerExpression("macos-26", "blacksmith-6vcpu-macos-26"),
      platform: "darwin-arm64",
      target: "",
    },
    "windows-x64": {
      runner: providerExpression("ubuntu-24.04", "blacksmith-4vcpu-ubuntu-2404"),
      platform: "windows-x64",
      target: "x86_64-pc-windows-msvc",
    },
    "windows-arm64": {
      runner: providerExpression("ubuntu-24.04", "blacksmith-4vcpu-ubuntu-2404"),
      platform: "windows-arm64",
      target: "aarch64-pc-windows-msvc",
    },
  });
  assert.equal(workflow.jobs["atomic-native-artifacts"]["runs-on"], "${{ matrix.runner }}");
});

test("all jobs use provider-portable checkout while GitHub-required jobs stay unchanged", async () => {
  const jobs = (await loadWorkflow()).jobs;

  for (const name of ["linux-binary-smoke", "windows-binary-smoke", "atomic-native-artifacts", "publish"] as const) {
    const checkout = jobs[name].steps.find((step) => step.uses?.includes("checkout"));
    assert.equal(checkout?.uses, "actions/checkout@v7.0.0", `${name} checkout`);
  }
  assert.equal(jobs.publish["runs-on"], "ubuntu-latest");
});

test("CI docs record exact provider dispatches, labels, exception, and cancellation guidance", async () => {
  const docs = await Bun.file(docsPath).text();

  assert.match(docs, /-f tag=0\.9\.7-alpha\.1 -f runner_provider=blacksmith/u);
  assert.match(docs, /-f tag=0\.9\.7-alpha\.1 -f runner_provider=github/u);
  for (const label of ["ubuntu-24.04", "ubuntu-24.04-arm", "windows-2025", "macos-26", "macos-26-intel"]) {
    assert.match(docs, new RegExp(`\\b${label}\\b`, "u"));
  }
  assert.match(docs, /macos-26-intel.*unchanged/u);
  assert.match(docs, /different concurrency keys.*start concurrently/u);
  assert.match(docs, /first cancel the stuck run.*wait until it is terminal/u);
});
