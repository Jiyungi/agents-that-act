cd /home/daytona/scan-target || exit 1
echo "=== report files in scan-target ==="
ls -la *.json 2>/dev/null
echo "=== validation ==="
for r in gitleaks-report.json npm-audit.json grype-report.json semgrep-report.json checkov-report.json hadolint-report.json package-leakage-report.json; do
  if [ -s "$r" ]; then
    echo "OK: $r ($(wc -c < "$r") bytes)"
  elif [ -f "$r" ]; then
    echo "EMPTY: $r"
  else
    echo "MISSING: $r"
  fi
done
echo "=== gitleaks (secrets) findings count ==="
if [ -s gitleaks-report.json ]; then cat gitleaks-report.json | (jq 'length' 2>/dev/null || echo "raw:"; head -c 300 gitleaks-report.json); fi
echo ""
echo "=== semgrep findings count ==="
if [ -s semgrep-report.json ]; then jq '.results | length' semgrep-report.json 2>/dev/null || echo "could not parse"; fi
echo "=== npm audit summary ==="
if [ -s npm-audit.json ]; then jq '.metadata.vulnerabilities' npm-audit.json 2>/dev/null || head -c 300 npm-audit.json; fi
