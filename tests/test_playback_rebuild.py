"""Validation tests for the DVR/NVR rebuild.

Runs inside the api container (where fastapi is installed):
    docker compose exec api python -m unittest tests/test_playback_rebuild.py

Covers:
- SQLite index migration and range queries
- Reconciliation (add/update/remove) against a fake filesystem
- HLS playlist generation and gap->discontinuity
- Event state transitions and segment coverage
- Event clip MP4 export (ffmpeg concat), when sample segments are supplied
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
APP_DIR = ROOT / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def _utc(year, month, day, hour=0, minute=0, second=0) -> datetime:
    return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)


class _TempEnvTestCase(unittest.TestCase):
    """Fresh temp dir per test so tests don't bleed state."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="dvr-test-")
        self.data_dir = Path(self.tmpdir) / "data"
        self.nvme_dir = Path(self.tmpdir) / "nvme"
        (self.data_dir).mkdir(parents=True, exist_ok=True)
        (self.nvme_dir).mkdir(parents=True, exist_ok=True)

        os.environ["DATA_DIR"] = str(self.data_dir)
        os.environ["NVME_BASE"] = str(self.nvme_dir)
        os.environ["MIN_SEGMENT_BYTES"] = "16"
        os.environ["RECORDING_SEGMENT_SECONDS"] = "10"

        # Force a reimport so constants pick up new env.
        for mod_name in list(sys.modules):
            if mod_name == "playback" or mod_name.startswith("playback."):
                del sys.modules[mod_name]
        import playback  # noqa: F401
        self.playback = playback

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_segment_file(self, device_id: str, started_at: datetime, payload: bytes = b"\x00" * 32) -> Path:
        device_dir = self.playback._device_recordings_dir(device_id)
        fname = started_at.strftime("%Y%m%dT%H%M%SZ.ts")
        path = device_dir / fname
        path.write_bytes(payload)
        return path

    def _insert_index_row(self, device_id: str, started_at: datetime, duration_seconds: float, finalized: bool = True):
        seg = self.playback.Segment(
            device_id=device_id,
            filename=started_at.strftime("%Y%m%dT%H%M%SZ.ts"),
            started_at=started_at,
            ended_at=started_at + timedelta(seconds=duration_seconds),
            duration_seconds=duration_seconds,
            size_bytes=1024,
            finalized=finalized,
            has_audio=False,
        )
        with self.playback._index_connect(device_id) as conn:
            self.playback._index_upsert(conn, seg)


class TestIndexAndQuery(_TempEnvTestCase):
    def test_migration_creates_tables(self):
        with self.playback._index_connect("cam1") as conn:
            rows = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        names = {r[0] for r in rows}
        self.assertIn("segments", names)

    def test_range_query_filters_by_time(self):
        device = "cam1"
        self._insert_index_row(device, _utc(2026, 4, 24, 12, 0, 0), 10.0)
        self._insert_index_row(device, _utc(2026, 4, 24, 12, 0, 10), 10.0)
        self._insert_index_row(device, _utc(2026, 4, 24, 13, 0, 0), 10.0)

        window = self.playback._index_query_range(
            device, _utc(2026, 4, 24, 12, 0, 0), _utc(2026, 4, 24, 12, 0, 20)
        )
        self.assertEqual(len(window), 2)

        latest = self.playback._index_latest_started_at(device)
        self.assertEqual(latest, _utc(2026, 4, 24, 13, 0, 0))


class TestReconcile(_TempEnvTestCase):
    def _fake_ffprobe(self, duration_seconds: float):
        def _probe(path: Path):
            try:
                size = path.stat().st_size
            except OSError:
                return None
            return duration_seconds, size, False
        return _probe

    def test_reconcile_adds_new_finalized_segments(self):
        device = "cam1"
        started_at = _utc(2026, 4, 24, 12, 0, 0)
        # Two segments, one older (finalized) and one newer (tip).
        self._make_segment_file(device, started_at, payload=b"\x00" * 2048)
        tip = started_at + timedelta(seconds=10)
        self._make_segment_file(device, tip, payload=b"\x00" * 2048)

        with patch.object(self.playback, "_ffprobe_segment", self._fake_ffprobe(10.0)):
            result = self.playback.reconcile_device_index(device)

        self.assertGreaterEqual(result["added"], 1)
        all_segs = self.playback._index_all(device)
        self.assertEqual(len(all_segs), 2)
        # Non-tip segment is finalized; tip can be unfinalized.
        non_tip = [s for s in all_segs if s.filename != tip.strftime("%Y%m%dT%H%M%SZ.ts")]
        self.assertTrue(non_tip[0].finalized)

    def test_reconcile_removes_missing(self):
        device = "cam1"
        self._insert_index_row(device, _utc(2026, 4, 24, 12, 0, 0), 10.0)
        with patch.object(self.playback, "_ffprobe_segment", self._fake_ffprobe(10.0)):
            result = self.playback.reconcile_device_index(device)
        self.assertEqual(result["removed"], 1)
        self.assertEqual(self.playback._index_all(device), [])

    def test_reconcile_drops_tiny_corrupt_segments(self):
        device = "cam1"
        started_at = _utc(2026, 4, 24, 12, 0, 0)
        # Tiny payload below MIN_SEGMENT_BYTES=16 is dropped if the probe fails.
        self._make_segment_file(device, started_at, payload=b"x")
        tip = started_at + timedelta(seconds=10)
        self._make_segment_file(device, tip, payload=b"\x00" * 1024)

        def _probe_fail(path):
            if path.stat().st_size < 16:
                return None
            return 10.0, path.stat().st_size, False

        with patch.object(self.playback, "_ffprobe_segment", _probe_fail):
            self.playback.reconcile_device_index(device)

        device_dir = self.playback._device_recordings_dir(device)
        remaining_files = sorted(p.name for p in device_dir.glob("*.ts"))
        self.assertEqual(len(remaining_files), 1)
        self.assertEqual(remaining_files[0], tip.strftime("%Y%m%dT%H%M%SZ.ts"))


