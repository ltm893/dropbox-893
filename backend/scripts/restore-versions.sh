#!/bin/bash
# Restore deleted S3 objects from versioning (removes all delete markers on the key).
#
# Usage:
#   ./scripts/restore-versions.sh <bucket> <file|all>
#
# Examples:
#   ./scripts/restore-versions.sh apps-893-private all
#   ./scripts/restore-versions.sh apps-893-private 0001.jpg
#   ./scripts/restore-versions.sh apps-893-private users/foo/photos/0001.jpg

set -euo pipefail

BUCKET="${1:-}"
SPEC="${2:-}"

if [ -z "$BUCKET" ] || [ -z "$SPEC" ]; then
  echo "Usage: $0 <bucket> <file|all>"
  echo "  file  basename (0001.jpg), full key, or prefix ending in /"
  echo "  all   every object whose latest version is a delete marker"
  exit 1
fi

python3 - "$BUCKET" "$SPEC" << 'PY'
import json, subprocess, sys
from collections import defaultdict

bucket, spec = sys.argv[1], sys.argv[2]
want_all = spec.lower() == "all"

def aws_json(args):
    out = subprocess.check_output(["aws", "s3api", *args], text=True)
    return json.loads(out or "{}")

def list_delete_markers():
    key_marker = None
    version_id_marker = None
    prefix = None if want_all or "/" not in spec else spec
    while True:
        args = ["list-object-versions", "--bucket", bucket, "--output", "json"]
        if prefix:
            args.extend(["--prefix", prefix])
        if key_marker:
            args.extend(["--key-marker", key_marker])
        if version_id_marker:
            args.extend(["--version-id-marker", version_id_marker])
        data = aws_json(args)
        for m in data.get("DeleteMarkers") or []:
            yield m
        if not data.get("IsTruncated"):
            break
        key_marker = data.get("NextKeyMarker")
        version_id_marker = data.get("NextVersionIdMarker")
        if not key_marker:
            break

def matches(key):
    if want_all:
        return True
    if key == spec:
        return True
    if spec.endswith("/") and key.startswith(spec):
        return True
    base = key.rsplit("/", 1)[-1]
    return base == spec

from collections import defaultdict

by_key = defaultdict(list)
latest_deleted = set()
for m in list_delete_markers():
    key = m.get("Key")
    if not key or not matches(key):
        continue
    by_key[key].append(m["VersionId"])
    if m.get("IsLatest"):
        latest_deleted.add(key)

if not latest_deleted:
    print(f"No latest delete markers matched in s3://{bucket} for {spec!r}")
    sys.exit(0)

print(f"Restoring {len(latest_deleted)} object(s) in s3://{bucket}")
ok = 0
for key in sorted(latest_deleted):
    for vid in by_key[key]:
        subprocess.check_call([
            "aws", "s3api", "delete-object",
            "--bucket", bucket,
            "--key", key,
            "--version-id", vid,
        ], stdout=subprocess.DEVNULL)
    n = len(by_key[key])
    extra = f" ({n} delete markers)" if n > 1 else ""
    print(f"  restored  {key}{extra}")
    ok += 1
print(f"Done. Restored {ok}.")
PY
