FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    gcc \
    g++ \
    make \
    libpam0g \
    openssl \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/certs \
  && openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout /app/certs/key.pem -out /app/certs/cert.pem \
     -days 3650 -subj "/CN=smarteye-hub"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ .

EXPOSE 80 443
CMD ["sh", "-c", "if [ ! -f /app/data/.cookie_secret ]; then python -c 'import secrets; print(secrets.token_hex(32))' > /app/data/.cookie_secret; fi; export COOKIE_SECRET=$(cat /app/data/.cookie_secret); uvicorn main:app --host 0.0.0.0 --port ${PORT:-80} & uvicorn main:app --host 0.0.0.0 --port 443 --ssl-keyfile /app/certs/key.pem --ssl-certfile /app/certs/cert.pem & wait"]