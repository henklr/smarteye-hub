using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

// ─────────────────────────────────────────────────────────────────────────────
// Service registration
// ─────────────────────────────────────────────────────────────────────────────
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<DeviceRegistry>();
builder.Services.AddSingleton<StreamRelay>();
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

// ─────────────────────────────────────────────────────────────────────────────
// Middleware pipeline
// ─────────────────────────────────────────────────────────────────────────────
var app = builder.Build();
var piToken = app.Configuration["PiToken"] ?? "changeme-secret-token";
var log = app.Logger;

app.UseCors();
app.UseDefaultFiles();   // serves wwwroot/index.html for /
app.UseStaticFiles();
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });

// ─────────────────────────────────────────────────────────────────────────────
// /pi/connect  — Pi devices connect here (outbound from Pi, no inbound needed)
// ─────────────────────────────────────────────────────────────────────────────
app.Map("/pi/connect", async (HttpContext ctx, DeviceRegistry registry, StreamRelay relay) =>
{
    if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }

    var token = ctx.Request.Query["token"].FirstOrDefault() ?? string.Empty;
    if (token != piToken) { ctx.Response.StatusCode = 401; return; }

    var ws = await ctx.WebSockets.AcceptWebSocketAsync();
    log.LogInformation("Pi connected from {IP}", ctx.Connection.RemoteIpAddress);

    string? deviceId = null;
    var buffer = new byte[128 * 1024];

    try
    {
        while (ws.State == WebSocketState.Open)
        {
            // Reassemble potentially-fragmented WebSocket messages
            using var ms = new MemoryStream();
            WebSocketReceiveResult result;
            bool closed = false;
            do
            {
                result = await ws.ReceiveAsync(buffer, ctx.RequestAborted);
                if (result.MessageType == WebSocketMessageType.Close) { closed = true; break; }
                ms.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);

            if (closed) break;

            var data = ms.ToArray();

            if (result.MessageType == WebSocketMessageType.Text)
            {
                using var json = JsonDocument.Parse(data);
                var type = json.RootElement.GetProperty("type").GetString();

                if (type == "register")
                {
                    deviceId = json.RootElement.GetProperty("device_id").GetString()!;
                    var cameras = json.RootElement.GetProperty("cameras").EnumerateArray()
                        .Select(c => new CameraInfo(
                            c.GetProperty("id").GetString()!,
                            c.GetProperty("name").GetString()!))
                        .ToList();
                    var conn = new PiConnection(ws, cameras);
                    registry.Register(deviceId, conn);
                    log.LogInformation("Pi registered: {DeviceId}, cameras: {Count}", deviceId, cameras.Count);
                }
                else if (type == "ping" && deviceId != null)
                {
                    var conn = registry.Get(deviceId);
                    if (conn != null)
                        await conn.SendTextAsync("""{"type":"pong"}""", ctx.RequestAborted);
                }
            }
            else if (result.MessageType == WebSocketMessageType.Binary && data.Length > 36)
            {
                // Protocol: first 36 bytes = stream_id (UUID ASCII), rest = fMP4 video data
                var streamId = Encoding.ASCII.GetString(data, 0, 36);
                var session = relay.GetStream(streamId);
                if (session != null)
                    await session.BroadcastAsync(data.AsMemory(36), ctx.RequestAborted);
            }
        }
    }
    catch (OperationCanceledException) { }
    catch (WebSocketException ex) { log.LogWarning("Pi WebSocket error: {Msg}", ex.Message); }
    finally
    {
        if (deviceId != null)
        {
            var conn = registry.Unregister(deviceId);
            log.LogInformation("Pi disconnected: {DeviceId}", deviceId);
            if (conn != null)
                foreach (var sid in conn.StreamIds.ToList())
                    relay.RemoveStream(sid);
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// /stream/{streamId}  — Browser connects here to receive video
// ─────────────────────────────────────────────────────────────────────────────
app.Map("/stream/{streamId}", async (HttpContext ctx, string streamId, StreamRelay relay) =>
{
    if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }

    var session = relay.GetStream(streamId);
    if (session == null) { ctx.Response.StatusCode = 404; return; }

    var ws = await ctx.WebSockets.AcceptWebSocketAsync();
    log.LogInformation("Browser viewer joined stream {StreamId}", streamId);

    // Blocks until browser disconnects
    await session.AddViewerAsync(ws, ctx.RequestAborted);
    log.LogInformation("Browser viewer left stream {StreamId}", streamId);
});

// ─────────────────────────────────────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/devices — list currently-connected Pi devices and their cameras
app.MapGet("/api/devices", (DeviceRegistry registry) =>
    Results.Ok(registry.GetAll()));

// POST /api/stream/start — tell the Pi to start streaming a camera
app.MapPost("/api/stream/start", async (
    StreamStartRequest req, DeviceRegistry registry, StreamRelay relay) =>
{
    var conn = registry.Get(req.DeviceId);
    if (conn == null)
        return Results.NotFound(new { error = "Device not connected" });

    var streamId = Guid.NewGuid().ToString();
    relay.CreateStream(streamId);
    conn.AddStream(streamId);

    await conn.SendTextAsync(JsonSerializer.Serialize(new
    {
        type = "start_stream",
        stream_id = streamId,
        camera_id = req.CameraId,
    }));

    log.LogInformation("Stream {StreamId} started for device {Device}, camera {Camera}",
        streamId, req.DeviceId, req.CameraId);

    return Results.Ok(new { streamId });
});

// DELETE /api/stream/{streamId} — stop a stream
app.MapDelete("/api/stream/{streamId}", async (
    string streamId, DeviceRegistry registry, StreamRelay relay) =>
{
    var session = relay.GetStream(streamId);
    if (session == null) return Results.NotFound();

    // Tell the Pi to stop
    var conn = registry.GetByStream(streamId);
    if (conn != null)
    {
        conn.RemoveStream(streamId);
        await conn.SendTextAsync(JsonSerializer.Serialize(new
        {
            type = "stop_stream",
            stream_id = streamId,
        }));
    }

    relay.RemoveStream(streamId);
    log.LogInformation("Stream {StreamId} stopped", streamId);
    return Results.NoContent();
});

app.Run();

// ─────────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────────

record CameraInfo(string Id, string Name);

record StreamStartRequest(
    [property: JsonPropertyName("deviceId")] string DeviceId,
    [property: JsonPropertyName("cameraId")] string CameraId);

// Represents an active Pi connection
class PiConnection
{
    private readonly WebSocket _ws;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly HashSet<string> _streamIds = new();

    public IReadOnlyList<CameraInfo> Cameras { get; }
    public IReadOnlyCollection<string> StreamIds => _streamIds;

    public PiConnection(WebSocket ws, IEnumerable<CameraInfo> cameras)
    {
        _ws = ws;
        Cameras = cameras.ToList().AsReadOnly();
    }

    public void AddStream(string streamId) { lock (_streamIds) { _streamIds.Add(streamId); } }
    public void RemoveStream(string streamId) { lock (_streamIds) { _streamIds.Remove(streamId); } }

    public async Task SendTextAsync(string text, CancellationToken ct = default)
    {
        await _sendLock.WaitAsync(ct);
        try
        {
            if (_ws.State == WebSocketState.Open)
                await _ws.SendAsync(Encoding.UTF8.GetBytes(text),
                    WebSocketMessageType.Text, true, ct);
        }
        finally { _sendLock.Release(); }
    }
}

// Thread-safe registry of connected Pi devices
class DeviceRegistry
{
    private readonly ConcurrentDictionary<string, PiConnection> _devices = new();

    public void Register(string deviceId, PiConnection conn) => _devices[deviceId] = conn;

    public PiConnection? Unregister(string deviceId)
    {
        _devices.TryRemove(deviceId, out var conn);
        return conn;
    }

    public PiConnection? Get(string deviceId) => _devices.GetValueOrDefault(deviceId);

    // Find which Pi owns a given stream ID
    public PiConnection? GetByStream(string streamId) =>
        _devices.Values.FirstOrDefault(c => c.StreamIds.Contains(streamId));

    public IEnumerable<object> GetAll() =>
        _devices.Select(kv => (object)new
        {
            deviceId = kv.Key,
            cameras = kv.Value.Cameras,
        });
}

// A single active video stream session; multiple browser viewers may join
class StreamSession
{
    private readonly ConcurrentDictionary<string, WebSocket> _viewers = new();
    private readonly SemaphoreSlim _broadcastLock = new(1, 1);

    /// <summary>Join as a viewer; awaits until the viewer disconnects.</summary>
    public async Task AddViewerAsync(WebSocket ws, CancellationToken ct = default)
    {
        var id = Guid.NewGuid().ToString();
        _viewers[id] = ws;
        try
        {
            var buf = new byte[256];
            while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                var r = await ws.ReceiveAsync(buf, ct);
                if (r.MessageType == WebSocketMessageType.Close) break;
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
        finally { _viewers.TryRemove(id, out _); }
    }

    /// <summary>Send a video chunk to all connected browser viewers.</summary>
    public async Task BroadcastAsync(ReadOnlyMemory<byte> data, CancellationToken ct = default)
    {
        await _broadcastLock.WaitAsync(ct);
        try
        {
            var tasks = _viewers.Values
                .Where(ws => ws.State == WebSocketState.Open)
                .Select(async ws =>
                {
                    try { await ws.SendAsync(data, WebSocketMessageType.Binary, true, ct); }
                    catch { /* viewer disconnected mid-send */ }
                });
            await Task.WhenAll(tasks);
        }
        finally { _broadcastLock.Release(); }
    }

    public async Task CloseAllAsync()
    {
        var tasks = _viewers.Values
            .Where(ws => ws.State == WebSocketState.Open)
            .Select(async ws =>
            {
                try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure,
                    "Stream ended", CancellationToken.None); }
                catch { }
            });
        await Task.WhenAll(tasks);
    }
}

// Registry of all active stream sessions
class StreamRelay
{
    private readonly ConcurrentDictionary<string, StreamSession> _streams = new();

    public StreamSession CreateStream(string streamId)
    {
        var session = new StreamSession();
        _streams[streamId] = session;
        return session;
    }

    public StreamSession? GetStream(string streamId) => _streams.GetValueOrDefault(streamId);

    public void RemoveStream(string streamId)
    {
        if (_streams.TryRemove(streamId, out var session))
            _ = session.CloseAllAsync();
    }
}
