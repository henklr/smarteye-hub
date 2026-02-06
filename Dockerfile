FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# OpenCV runtime deps + basics
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

# Create data dir inside container (bind-mounted in start script)
RUN mkdir -p /app/data

# Port (uvicorn uses PORT env or default 8000)
EXPOSE 8000

CMD ["bash", "-lc", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
