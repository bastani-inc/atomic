# Sourced by the VM drivers: the harness layout on an Azure VM provisioned by provision.sh.
export RP=$HOME/bench ATOMIC_REPO=$HOME/atomic-cli MOCK_PORT=18555
export BENCH_PATH=/home/azureuser/.bun/bin:/usr/local/bin:/home/azureuser/.cargo/bin:/home/azureuser/.local/bin:/usr/bin:/bin
cd $RP
pgrep -f mock-openai.mjs > /dev/null || (setsid nohup node harness/mock-openai.mjs > harness/mock.out 2>&1 < /dev/null &)
sleep 1
if [ ! -d smoke/homeA/.atomic/agent/cache ]; then # one warm extension cache, copied into each HOME of the warm stages
  ( H=$RP/smoke/homeA S=""; source harness/env.sh; for i in 1 2 3; do s=$(date +%s%3N); $ATOMIC_CLI -p hi --no-session < /dev/null > /dev/null 2>&1; echo "start $i in a new HOME ms=$(( $(date +%s%3N)-s ))"; done ) | tee -a results-cold-home-startup.txt
fi
load() { echo "load $(cut -d' ' -f1-3 /proc/loadavg) $1"; }
