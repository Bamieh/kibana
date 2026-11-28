#!/usr/bin/env bash
set -euo pipefail

MANIFEST="/bench/migrator-manifest.json"
CONFIG_DIR="/bench/config"
FALLBACK="/bench/scripts/mock_kibana_fallback.sh"
RUST_BIN="/usr/local/bin/kibana-migrator-rs"
NODE_SCRIPT="/bench/scripts/node_fast_path.mjs"
ES_PORT=19200
ITERATIONS="${BENCH_ITERATIONS:-30}"

echo "=== ENVIRONMENT ==="
uname -a
echo "Node version: $(node -v)"
echo "Rust binary size: $(stat -c%s "$RUST_BIN") bytes ($(ls -lh "$RUST_BIN" | awk '{print $5}'))"
echo "Manifest size: $(stat -c%s "$MANIFEST") bytes ($(ls -lh "$MANIFEST" | awk '{print $5}'))"
echo "Manifest summary: $(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const total=Object.values(m.indices).reduce((a,b)=>a+b.length,0); console.log(Object.keys(m.indices).length+" indices, "+total+" SO types, "+m.removed_types.length+" removed types");' "$MANIFEST")"
echo "OpenSSL linkage:"
ldd "$RUST_BIN" | grep -E 'ssl|crypto' || true

start_es() {
  local mode="$1"
  local latency="${2:-2}"
  local warmup="${3:-2000}"
  node /bench/scripts/mock_es_server.mjs "$MANIFEST" "$mode" "$ES_PORT" "$latency" "$warmup" >/tmp/mock_es.log 2>&1 &
  ES_PID=$!
  for _ in $(seq 1 50); do
    if grep -q "MOCK_ES_READY" /tmp/mock_es.log 2>/dev/null; then
      return 0
    fi
    sleep 0.05
  done
  echo "Mock ES failed to start:"
  cat /tmp/mock_es.log
  exit 1
}

stop_es() {
  if [[ -n "${ES_PID:-}" ]]; then
    kill "$ES_PID" 2>/dev/null || true
    wait "$ES_PID" 2>/dev/null || true
    unset ES_PID
  fi
}

trap stop_es EXIT

echo ""
echo "=== FUNCTIONAL VERIFICATION (ALL 5 SCENARIOS) ==="

echo "[1/5] Warm ES no-op fast-path (Rust):"
start_es noop 2
"$RUST_BIN" --manifest "$MANIFEST" --config-dir "$CONFIG_DIR" --kibana-bin "$FALLBACK"
stop_es

echo "[2/5] Rollback (lesser) fast-path without alias mutation (Rust):"
start_es rollback 2
"$RUST_BIN" --manifest "$MANIFEST" --config-dir "$CONFIG_DIR" --kibana-bin "$FALLBACK"
stop_es

