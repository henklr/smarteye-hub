"""Operator tool: inspect the DVR index + filesystem state.

Run inside the api container:
    docker compose exec api python tests/dvr_validate.py
    docker compose exec api python tests/dvr_validate.py --device cam1 --scan

Prints, per device:
  - where the base dir resolves to (NVMe vs fallback)
  - number of .ts files on disk vs rows in SQLite
  - any orphans (rows with no file / files with no row)
  - the earliest and latest indexed segment
  - total recorded duration & size

`--scan` forces a reconcile pass before reporting.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_DIR = ROOT / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

import playback  # noqa: E402


def _human_bytes(n: int) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(n) < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} PiB"


def _human_seconds(s: float) -> str:
    s = int(s)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h:d}h{m:02d}m{sec:02d}s"


def report_device(device_id: str, do_scan: bool) -> int:
    print(f"\n== device: {device_id} ==")
    device_dir = playback._device_recordings_dir(device_id)
    disk_files = sorted(p.name for p in device_dir.iterdir() if p.is_file() and p.suffix == ".ts")
    print(f"  recordings dir: {device_dir}")
    print(f"  files on disk:  {len(disk_files)}")

    if do_scan:
        print("  scanning...")
        result = playback.reconcile_device_index(device_id)
        print(f"  reconcile:      +{result['added']} ~{result['updated']} -{result['removed']} skip={result['corrupt']}")

    segments = playback._index_all(device_id)
    print(f"  indexed rows:   {len(segments)}")

    indexed_names = {s.filename for s in segments}
    disk_names = set(disk_files)
    orphan_rows = indexed_names - disk_names
    orphan_files = disk_names - indexed_names
    if orphan_rows:
        print(f"  orphan rows:    {len(orphan_rows)} (first 5: {sorted(list(orphan_rows))[:5]})")
    if orphan_files:
        print(f"  orphan files:   {len(orphan_files)} (first 5: {sorted(list(orphan_files))[:5]})")

    if segments:
        total_secs = sum(s.duration_seconds for s in segments)
        total_bytes = sum(s.size_bytes for s in segments)
        print(f"  earliest:       {segments[0].started_at.isoformat()}")
        print(f"  latest:         {segments[-1].ended_at.isoformat()}")
        print(f"  total duration: {_human_seconds(total_secs)}")
        print(f"  total bytes:    {_human_bytes(total_bytes)}")
        finalized = sum(1 for s in segments if s.finalized)
        print(f"  finalized:      {finalized}/{len(segments)}")

    return 0 if not orphan_rows and not orphan_files else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", help="Only report this device_id")
    parser.add_argument("--scan", action="store_true", help="Reconcile before reporting")
    args = parser.parse_args()

    print("== DVR status ==")
    print(f"  base dir:       {playback._resolve_base_dir()}")
    print(f"  recordings:     {playback._recordings_root()}")
    print(f"  index dir:      {playback._index_root()}")
    print(f"  segment secs:   {playback.RECORDING_SEGMENT_SECONDS}")

    rec_root = playback._recordings_root()
    if args.device:
        device_ids = [args.device]
    else:
        device_ids = sorted(
            p.name for p in rec_root.iterdir() if p.is_dir() and playback._SAFE_ID_RE.match(p.name)
        ) if rec_root.exists() else []

    if not device_ids:
        print("\n(no devices with recording dirs)")
        return 0

    exit_code = 0
    for device_id in device_ids:
        try:
            rc = report_device(device_id, args.scan)
            exit_code = exit_code or rc
        except Exception as exc:
            print(f"  ERROR for {device_id}: {exc}")
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
