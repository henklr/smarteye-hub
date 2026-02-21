FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1

# System deps (ffmpeg needed for H265->H264 transcode; remove if cameras are H264)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ .

ENV PORT=8000
CMD ["sh", "-lc", "uvicorn main:app --host 0.0.0.0 --port $PORT"]