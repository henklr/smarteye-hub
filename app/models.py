from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List
from datetime import datetime


class DeviceCreate(BaseModel):
    name: str = Field(..., examples=["Lobby Cam"])
    host: str = Field(..., examples=["192.168.1.50"])
    port: int = Field(80, examples=[80])
    username: str
    password: str


class DeviceInfo(BaseModel):
    id: str
    name: str
    host: str
    port: int
    username: str


class StreamInfo(BaseModel):
    rtsp_uri: str
    profile_token: Optional[str] = None


class OnvifEvent(BaseModel):
    ts: datetime
    topic: Optional[str] = None
    operation: Optional[str] = None
    message: Dict[str, Any] = Field(default_factory=dict)


class EventsResponse(BaseModel):
    device_id: str
    events: List[OnvifEvent]
