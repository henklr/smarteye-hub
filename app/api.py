from __future__ import annotations
from typing import Optional, AsyncGenerator
import asyncio
import json

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse

from .models import DeviceCreate, DeviceInfo, StreamInfo, EventsResponse
from .storage import store
from .onvif_client import OnvifDeviceSession
from .streaming import mjpeg_response
from .event_listener import EventManager

router = APIRouter()


def get_event_manager_dep() -> EventManager:
    # Imported from main via FastAPI app state would be cleaner,
    # but keeping it simple for a multi-file snippet.
    from main import get_event_manager
    return get_event_manager()


@router.post("/devices", response_model=DeviceInfo)
async def add_device(dc: DeviceCreate, em: EventManager = Depends(get_event_manager_dep)) -> DeviceInfo:
    info = store.add_device(dc)
    em.ensure_worker(info.id)
    return info


@router.get("/devices", response_model=list[DeviceInfo])
async def list_devices() -> list[DeviceInfo]:
    return store.list_devices()


@router.get("/devices/{device_id}/stream-info", response_model=StreamInfo)
async def get_stream_info(device_id: str, profile_token: Optional[str] = None) -> StreamInfo:
    d = store.get_device(device_id)
    if not d:
        raise HTTPException(status_code=404, detail="Device not found")

    session = OnvifDeviceSession(d.host, d.port, d.username, d.password)
    # Run blocking ONVIF in thread
    loop = asyncio.get_running_loop()
    rtsp_uri, used_token = await loop.run_in_executor(None, session.get_rtsp_stream_uri, profile_token)
    return StreamInfo(rtsp_uri=rtsp_uri, profile_token=used_token)


@router.get("/devices/{device_id}/stream.mjpeg")
async def watch_stream_mjpeg(device_id: str, profile_token: Optional[str] = None):
    d = store.get_device(device_id)
    if not d:
        raise HTTPException(status_code=404, detail="Device not found")

    session = OnvifDeviceSession(d.host, d.port, d.username, d.password)
    loop = asyncio.get_running_loop()
    rtsp_uri, _ = await loop.run_in_executor(None, session.get_rtsp_stream_uri, profile_token)
    return mjpeg_response(rtsp_uri)


@router.get("/devices/{device_id}/events", response_model=EventsResponse)
async def get_events(device_id: str) -> EventsResponse:
    d = store.get_device(device_id)
    if not d:
        raise HTTPException(status_code=404, detail="Device not found")
    return EventsResponse(device_id=device_id, events=store.get_events(device_id))


@router.get("/devices/{device_id}/events.sse")
async def events_sse(device_id: str):
    d = store.get_device(device_id)
    if not d:
        raise HTTPException(status_code=404, detail="Device not found")

    async def gen() -> AsyncGenerator[bytes, None]:
        last_len = 0
        while True:
            evs = store.get_events(device_id)
            if len(evs) != last_len:
                # send only new events
                new = evs[last_len:]
                last_len = len(evs)
                for e in new:
                    payload = e.model_dump()
                    yield f"event: onvif\ndata: {json.dumps(payload, default=str)}\n\n".encode("utf-8")
            await asyncio.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream")
