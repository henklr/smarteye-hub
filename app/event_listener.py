from __future__ import annotations
from typing import Dict, Optional, Any, AsyncGenerator
from datetime import datetime
import asyncio
import json

from .storage import store, StoredDevice
from .onvif_client import OnvifDeviceSession
from .models import OnvifEvent
from .config import settings


def _simplify_zeep(obj: Any) -> Any:
    """
    Best-effort conversion of Zeep objects into JSON-serializable structures.
    """
    if obj is None:
        return None
    if isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, (list, tuple)):
        return [_simplify_zeep(x) for x in obj]
    if isinstance(obj, dict):
        return {str(k): _simplify_zeep(v) for k, v in obj.items()}
    # Zeep objects often have __dict__ with useful fields
    d = getattr(obj, "__dict__", None)
    if isinstance(d, dict) and d:
        return {str(k): _simplify_zeep(v) for k, v in d.items()}
    # Fallback to string
    return str(obj)


class DeviceEventWorker:
    def __init__(self, device: StoredDevice) -> None:
        self.device = device
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except Exception:
                # If it hangs, cancel
                self._task.cancel()

    async def _run(self) -> None:
        session = OnvifDeviceSession(
            host=self.device.host,
            port=self.device.port,
            username=self.device.username,
            password=self.device.password,
        )

        # ONVIF calls are blocking; use a thread executor for the heavy bits
        loop = asyncio.get_running_loop()

        subscription = None
        pullpoint = None

        async def ensure_subscription() -> None:
            nonlocal subscription, pullpoint
            if subscription and pullpoint:
                return
            subscription = await loop.run_in_executor(None, session.create_pullpoint_subscription)
            pullpoint = await loop.run_in_executor(None, session.create_pullpoint_service_from_subscription, subscription)

        while not self._stop.is_set():
            try:
                await ensure_subscription()

                # PullMessages request varies by device; we try with a request object first
                def pull_once() -> Any:
                    req = pullpoint.create_type("PullMessages")
                    req.Timeout = f"PT{settings.event_pull_timeout_seconds}S"
                    req.MessageLimit = 10
                    return pullpoint.PullMessages(req)

                resp = await loop.run_in_executor(None, pull_once)

                # Extract notifications
                notif = getattr(resp, "NotificationMessage", None)
                if notif:
                    if not isinstance(notif, list):
                        notif = [notif]
                    for n in notif:
                        ev = OnvifEvent(
                            ts=datetime.utcnow(),
                            topic=getattr(getattr(n, "Topic", None), "_value_1", None) or getattr(n, "Topic", None) and str(n.Topic),
                            operation=getattr(n, "Operation", None),
                            message={
                                "raw": _simplify_zeep(n),
                            },
                        )
                        store.push_event(self.device.id, ev)

                await asyncio.sleep(settings.event_poll_sleep_seconds)

            except asyncio.CancelledError:
                break
            except Exception as e:
                # Reset subscription on any error, retry after a short delay
                subscription = None
                pullpoint = None
                store.push_event(
                    self.device.id,
                    OnvifEvent(
                        ts=datetime.utcnow(),
                        topic="internal/error",
                        operation="exception",
                        message={"error": str(e)},
                    ),
                )
                await asyncio.sleep(2.0)


class EventManager:
    """
    Keeps a worker per device. For demo purposes we start/stop workers when device exists.
    """
    def __init__(self) -> None:
        self.workers: Dict[str, DeviceEventWorker] = {}
        self._started = False

    async def start(self) -> None:
        self._started = True
        # Start workers for any pre-existing devices (none in this demo)
        for d in store.devices.values():
            self.ensure_worker(d.id)

    async def stop(self) -> None:
        await asyncio.gather(*(w.stop() for w in self.workers.values()), return_exceptions=True)
        self.workers.clear()
        self._started = False

    def ensure_worker(self, device_id: str) -> None:
        d = store.get_device(device_id)
        if not d:
            return
        if device_id not in self.workers:
            self.workers[device_id] = DeviceEventWorker(d)
        self.workers[device_id].start()
