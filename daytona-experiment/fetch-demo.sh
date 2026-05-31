echo "=== PackGuard sandbox fetch demo ==="
set -e
rm -rf /home/daytona/scan-target
mkdir -p /home/daytona/scan-target
cd /tmp
url=$(npm view left-pad dist.tarball)
echo "TARBALL=$url"
curl -sL "$url" -o pkg.tgz
echo "downloaded bytes:"
wc -c < pkg.tgz
tar -xzf pkg.tgz -C /home/daytona/scan-target
echo "--- extracted files ---"
find /home/daytona/scan-target -type f
echo "=== done (no npm install, no code executed) ==="
