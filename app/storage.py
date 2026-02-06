from __future__ import annotations
from dataclasses import dataclass
from typing import Dict, Optional, List
from collections import deque
from pathlib import Path
import json
import uuid

from .models import DeviceCreate, DeviceInfo, OnvifEvent
from .config import settings


DATA_DIR = Path("/app/data")
DEVICES_FILE = DATA_DIR / "devices.json"


@dataclass
class StoredDevice:
    id: str
    name: str
    host: str
    port: int
    username: str
    password: str  # demo only


class InMemoryStore:
    def __init__(self) -> None:
        self.devices: Dict[str, StoredDevice] = {}
        self.events: Dict[str, deque[OnvifEvent]] = {}

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self._load_devices()

    def _load_devices(self) -> None:
        if not DEVICES_FILE.exists():
            return
        try:
            raw = json.loads(DEVICES_FILE.read_text())
            for item in raw:
                d = StoredDevice(**item)
                self.devices[d.id] = d
                self.events[d.id] = deque(maxlen=settings.event_buffer_size)
        except Exception:
            pass

    def _save_devices(self) -> None:
        DEVICES_FILE.write_text(json.dumps(
            [d.__dict__ for d in self.devices.values()],
            indent=2
        ))

    def add_device(self, dc: DeviceCreate) -> DeviceInfo:
        device_id = str(uuid.uuid4())
        d = StoredDevice(
            id=device_id,
            name=dc.name,
            host=dc.host,
            port=dc.port,
            username=dc.username,
            password=dc.password,
        )
        self.devices[device_id] = d
        self.events[device_id] = deque(maxlen=settings.event_buffer_size)
        self._save_devices()
        return DeviceInfo(id=d.id, name=d.name, host=d.host, port=d.port, username=d.username)

    def list_devices(self) -> List[DeviceInfo]:
        return [
            DeviceInfo(id=d.id, name=d.name, host=d.host, port=d.port, username=d.username)
            for d in self.devices.values()
        ]

    def get_device(self, device_id: str) -> Optional[StoredDevice]:
        return self.devices.get(device_id)

    def push_event(self, device_id: str, event: OnvifEvent) -> None:
        if device_id not in self.events:
            self.events[device_id] = deque(maxlen=settings.event_buffer_size)
        self.events[device_id].append(event)

    def get_events(self, device_id: str) -> List[OnvifEvent]:
        return list(self.events.get(device_id, []))


store = InMemoryStore()
