# Source with H=<home dir>. Sets a throwaway HOME for Atomic and the toolchains.
export RP=/fast/tmp/resume-perf
export ATOMIC_CLI="node /fast/github_work/atomic-wt/resume-perf/packages/coding-agent/dist/cli.js"
export HOME=$H
export RUSTUP_HOME=/home/azureuser/.rustup
export PATH=/home/azureuser/.cache/.bun/bin:/fast/home/.local/share/fnm/node-versions/v24.22.0/installation/bin:/home/azureuser/.cargo/bin:/home/azureuser/.local/bin:$H/.local/bin:/usr/local/bin:/usr/bin:/bin
export GIT_CONFIG_NOSYSTEM=1
unset ATOMIC_TIMING
mkdir -p $H/.atomic/agent
[ -f $H/.gitconfig ] || printf '[user]\n\tname = Bench\n\temail = bench@localhost\n[init]\n\tdefaultBranch = main\n' > $H/.gitconfig
[ -f $H/.atomic/agent/models.json ] || cat > $H/.atomic/agent/models.json <<J
{"providers":{"mock":{"baseUrl":"http://127.0.0.1:18555/v1","api":"openai-completions","apiKey":"mock","models":[{"id":"mock-1"}]}}}
J
[ -f $H/.atomic/agent/settings.json ] || cat > $H/.atomic/agent/settings.json <<J
{"defaultProvider":"mock","defaultModel":"mock-1","defaultProjectTrust":"always","quietStartup":true}
J
# Package-manager stores: S selects a store set (cold = new dir, warm = reused dir)
if [ -n "$S" ]; then
  mkdir -p $S
  export npm_config_cache=$S/npm XDG_DATA_HOME=$S/xdg-data XDG_CACHE_HOME=$S/xdg-cache CARGO_HOME=$S/cargo
  export npm_config_update_notifier=false
fi
