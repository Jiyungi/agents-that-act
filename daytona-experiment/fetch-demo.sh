#!/usr/bin/env bash
# PackGuard — safe "inspect without installing" fetch, run INSIDE a Daytona sandbox.
# Downloads an npm package tarball via the registry API and untars it.
# It NEVER runs `npm install` and NEVER executes package code.
#
# Usage (inside the sandbox):   bash fetch-demo.sh <package-name>
# Example:                      bash fetch-demo.sh left-pad

set -euo pipefail

PKG="${1:-left-pad}"
DEST="/home/daytona/scan-target"

echo "=== PackGuard sandbox fetch demo: ${PKG} ==="
rm -rf "${DEST}/package"
mkdir -p "${DEST}"

URL="$(npm view "${PKG}" dist.tarball)"
echo "TARBALL=${URL}"

curl -sL "${URL}" -o /tmp/pkg.tgz
echo "downloaded bytes: $(wc -c < /tmp/pkg.tgz)"

# Extract into the isolated scan-target dir (package lands under ./package/).
tar -xzf /tmp/pkg.tgz -C "${DEST}"

echo "--- extracted files ---"
find "${DEST}/package" -type f
echo "=== done (no npm install, no code executed) ==="
