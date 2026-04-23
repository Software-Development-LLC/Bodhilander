#!/usr/bin/env python3
"""
BDHLNDR-38: merge the per-arch latest-mac.yml files produced by the split mac
build jobs into a single latest-mac.yml listing both x64 and arm64 DMGs, so
electron-updater picks the right artifact for the client's arch.

Usage: merge-latest-mac.py <arm64.yml> <x64.yml> <out.yml>
"""
import sys
import yaml

arm64_path, x64_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

with open(arm64_path) as f:
    arm64 = yaml.safe_load(f)
with open(x64_path) as f:
    x64 = yaml.safe_load(f)

merged = dict(arm64)
merged['files'] = arm64['files'] + x64['files']

with open(out_path, 'w') as f:
    yaml.dump(merged, f, default_flow_style=False, sort_keys=False)

print(f"Merged {len(merged['files'])} mac update entries into {out_path}")
