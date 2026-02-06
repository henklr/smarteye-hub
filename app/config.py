from pydantic import BaseModel


class Settings(BaseModel):
    # MJPEG settings
    mjpeg_fps: int = 8
    mjpeg_jpeg_quality: int = 80

    # Event polling settings (PullMessages timeout + sleep)
    event_pull_timeout_seconds: int = 10
    event_poll_sleep_seconds: float = 0.2

    # Keep last N events in memory per device
    event_buffer_size: int = 200


settings = Settings()
