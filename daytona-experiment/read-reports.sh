D=/home/daytona/scan-target
{
echo "== gitleaks (secrets) =="
cat "$D/gitleaks-report.json"
echo ""
echo "== semgrep results count =="
jq '.results | length' "$D/semgrep-report.json" 2>/dev/null
echo "== semgrep rule ids =="
jq -r '.results[].check_id' "$D/semgrep-report.json" 2>/dev/null
echo "== semgrep errors count =="
jq '.errors | length' "$D/semgrep-report.json" 2>/dev/null
echo "== grype matches count =="
jq '.matches | length' "$D/grype-report.json" 2>/dev/null
echo "== checkov =="
cat "$D/checkov-report.json"
echo ""
echo "== semgrep stderr (head) =="
head -3 "$D/semgrep-stderr.txt"
} > /tmp/reports.out 2>&1
