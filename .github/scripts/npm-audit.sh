#!/usr/bin/env bash
# npm audit for CI (SEC-382, SEC-386).
#
# Exit 0 only when the advisory service answered and reported no vulnerability. A confirmed
# vulnerability fails with the human-readable report. An advisory-service outage also fails, after
# retries, but is reported as exactly that: vulnerabilities were not assessed, which is neither a
# clean result nor a finding. Nothing here prints a credential or a protected value.
set -euo pipefail

attempts="${NPM_AUDIT_ATTEMPTS:-3}"
report="$(mktemp)"
trap 'rm -f "$report"' EXIT

summarise() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

# Prints the vulnerability total when the report is a real audit result; prints nothing otherwise.
vulnerability_total() {
  node -e '
    const fs = require("node:fs");
    let doc;
    try { doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
    const v = doc && doc.metadata && doc.metadata.vulnerabilities;
    if (v && Number.isInteger(v.total)) console.log(v.total);
  ' "$1"
}

for attempt in $(seq 1 "$attempts"); do
  set +e
  npm audit --json --audit-level=low --fetch-timeout=60000 --fetch-retries=1 > "$report" 2>/dev/null
  status=$?
  set -e
  total="$(vulnerability_total "$report")"
  if [[ "$total" == "0" && "$status" -eq 0 ]]; then
    echo "npm audit: advisory service reachable, 0 vulnerabilities."
    summarise "**npm audit**: 0 vulnerabilities (advisory service reachable)."
    exit 0
  fi
  if [[ -n "$total" && "$total" != "0" ]]; then
    echo "::error title=npm audit::Confirmed vulnerabilities: ${total}. Report follows; the SEC-386 patch window applies."
    summarise "**npm audit**: ${total} confirmed vulnerabilities. See the job log."
    npm audit --audit-level=low || true
    exit 1
  fi
  echo "npm audit attempt ${attempt} of ${attempts}: the advisory service did not answer (npm exit ${status})."
  if [[ "$attempt" -lt "$attempts" ]]; then
    sleep $((attempt * 15))
  fi
done

echo "::error title=npm audit::Advisory service unreachable after ${attempts} attempts. Vulnerabilities were NOT assessed in this run. This is a service outage, not a vulnerability finding: re-run this job."
summarise "**npm audit**: NOT assessed. The advisory service was unreachable after ${attempts} attempts (outage, not a finding). Re-run the job."
exit 1
