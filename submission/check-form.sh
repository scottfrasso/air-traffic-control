#!/usr/bin/env bash
# Prints character counts of the drafted form answers against the form's maxlength limits.
set -euo pipefail
f="$(dirname "$0")/FORM_DRAFT.md"
for spec in vision:2000 cloudflare:2000 instructions:4000; do
  name=${spec%%:*}; max=${spec##*:}
  n=$(awk "/<!-- $name:start -->/{f=1;next}/<!-- $name:end -->/{f=0}f" "$f" | python3 -I -c 'import sys;print(len(sys.stdin.read().strip()))')
  status=OK; [ "$n" -le "$max" ] || status=OVER
  printf '%-13s %5d / %5d  %s\n' "$name" "$n" "$max" "$status"
done