echo "[3/5] ModelVersion bump -> execvp fallback PID preservation (Rust):"
start_es bump 2
set +e
OUT=$(bash -c 'echo "CALLER_PID=$$"; exec "$@"' _ "$RUST_BIN" --manifest "$MANIFEST" --config-dir "$CONFIG_DIR" --kibana-bin "$FALLBACK" --node.roles=migrator --extra-flag=1)
RC=$?
set -e
echo "$OUT"
echo "Fallback exit code=$RC (expected 42)"
[[ "$RC" -eq 42 ]] || { echo "FAIL: expected exit 42"; exit 1; }
CALLER_PID=$(echo "$OUT" | grep "CALLER_PID=" | cut -d= -f2)
FALLBACK_PID=$(echo "$OUT" | grep "FALLBACK_EXEC_INVOKED" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')
echo "PID check: caller=$CALLER_PID fallback=$FALLBACK_PID"
[[ "$CALLER_PID" == "$FALLBACK_PID" ]] || { echo "FAIL: PID changed (execvp did not replace process)"; exit 1; }
stop_es

echo "[4/5] Unknown _meta key -> fail-closed execvp fallback (Rust):"
start_es unknown_meta 2
set +e
OUT=$("$RUST_BIN" --manifest "$MANIFEST" --config-dir "$CONFIG_DIR" --kibana-bin "$FALLBACK")
RC=$?
set -e
echo "$OUT"
[[ "$RC" -eq 42 ]] || { echo "FAIL: expected fail-closed fallback (exit 42), got $RC"; exit 1; }
echo "$OUT" | grep -q "unknown_meta_mapping_type" || { echo "FAIL: missing unknown_meta_mapping_type reason"; exit 1; }
stop_es

echo "[5/5] Missing index -> fail-closed execvp fallback (Rust):"
start_es missing_index 2
set +e
OUT=$("$RUST_BIN" --manifest "$MANIFEST" --config-dir "$CONFIG_DIR" --kibana-bin "$FALLBACK")
RC=$?
set -e
echo "$OUT"
[[ "$RC" -eq 42 ]] || { echo "FAIL: expected missing_index fallback (exit 42), got $RC"; exit 1; }
echo "$OUT" | grep -q "missing_index:.kibana_ingest" || { echo "FAIL: missing missing_index reason"; exit 1; }
stop_es

echo ""
echo "=== BENCHMARK 1: WARM ES NO-OP ($ITERATIONS RUNS EACH, 2ms ES RTT) ==="
start_es noop 2

measure_series() {
  local label="$1"
  shift
  local wall_file="/tmp/${label}_wall.txt"
  local cpu_file="/tmp/${label}_cpu.txt"
  local rss_file="/tmp/${label}_rss.txt"
  : > "$wall_file"; : > "$cpu_file"; : > "$rss_file"

  # 2 warmup runs
  for _ in 1 2; do "$@" >/dev/null 2>&1; done

  for _ in $(seq 1 "$ITERATIONS"); do
    local t0 t1
    t0=$(date +%s%N)
    /usr/bin/time -v "$@" >/dev/null 2>/tmp/time_out.txt
    t1=$(date +%s%N)
    local wall_ms
    wall_ms=$(node -e "console.log(((BigInt('$t1') - BigInt('$t0')) / 100000n) / 10n)" 2>/dev/null || echo "0")
    # exact floating wall_ms
    wall_ms=$(node -e "console.log((Number(BigInt('$t1') - BigInt('$t0')) / 1e6).toFixed(2))")
    local user_s sys_s rss_kb cpu_ms rss_mb
    user_s=$(awk -F': ' '/User time/ {print $2}' /tmp/time_out.txt)
    sys_s=$(awk -F': ' '/System time/ {print $2}' /tmp/time_out.txt)
    rss_kb=$(awk -F': ' '/Maximum resident set size/ {print $2}' /tmp/time_out.txt)
    cpu_ms=$(node -e "console.log(((Number('$user_s') + Number('$sys_s')) * 1000).toFixed(2))")
    rss_mb=$(node -e "console.log((Number('$rss_kb') / 1024).toFixed(2))")
    echo "$wall_ms" >> "$wall_file"
    echo "$cpu_ms" >> "$cpu_file"
    echo "$rss_mb" >> "$rss_file"
  done

  node - "$label" "$wall_file" "$cpu_file" "$rss_file" <<'JS'
const fs = require('fs');
const [label, wf, cf, rf] = process.argv.slice(2);
const read = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(Number).sort((a, b) => a - b);
const stats = (arr) => {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const p50 = arr[Math.floor(arr.length * 0.5)];
  const p95 = arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))];
  return { min: arr[0], p50, p95, max: arr[arr.length - 1], mean: Number(mean.toFixed(2)) };
};
console.log(JSON.stringify({ label, n: read(wf).length, wall_ms: stats(read(wf)), cpu_ms: stats(read(cf)), max_rss_mib: stats(read(rf)) }));
JS
}

measure_series "rust_fast_noop" "$RUST_BIN" --manifest "$MANIFEST" --config-dir "$CONFIG_DIR" --kibana-bin "$FALLBACK"
measure_series "node24_fast_noop" node "$NODE_SCRIPT" --manifest "$MANIFEST" --config-dir "$CONFIG_DIR" --kibana-bin "$FALLBACK"
stop_es

