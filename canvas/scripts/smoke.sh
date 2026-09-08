#!/bin/bash
#
# End-to-end smoke test. Everything else in this repository tests the IPC
# layer with no terminal at all -- which is what the TCP transport was
# chosen to make possible -- so this is the only thing that exercises the
# pane-opening path: a real tmux split, a real Ink render inside it, real
# keystrokes, and the outcome read back through the CLI's own `wait`.
#
# Must be run from inside a tmux session, since `spawn` needs $TMUX:
#
#   tmux new-session -d -s smoke -x 120 -y 34 \
#     "bash canvas/scripts/smoke.sh > /tmp/smoke.log 2>&1; tmux wait-for -S done"
#   tmux wait-for done && cat /tmp/smoke.log
#
# Exits non-zero if any case fails.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
CLI="$REPO/canvas/src/cli.ts"
MY_PANE="${TMUX_PANE:-}"
PASS=0
FAIL=0

if [ -z "${TMUX:-}" ]; then
  echo "smoke.sh must run inside tmux (\$TMUX is unset); see the header." >&2
  exit 2
fi

cli() { "$BUN" run "$CLI" "$@" 2>&1; }

panes() { tmux list-panes -F '#{pane_id}' | grep -vx "$MY_PANE" | sort; }

# Polls the registry instead of sleeping blind, so the output also reports
# how long a canvas takes to become reachable. `spawn` now waits for this
# itself, so a slow start shows up as a slow spawn rather than a later
# "no canvas <id>".
wait_for_record() {
  local id=$1 start=$SECONDS
  for _ in $(seq 1 100); do
    if cli list | grep -q "\"$id\""; then
      echo "      record visible after $((SECONDS - start))s"
      return 0
    fi
    sleep 0.1
  done
  echo "      RECORD NEVER APPEARED"
  return 1
}

check() {
  local label=$1 got=$2 want=$3
  if [[ "$got" == *"$want"* ]]; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label"
    echo "        esperaba contener: $want"
    echo "        obtuvo:            $got"
    FAIL=$((FAIL + 1))
  fi
}

# Spawns and reports the id of the pane that appeared, by diffing the pane
# list. Taking the first or last pane instead was wrong: a canvas with a
# confirmation countdown (the meeting picker's) outlives its own `wait`, so
# a stale pane can still be listed when the next case spawns, and keystrokes
# would go to the wrong canvas.
spawn_pane() {
  local before after
  before=$(panes)
  local out
  out=$(cli spawn "$@")
  # To stderr on purpose: this function's STDOUT is the pane id and nothing
  # else, because callers capture it with $(...). An informational line here
  # would be captured along with the id and every send-keys would miss.
  echo "  spawn -> $out" >&2
  [[ "$out" == *'"status":"spawned"'* ]] || return 1
  after=$(panes)
  comm -13 <(echo "$before") <(echo "$after") | head -1
}

send_keys() {
  local target=$1
  shift
  for k in "$@"; do
    tmux send-keys -t "$target" "$k"
    sleep 0.25
  done
}

run_case() {
  local kind=$1 id=$2 scenario=$3 cfg=$4 want=$5
  shift 5
  echo
  echo "=== $kind ($id, --scenario $scenario) ==="
  local target
  target=$(spawn_pane "$kind" --id "$id" --scenario "$scenario" --config "$cfg") || {
    FAIL=$((FAIL + 1))
    return
  }
  wait_for_record "$id" || {
    FAIL=$((FAIL + 1))
    return
  }
  echo "  pane: $target"
  echo "  --- lo que el usuario ve en el panel ---"
  tmux capture-pane -p -t "$target" | sed 's/^/  | /' | head -14

  # `wait` is started before the keys are sent, which is the ordering the
  # canvas skill recommends -- though retained outcomes mean it no longer
  # has to be. The "outcome retenido" case below is the proof.
  local wf="/tmp/smoke.$id.wait"
  cli wait "$id" --timeout 10 > "$wf" &
  local wpid=$!
  sleep 0.7
  send_keys "$target" "$@"
  wait $wpid
  local got
  got=$(cat "$wf")
  echo "  wait  -> $got"
  check "$kind outcome" "$got" "$want"
  # The meeting picker confirms for ~3 s before exiting; let its pane go
  # before the next case spawns.
  sleep 3.2
}

echo "tmux $(tmux -V | awk '{print $2}')  |  bun $("$BUN" --version)"

run_case picker sm-picker select \
  '{"title":"Smoke picker","mode":"single","options":[{"id":"alpha","label":"Alpha"},{"id":"beta","label":"Beta"}]}' \
  '{"status":"selected","data":{"selectedIds":["beta"]}}' \
  j Enter

