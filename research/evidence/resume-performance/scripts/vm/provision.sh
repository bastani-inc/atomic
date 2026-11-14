#!/usr/bin/env bash
# provision.sh: installs the toolchains of a GitHub-hosted Ubuntu runner on a plain Ubuntu 24.04 Azure VM,
# then builds Atomic at ATOMIC_REF and clones the benchmark projects. Run once per VM as azureuser.
set -euxo pipefail
ATOMIC_REF=${ATOMIC_REF:-main}
sudo add-apt-repository -y ppa:git-core/ppa >/dev/null
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git git-lfs build-essential pkg-config libssl-dev \
  python3-yaml curl unzip jq xz-utils sysstat >/dev/null
git lfs install --skip-repo
# Node 24 (the runner image's default major), Bun 1.4.4 (Atomic's pin), Rust stable, uv
curl -fsSL https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz | sudo tar -xJ -C /opt
sudo ln -sf /opt/node-v24.22.0-linux-x64/bin/{node,npm,npx} /usr/local/bin/
curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4 >/dev/null
curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
export PATH=$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.local/bin:$PATH
# Atomic itself, built once: this is the CLI under test, not a benchmark project
mkdir -p ~/bench/src
[ -d ~/atomic-cli ] || git clone -q https://github.com/bastani-inc/atomic.git ~/atomic-cli
cd ~/atomic-cli && git fetch -q origin "$ATOMIC_REF" && git checkout -q --detach FETCH_HEAD
npm ci --ignore-scripts >/dev/null 2>&1 && npm run build >/dev/null 2>&1
# Benchmark projects at the commits of the first measurement round (Atomic at ATOMIC_REF)
clone() { [ -d ~/bench/src/$1 ] || git clone -q https://github.com/$2.git ~/bench/src/$1; git -C ~/bench/src/$1 checkout -q --detach $3; }
clone atomic bastani-inc/atomic "$(git -C ~/atomic-cli rev-parse HEAD)"
clone fastapi fastapi/fastapi 703019198
clone ripgrep BurntSushi/ripgrep 178cc02
git --version; node --version; bun --version; cargo --version; uv --version
