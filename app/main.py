from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

app = FastAPI()

# Serve everything in /static as the website root
app.mount("/", StaticFiles(directory="static", html=True), name="static")

@app.get("/api/health")
def health():
    return {"status": "ok"}

