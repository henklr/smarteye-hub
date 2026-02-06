from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api import router as api_router
from app.event_listener import EventManager

app = FastAPI(title="ONVIF Demo Backend", version="0.1.0")

# API routes
app.include_router(api_router, prefix="/api")

# Serve the minimal frontend
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")

event_manager = EventManager()


@app.on_event("startup")
async def _startup() -> None:
    # Start background manager (no-op until devices are registered)
    await event_manager.start()


@app.on_event("shutdown")
async def _shutdown() -> None:
    await event_manager.stop()


def get_event_manager() -> EventManager:
    return event_manager
