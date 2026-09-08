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

if [ -z "${TMUX:-}" ]; then
  echo "smoke.sh must run inside tmux (\$TMUX is unset); see the header." >&2
  exit 2
fi
MY_PANE="$TMUX_PANE"
PASS=0; FAIL=0

cli() { "$BUN" run "$CLI" "$@" 2>&1; }

# Polls the registry instead of sleeping blind, so the output also reports
# how long a canvas actually takes to become reachable -- which is the
# window in which a `wait` issued right after `spawn` answers "no canvas".
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

other_pane() { tmux list-panes -F '#{pane_id}' | grep -vx "$MY_PANE" | head -1; }

check() {
  local label=$1 got=$2 want=$3
  if [[ "$got" == *"$want"* ]]; then echo "  PASS  $label"; PASS=$((PASS+1));
  else echo "  FAIL  $label"; echo "        esperaba contener: $want"; echo "        obtuvo:            $got"; FAIL=$((FAIL+1)); fi
}

run_case() {
  local kind=$1 id=$2 cfg=$3 want=$4; shift 4
  echo
  echo "=== $kind ($id) ==="
  local sp; sp=$(cli spawn "$kind" --id "$id" --config "$cfg")
  echo "  spawn -> $sp"
  [[ "$sp" == *'"status":"spawned"'* ]] || { echo "  FAIL  spawn"; FAIL=$((FAIL+1)); return; }
  wait_for_record "$id" || { FAIL=$((FAIL+1)); return; }

  local target; target=$(other_pane)
  echo "  pane: $target"
  echo "  --- lo que el usuario ve en el panel ---"
  tmux capture-pane -p -t "$target" | sed 's/^/  | /' | head -18

  # `wait` must be listening BEFORE the keys arrive: the canvas broadcasts
  # its outcome to whoever is connected at that instant and retains nothing.
  local wf="/tmp/smoke.$id.wait"
  cli wait "$id" --timeout 8 > "$wf" &
  local wpid=$!
  sleep 0.7
  for k in "$@"; do tmux send-keys -t "$target" "$k"; sleep 0.25; done
  wait $wpid
  local got; got=$(cat "$wf")
  echo "  wait  -> $got"
  check "$kind outcome" "$got" "$want"
}

echo "tmux $(tmux -V | awk '{print $2}')  |  bun $("$BUN" --version)"

run_case picker sm-picker \
  '{"title":"Smoke picker","mode":"single","options":[{"id":"alpha","label":"Alpha"},{"id":"beta","label":"Beta"}]}' \
  '{"status":"selected","data":{"selectedIds":["beta"]}}' \
  j Enter

run_case table sm-table \
  '{"title":"Smoke table","columns":[{"key":"a","label":"Col A","width":8},{"key":"b","label":"Col B"}],"rows":[{"a":"one","b":"first"},{"a":"two","b":"second"}]}' \
  '{"status":"cancelled","reason":"escape"}' \
  Escape

run_case form sm-form \
  '{"title":"Smoke form","fields":[{"id":"who","type":"text","label":"Who","required":true},{"id":"ok","type":"checkbox","label":"Confirmed"}]}' \
  '{"status":"selected","data":{"values":{"who":"hi","ok":true}}}' \
  h i Tab Space Tab Enter

run_case diff sm-diff \
  '{"title":"Smoke diff","diffText":"diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n keep\n"}' \
  '{"status":"selected","data":{"decisions":[{"hunkId":"x.txt#0","decision":"approved"}]}}' \
  a Enter

# The regression that retained outcomes exist for: the user chooses with NO
# controller attached, and `wait` only connects afterwards. Before outcomes
# were retained this answered {"status":"error","message":"no canvas
# sm-race"} and the choice was unrecoverable.
echo
echo "=== outcome producido antes de que wait conecte ==="
sp=$(cli spawn picker --id sm-race --config '{"mode":"single","options":[{"id":"alpha","label":"Alpha"}]}')
echo "  spawn -> $sp"
if wait_for_record sm-race; then
  target=$(other_pane)
  tmux send-keys -t "$target" Enter   # user picks with nobody listening
  sleep 1.5
  got=$(cli wait sm-race --timeout 5)
  echo "  wait (despues de la eleccion) -> $got"
  check "outcome retenido" "$got" '{"status":"selected","data":{"selectedIds":["alpha"]}}'
else
  FAIL=$((FAIL+1))
fi

echo
echo "RESULTADO: $PASS pass, $FAIL fail"
[ "$FAIL" -eq 0 ] || exit 1
