Installation:

Fresh Raspberry Pi 5 install:

curl -fsSL https://raw.githubusercontent.com/henklr/smarteye-hub/main/install.sh | bash

If the repository is private, create a GitHub Personal Access Token (classic) with
`repo` scope at https://github.com/settings/tokens and run:

GH_TOKEN=YOUR_TOKEN curl -fsSL -H "Authorization: token $GH_TOKEN" \
  https://raw.githubusercontent.com/henklr/smarteye-hub/main/install.sh | GH_TOKEN="$GH_TOKEN" bash

If you omit `GH_TOKEN` from the `bash` part, the installer will prompt you for it
interactively when the clone fails.

The installer will:

- install Docker and the Docker Compose plugin if needed
- clone or update the repo in $HOME/smarteye-hub
- enable Raspberry Pi I2C support for Automation HAT usage when possible
- start the stack with docker compose

If the script adds your user to the docker group or enables I2C, reboot the Pi before first use.

Optional custom web port:

PORT=8080 curl -fsSL https://raw.githubusercontent.com/henklr/smarteye-hub/main/install.sh | bash


## Recording engine

The recording engine pulls every `cam-*` path 24/7 from MediaMTX, segments it
into 2-second stream-copy MP4s in `$NVME_BASE/buffer/<cam>/`, and assembles
clips on demand via the concat demuxer (no transcoding, ever).

### Camera-side requirements

For trim-on-keyframe to work cleanly with 2-second buffer segments, configure
each camera so I-frames appear at least as often as the segment boundary:

- **GOP / keyframe interval: 1 second** (= 2× the segment size, or as low as
  the camera supports — must be ≤ 2 s).
- All cameras and the Pi must share NTP time. Drift will be visible as
  off-by-one segments at the clip boundary.

Verify the GOP after configuring a camera:

```bash
ffprobe -select_streams v -show_frames -of csv \
    "rtsp://<user>:<pass>@<camera-ip>/..." 2>/dev/null | \
    awk -F, '$3=="I"{print $2}' | head -5
```

Successive I-frame `pts_time` values should differ by ≤ 1.0 s.

### Configuration (docker-compose env)

| variable | default | meaning |
|---|---|---|
| `RECORDING_SEGMENT_SECONDS` | 2 | duration of each stream-copy MP4 fragment |
| `RECORDING_MAX_PREBUFFER_SECONDS` | 600 | longest pre-buffer the trigger API will honour |
| `RECORDING_BUFFER_MARGIN_SECONDS` | 60 | extra retention on top of max pre-buffer |
| `RECORDING_TRIGGER_MAX_DURATION_SECONDS` | 1800 | server-side cap on `max_duration_seconds` per trigger |
| `RECORDING_CONTINUOUS_CAMERAS` | (empty) | comma-separated `cam-*` names that record 24/7 |
| `RECORDING_CONTINUOUS_CHUNK_SECONDS` | 3600 | rolling clip size for continuous cameras |
| `RECORDING_CONTINUOUS_RETENTION_DAYS` | 7 | how long to keep continuous clips before pruning |

### HTTP API

- `POST /api/record/start` — `{camera, event_id?, pre_buffer_seconds, max_duration_seconds?, metadata?}`
- `POST /api/record/stop` — `{event_id, metadata?}`
- `GET  /api/record/active` — list open recordings
- `GET  /api/clips` — paginated, filterable (camera, from, to, kind)
- `GET  /api/clips/{id}` — clip metadata
- `GET  /api/clips/{id}/video` — MP4 with HTTP Range support
- `GET  /api/clips/{id}/thumbnail` — JPEG
- `DELETE /api/clips/{id}` — remove clip + file

### Playback UI

Browse clips at `/playback`. The page uses a vanilla HTML5 `<video>` element
with `preload="metadata"`, scrubbing via byte-range requests, and auto-advance
between clips in the current filter.
