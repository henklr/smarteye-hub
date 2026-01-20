# time_utils.py
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from typing import Optional


@dataclass(frozen=True)
class Clock:
    timezone_name: str = "UTC"

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone_name)

    def now_utc(self) -> datetime:
        return datetime.now(timezone.utc)

    def now_local(self) -> datetime:
        return self.now_utc().astimezone(self.tz)

    def utc_iso(self, dt: Optional[datetime] = None) -> str:
        """Return ISO 8601 string in UTC, with trailing 'Z'."""
        if dt is None:
            dt = self.now_utc()
        dt_utc = self.ensure_aware(dt).astimezone(timezone.utc)
        # Use seconds resolution; add milliseconds if you want
        return dt_utc.replace(microsecond=0).isoformat().replace("+00:00", "Z")

    def ensure_aware(self, dt: datetime) -> datetime:
        """If dt is naive, assume configured local timezone."""
        if dt.tzinfo is None:
            return dt.replace(tzinfo=self.tz)
        return dt

    def parse_datetime(self, s: str, assume_tz: Optional[ZoneInfo] = None) -> datetime:
        """
        Parse common timestamp formats into an aware datetime.

        Accepted:
          - ISO with Z (e.g. 2026-01-20T12:34:56Z)
          - ISO with offset
          - ISO without tz -> assumed local tz (configurable)
          - "YYYY-MM-DD HH:MM:SS" -> assumed local tz
        """
        s = (s or "").strip()
        if not s:
            raise ValueError("Empty datetime string")

        tz = assume_tz or self.tz

        # ISO with trailing Z
        if s.endswith("Z"):
            # fromisoformat doesn't accept 'Z' directly
            base = s[:-1]
            dt = datetime.fromisoformat(base)
            return dt.replace(tzinfo=timezone.utc)

        # Try ISO (with or without offset)
        try:
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=tz)
            return dt
        except ValueError:
            pass

        # Fallback: "YYYY-MM-DD HH:MM:SS"
        try:
            dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
            return dt.replace(tzinfo=tz)
        except ValueError as e:
            raise ValueError(f"Unsupported datetime format: {s}") from e


def make_clock(settings: dict) -> Clock:
    tz = (
        settings.get("time", {}).get("timezone")
        or settings.get("timezone")
        or "UTC"
    )
    return Clock(timezone_name=tz)