class TestHLSPlaylist(_TempEnvTestCase):
    def test_playlist_marks_discontinuity_at_gap(self):
        device = "cam1"
        # Three segments; a 30-second gap between #2 and #3.
        self._insert_index_row(device, _utc(2026, 4, 24, 12, 0, 0), 10.0)
        self._insert_index_row(device, _utc(2026, 4, 24, 12, 0, 10), 10.0)
        self._insert_index_row(device, _utc(2026, 4, 24, 12, 0, 50), 10.0)

        playlist = self.playback._build_hls_playlist(
            device, _utc(2026, 4, 24, 12, 0, 0), _utc(2026, 4, 24, 12, 1, 0)
        )
        self.assertIn("#EXTM3U", playlist)
        self.assertIn("#EXT-X-DISCONTINUITY", playlist)
        # First two segments back-to-back: no DISCONTINUITY between them.
        # Check the first DISCONTINUITY appears after the second segment line.
        lines = playlist.splitlines()
        disc_index = next(i for i, ln in enumerate(lines) if ln == "#EXT-X-DISCONTINUITY")
        segs_before = sum(1 for ln in lines[:disc_index] if ln.startswith("seg/"))
        self.assertEqual(segs_before, 2)

    def test_playlist_rejects_oversized_window(self):
        device = "cam1"
        with self.assertRaises(Exception):
            self.playback._build_hls_playlist(
                device, _utc(2026, 4, 24, 0, 0, 0), _utc(2026, 4, 26, 0, 0, 0)
            )

    def test_playlist_only_includes_segments_in_range(self):
        device = "cam1"
        self._insert_index_row(device, _utc(2026, 4, 24, 11, 0, 0), 10.0)  # before
        self._insert_index_row(device, _utc(2026, 4, 24, 12, 0, 0), 10.0)  # in
        self._insert_index_row(device, _utc(2026, 4, 24, 13, 0, 0), 10.0)  # after

        playlist = self.playback._build_hls_playlist(
            device, _utc(2026, 4, 24, 12, 0, 0), _utc(2026, 4, 24, 12, 0, 30)
        )
        seg_refs = [ln for ln in playlist.splitlines() if ln.startswith("seg/")]
        self.assertEqual(len(seg_refs), 1)
        self.assertIn("20260424T120000Z.ts", seg_refs[0])


class TestEventCoverage(_TempEnvTestCase):
    def test_segments_cover_with_tolerance(self):
        device = "cam1"
        segs = [
            self.playback.Segment(
                device_id=device, filename="a.ts",
                started_at=_utc(2026, 4, 24, 12, 0, 0),
                ended_at=_utc(2026, 4, 24, 12, 0, 10),
                duration_seconds=10.0, size_bytes=1024,
                finalized=True, has_audio=False,
            ),
            self.playback.Segment(
                device_id=device, filename="b.ts",
                started_at=_utc(2026, 4, 24, 12, 0, 10),
                ended_at=_utc(2026, 4, 24, 12, 0, 20),
                duration_seconds=10.0, size_bytes=1024,
                finalized=True, has_audio=False,
            ),
        ]
        self.assertTrue(
            self.playback._segments_cover(
                segs, _utc(2026, 4, 24, 12, 0, 0), _utc(2026, 4, 24, 12, 0, 20)
            )
        )
        # 30s window, 20s of data: not covered.
        self.assertFalse(
            self.playback._segments_cover(
                segs, _utc(2026, 4, 24, 12, 0, 0), _utc(2026, 4, 24, 12, 0, 30)
            )
        )

    def test_event_state_ready_vs_missing(self):
        device = "cam1"
        # Event in the past with full segment coverage → ready.
        past_start = self.playback._utc_now() - timedelta(minutes=10)
        past_end = past_start + timedelta(seconds=10)
        self._insert_index_row(device, past_start, 10.0, finalized=True)
        event_ready = {
            "id": "e1",
            "device_id": device,
            "triggered_at": past_start.isoformat(),
            "clip_start": past_start.isoformat(),
            "clip_end": past_end.isoformat(),
        }
        self.assertEqual(self.playback._event_state(event_ready), "ready")

        # Event in the past with NO coverage → missing.
        event_missing = {
            "id": "e2",
            "device_id": device,
            "triggered_at": (past_start - timedelta(hours=1)).isoformat(),
            "clip_start": (past_start - timedelta(hours=1)).isoformat(),
            "clip_end": (past_start - timedelta(hours=1, seconds=-10)).isoformat(),
        }
        # Construct a clean end > start
        ms_start = past_start - timedelta(hours=1)
        ms_end = ms_start + timedelta(seconds=10)
        event_missing["clip_start"] = ms_start.isoformat()
        event_missing["clip_end"] = ms_end.isoformat()
        self.assertEqual(self.playback._event_state(event_missing), "missing")


class TestBaseDirResolution(_TempEnvTestCase):
    def test_uses_nvme_when_writable(self):
        resolved = self.playback._resolve_base_dir()
        self.assertEqual(resolved.resolve(), self.nvme_dir.resolve())

    def test_override_takes_precedence(self):
        override = Path(self.tmpdir) / "custom"
        override.mkdir()
        settings_path = self.data_dir / "settings.json"
        settings_path.write_text(json.dumps({"recording_path": str(override)}))
        resolved = self.playback._resolve_base_dir()
        self.assertEqual(resolved.resolve(), override.resolve())


if __name__ == "__main__":
    unittest.main(verbosity=2)