echo ""
echo "=== BENCHMARK 2: COLD ES WARMUP (2000ms ES 503 INITIALIZING BEFORE 200) ==="
for contender in rust node24; do
  start_es cold_warmup 2 2000
  t0=$(date +%s%N)
  if [[ "$contender" == "rust" ]]; then
    /usr/bin/time -v "$RUST_BIN" --manifest "$MANIFEST" --config-dir "$CONFIG_DIR" --kibana-bin "$FALLBACK" >/dev/null 2>/tmp/time_out.txt
  else
    /usr/bin/time -v node "$NODE_SCRIPT" --manifest "$MANIFEST" --config-dir "$CONFIG_DIR" --kibana-bin "$FALLBACK" >/dev/null 2>/tmp/time_out.txt
  fi
  t1=$(date +%s%N)
  wall_ms=$(node -e "console.log((Number(BigInt('$t1') - BigInt('$t0')) / 1e6).toFixed(2))")
  user_s=$(awk -F': ' '/User time/ {print $2}' /tmp/time_out.txt)
  sys_s=$(awk -F': ' '/System time/ {print $2}' /tmp/time_out.txt)
  rss_kb=$(awk -F': ' '/Maximum resident set size/ {print $2}' /tmp/time_out.txt)
  cpu_ms=$(node -e "console.log(((Number('$user_s') + Number('$sys_s')) * 1000).toFixed(2))")
  rss_mb=$(node -e "console.log((Number('$rss_kb') / 1024).toFixed(2))")
  echo "{\"label\":\"${contender}_cold_es_2s\",\"wall_ms\":${wall_ms},\"cpu_ms\":${cpu_ms},\"max_rss_mib\":${rss_mb}}"
  stop_es
done

echo ""
echo "=== BENCHMARK 3: FALLBACK HANDOFF OVERHEAD (10 RUNS, MODEL VERSION BUMP) ==="
start_es bump 2
wf="/tmp/fb_wall.txt"; cf="/tmp/fb_cpu.txt"; rf="/tmp/fb_rss.txt"
: > "$wf"; : > "$cf"; : > "$rf"
for _ in $(seq 1 10); do
  t0=$(date +%s%N)
  set +e
  /usr/bin/time -v "$RUST_BIN" --manifest "$MANIFEST" --config-dir "$CONFIG_DIR" --kibana-bin "$FALLBACK" >/dev/null 2>/tmp/time_out.txt
  RC=$?
  set -e
  t1=$(date +%s%N)
  [[ "$RC" -eq 42 ]] || { echo "FAIL fallback benchmark rc=$RC"; exit 1; }
  node -e "console.log((Number(BigInt('$t1') - BigInt('$t0')) / 1e6).toFixed(2))" >> "$wf"
  user_s=$(awk -F': ' '/User time/ {print $2}' /tmp/time_out.txt)
  sys_s=$(awk -F': ' '/System time/ {print $2}' /tmp/time_out.txt)
  rss_kb=$(awk -F': ' '/Maximum resident set size/ {print $2}' /tmp/time_out.txt)
  node -e "console.log(((Number('$user_s') + Number('$sys_s')) * 1000).toFixed(2))" >> "$cf"
  node -e "console.log((Number('$rss_kb') / 1024).toFixed(2))" >> "$rf"
done
node - "rust_fallback_overhead" "$wf" "$cf" "$rf" <<'JS'
const fs = require('fs');
const [label, wf, cf, rf] = process.argv.slice(2);
const read = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(Number).sort((a, b) => a - b);
const stats = (arr) => ({ min: arr[0], p50: arr[Math.floor(arr.length * 0.5)], max: arr[arr.length - 1], mean: Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) });
console.log(JSON.stringify({ label, n: read(wf).length, wall_ms: stats(read(wf)), cpu_ms: stats(read(cf)), max_rss_mib: stats(read(rf)) }));
JS
stop_es