run_case table sm-table display \
  '{"title":"Smoke table","columns":[{"key":"a","label":"Col A","width":8},{"key":"b","label":"Col B"}],"rows":[{"a":"one","b":"first"},{"a":"two","b":"second"}]}' \
  '{"status":"cancelled","reason":"escape"}' \
  Escape

run_case form sm-form fill \
  '{"title":"Smoke form","fields":[{"id":"who","type":"text","label":"Who","required":true},{"id":"ok","type":"checkbox","label":"Confirmed"}]}' \
  '{"status":"selected","data":{"values":{"who":"hi","ok":true}}}' \
  h i Tab Space Tab Enter

run_case diff sm-diff review \
  '{"title":"Smoke diff","diffText":"diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n keep\n"}' \
  '{"status":"selected","data":{"decisions":[{"hunkId":"x.txt#0","decision":"approved"}]}}' \
  a Enter

run_case calendar sm-mp meeting-picker \
  '{"title":"Smoke week","calendars":[{"name":"Ana","color":"blue","events":[]}],"slotGranularity":30}' \
  '"status":"selected"' \
  Enter

# The dashboard: several primitive views in one pane, which is what Phase 3's
# view/shell split was for. Its outcome carries which region answered, so a
# controller can tell which of several questions was the one answered.
DASH_CFG='{"title":"Smoke dashboard","regions":[{"id":"status","kind":"text","rows":4,"title":"git","config":{"text":"on branch main"}},{"id":"pick","kind":"picker","title":"Next","config":{"mode":"single","options":[{"id":"alpha","label":"Alpha"},{"id":"beta","label":"Beta"}]}}]}'

run_case dashboard sm-dash display "$DASH_CFG" \
  '{"status":"selected","data":{"regionId":"pick","result":{"selectedIds":["beta"]}}}' \
  j Enter

# The calendar's `display` scenario had no IPC server at all until
# 2026-09-08: it wrote no registry record, so `close` answered "no canvas"
# for a pane sitting right there.
echo
echo "=== calendar display (arranca servidor y es cerrable) ==="
if target=$(spawn_pane calendar --id sm-cal --scenario display --config '{"title":"Smoke cal","events":[]}') && wait_for_record sm-cal; then
  check "display aparece en list" "$(cli list)" '"id":"sm-cal"'
  check "display responde a get" "$(cli get sm-cal config)" '"status":"ok"'
  check "display es cerrable" "$(cli close sm-cal)" '{"status":"closing","id":"sm-cal"}'
  sleep 0.6
else
  FAIL=$((FAIL + 3))
fi

# A shape-valid but nonexistent scenario used to pass straight through and
# silently render a different view.
echo
echo "=== escenario invalido se rechaza ==="
check "scenario invalido" \
  "$(cli spawn calendar --id sm-bad --scenario meting-picker)" \
  'Unknown scenario for calendar'

# Live server-push. The `update` message had no CLI verb until 2026-09-08,
# so this path was unreachable end to end despite being the capability the
# roadmap cited when it chose TCP over files-plus-polling.
echo
echo "=== update en vivo (server-push) ==="
if target=$(spawn_pane table --id sm-update --scenario display --config '{"title":"Antes","columns":[{"key":"a","label":"A","width":8}],"rows":[{"a":"antes"}]}') && wait_for_record sm-update; then
  cli update sm-update --config '{"title":"Despues","columns":[{"key":"a","label":"A","width":8}],"rows":[{"a":"despues"}]}' > /dev/null
  sleep 0.8
  pane=$(tmux capture-pane -p -t "$target")
  echo "  --- panel tras el update ---"
  echo "$pane" | sed 's/^/  | /' | head -6
  check "config reemplazada en vivo" "$pane" "despues"
  check "titulo reemplazado en vivo" "$pane" "Despues"
  cli close sm-update > /dev/null
  sleep 0.6
else
  FAIL=$((FAIL + 2))
fi

# The regression retained outcomes exist for: the user chooses with NO
# controller attached, and `wait` only connects afterwards. Before outcomes
# were retained this answered {"status":"error","message":"no canvas
# sm-race"} and the choice was unrecoverable.
echo
echo "=== outcome producido antes de que wait conecte ==="
if target=$(spawn_pane picker --id sm-race --scenario select --config '{"mode":"single","options":[{"id":"alpha","label":"Alpha"}]}') && wait_for_record sm-race; then
  send_keys "$target" Enter
  sleep 1.2
  got=$(cli wait sm-race --timeout 5)
  echo "  wait (despues de la eleccion) -> $got"
  check "outcome retenido" "$got" '{"status":"selected","data":{"selectedIds":["alpha"]}}'
else
  FAIL=$((FAIL + 1))
fi

echo
echo "RESULTADO: $PASS pass, $FAIL fail"
[ "$FAIL" -eq 0 ] || exit 1
