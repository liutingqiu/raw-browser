using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;

const string Version = "0.7.0";

var processName = Process.GetCurrentProcess().ProcessName;
string? forcedBrowser = Environment.GetEnvironmentVariable("RAW_BRIDGE_BROWSER");
if (string.IsNullOrWhiteSpace(forcedBrowser))
{
    var browserArg = args.FirstOrDefault(a => a.StartsWith("--browser=", StringComparison.OrdinalIgnoreCase));
    if (browserArg is not null) forcedBrowser = browserArg.Split('=', 2)[1];
    else if (args.Any(a => string.Equals(a, "--chrome", StringComparison.OrdinalIgnoreCase))) forcedBrowser = "chrome";
    else if (args.Any(a => string.Equals(a, "--edge", StringComparison.OrdinalIgnoreCase))) forcedBrowser = "edge";
}

var isChrome = string.Equals(forcedBrowser, "chrome", StringComparison.OrdinalIgnoreCase) ||
               processName.Contains("chrome", StringComparison.OrdinalIgnoreCase);
var isEdge = string.Equals(forcedBrowser, "edge", StringComparison.OrdinalIgnoreCase) ||
             processName.Contains("edge", StringComparison.OrdinalIgnoreCase);
// A renamed host still has to pick a side; Edge is the historical default.
if (!isChrome && !isEdge) isEdge = true;

var browserKind = isChrome ? "chrome" : "edge";
var defaultPort = isChrome ? 9334 : 9333;
var configFileName = isChrome ? "chrome-bridge.json" : "edge-bridge.json";

var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
var rawHome = Environment.GetEnvironmentVariable("RAW_HOME");
if (string.IsNullOrWhiteSpace(rawHome)) rawHome = Path.Combine(home, ".raw");
var logPath = Path.Combine(rawHome, $"{browserKind}-bridge.log");

void Log(string message)
{
    if (string.Equals(Environment.GetEnvironmentVariable("RAW_BRIDGE_LOG"), "0", StringComparison.Ordinal)) return;
    try
    {
        Directory.CreateDirectory(rawHome);
        File.AppendAllText(logPath, $"{DateTimeOffset.Now:O} [{browserKind}] {message}{Environment.NewLine}");
    }
    catch
    {
        /* logging must never take the bridge down */
    }
}

var configPath = Environment.GetEnvironmentVariable("RAW_BRIDGE_CONFIG");
if (string.IsNullOrWhiteSpace(configPath)) configPath = Path.Combine(rawHome, configFileName);
if (!File.Exists(configPath))
{
    Log($"missing config {configPath}");
    return 2;
}

JsonObject? config;
try
{
    config = JsonNode.Parse(await File.ReadAllTextAsync(configPath))?.AsObject();
}
catch (Exception error)
{
    Log($"invalid config {configPath}: {error.Message}");
    return 2;
}
var token = config?["token"]?.GetValue<string>();
if (string.IsNullOrWhiteSpace(token))
{
    Log($"config {configPath} has no token");
    return 2;
}
var port = config?["port"]?.GetValue<int>() ?? defaultPort;

// Reloading the extension starts a fresh host while the previous instance can
// still be holding the port. Only retire hosts for the same browser: the Edge
// and Chrome builds have different process names so they never kill each other.
if (Console.IsInputRedirected)
{
    try
    {
        foreach (var stale in Process.GetProcessesByName(processName))
        {
            if (stale.Id == Environment.ProcessId) continue;
            try { stale.Kill(); stale.WaitForExit(2000); } catch { /* already gone */ }
        }
    }
    catch
    {
        // Process enumeration is best-effort; macOS and Linux may restrict it.
    }
}

// A retired instance releases the listening socket asynchronously. Binding too
// early throws, and the browser is then left with a host that died on startup,
// so wait for the port instead of racing the process that just let it go.
if (!await WaitForPortAsync(port, TimeSpan.FromSeconds(10)))
{
    Log($"port {port} is still in use after 10s");
    return 3;
}

var native = new NativeChannel(Console.OpenStandardInput(), Console.OpenStandardOutput(), Log);
var builder = WebApplication.CreateSlimBuilder(args);
builder.Logging.ClearProviders();
builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
var app = builder.Build();
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });

// Only loopback names are accepted, which blocks DNS-rebinding style access.
app.Use(async (context, next) =>
{
    var host = context.Request.Host.Host;
    if (!string.Equals(host, "127.0.0.1", StringComparison.Ordinal) &&
        !string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }
    await next();
});

bool Authorized(HttpContext context)
{
    var header = context.Request.Headers["X-Raw-Bridge-Token"].ToString();
    var query = context.Request.Query["token"].ToString();
    return (header.Length > 0 && FixedEquals(header, token!)) ||
           (query.Length > 0 && FixedEquals(query, token!));
}

var browserName = isChrome ? $"RawChromeBridge/{Version}" : $"RawEdgeBridge/{Version}";
var browserSlug = isChrome ? "raw-chrome" : "raw-edge";

app.MapGet("/json/version", (HttpContext context) =>
{
    if (!Authorized(context)) return Results.Unauthorized();
    return Results.Json(new JsonObject {
        ["Browser"] = browserName,
        ["Protocol-Version"] = "1.3",
        ["Raw-Extension-Version"] = native.ExtensionVersion,
        ["User-Agent"] = native.ExtensionUserAgent ?? "",
        ["V8-Version"] = "",
        ["WebKit-Version"] = "",
        ["webSocketDebuggerUrl"] = $"ws://127.0.0.1:{port}/devtools/browser/{browserSlug}?token={Uri.EscapeDataString(token!)}",
    });
});

app.MapGet("/json/protocol", (HttpContext context) =>
{
    if (!Authorized(context)) return Results.Unauthorized();
    return Results.Json(new JsonObject {
        ["version"] = new JsonObject { ["major"] = "1", ["minor"] = "3" },
        ["domains"] = new JsonArray(),
    });
});

app.MapGet("/json/list", async (HttpContext context) =>
{
    if (!Authorized(context)) return Results.Unauthorized();
    var result = await native.RequestAsync("listTabs", new JsonObject());
    var targets = new JsonArray();
    foreach (var tab in result?.AsArray() ?? [])
    {
        if (tab is null) continue;
        var id = tab["id"]?.GetValue<string>() ?? "";
        targets.Add(new JsonObject {
            ["id"] = id,
            ["type"] = "page",
            ["title"] = tab["title"]?.DeepClone(),
            ["url"] = tab["url"]?.DeepClone(),
            ["active"] = tab["active"]?.DeepClone(),
            ["discarded"] = tab["discarded"]?.DeepClone(),
            ["status"] = tab["status"]?.DeepClone(),
            ["windowId"] = tab["windowId"]?.DeepClone(),
            ["faviconUrl"] = tab["favIconUrl"]?.DeepClone(),
            ["devtoolsFrontendUrl"] = "",
            ["webSocketDebuggerUrl"] = $"ws://127.0.0.1:{port}/devtools/page/{id}?token={Uri.EscapeDataString(token!)}",
        });
    }
    return Results.Json(targets);
});

app.MapMethods("/json/new", ["GET", "PUT"], async (HttpContext context) =>
{
    if (!Authorized(context)) return Results.Unauthorized();
    var raw = context.Request.QueryString.Value?.TrimStart('?') ?? "about%3Ablank";
    var url = Uri.UnescapeDataString(raw);
    var active = !string.Equals(context.Request.Headers["X-Raw-Tab-Active"], "0", StringComparison.Ordinal);
    var tab = await native.RequestAsync("createTab", new JsonObject { ["url"] = url, ["active"] = active });
    var id = tab?["id"]?.GetValue<string>() ?? throw new InvalidOperationException("extension returned no tab id");
    return Results.Json(new {
        id,
        type = "page",
        title = tab?["title"]?.GetValue<string>() ?? "",
        url = tab?["url"]?.GetValue<string>() ?? url,
        webSocketDebuggerUrl = $"ws://127.0.0.1:{port}/devtools/page/{id}?token={Uri.EscapeDataString(token!)}",
    });
});

app.MapMethods("/json/close/{tabId}", ["GET", "PUT"], async (HttpContext context, string tabId) =>
{
    if (!Authorized(context)) return Results.Unauthorized();
    await native.RequestAsync("closeTab", new JsonObject { ["tabId"] = tabId });
    return Results.Text("Target is closing");
});

app.MapMethods("/json/activate/{tabId}", ["GET", "PUT"], async (HttpContext context, string tabId) =>
{
    if (!Authorized(context)) return Results.Unauthorized();
    await native.RequestAsync("activateTab", new JsonObject { ["tabId"] = tabId });
    return Results.Text("Target activated");
});

app.MapMethods("/json/restore", ["POST", "PUT"], async (HttpContext context) =>
{
    if (!Authorized(context)) return Results.Unauthorized();
    var result = await native.RequestAsync("restoreClosedTab", new JsonObject());
    return Results.Json(result);
});

app.Map("/devtools/page/{tabId}", async (HttpContext context, string tabId) =>
{
    if (!Authorized(context)) { context.Response.StatusCode = 401; return; }
    if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    var connection = native.AddPageSocket(tabId, socket);
    try { await PumpPageSocket(socket, connection, tabId, native); }
    finally { native.RemovePageSocket(connection); }
});

async Task HandleBrowserWebSocket(HttpContext context)
{
    if (!Authorized(context)) { context.Response.StatusCode = 401; return; }
    if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    var connection = native.AddBrowserSocket(socket);
    try { await PumpBrowserSocket(socket, connection, native); }
    finally { native.RemoveBrowserSocket(connection); }
}

app.Map("/devtools/browser/raw-edge", HandleBrowserWebSocket);
app.Map("/devtools/browser/raw-chrome", HandleBrowserWebSocket);

var readTask = Task.Run(async () =>
{
    try { await native.ReadLoopAsync(); }
    finally { app.Lifetime.StopApplication(); }
});
await app.RunAsync();
await readTask;
return 0;

static bool FixedEquals(string left, string right)
{
    var a = Encoding.UTF8.GetBytes(left);
    var b = Encoding.UTF8.GetBytes(right);
    return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
}

static async Task PumpPageSocket(WebSocket socket, Guid connection, string tabId, NativeChannel native)
{
    while (socket.State == WebSocketState.Open)
    {
        var message = await ReceiveJson(socket);
        if (message is null) break;
        var id = message["id"]?.DeepClone();
        var method = message["method"]?.GetValue<string>();
        if (id is null || string.IsNullOrEmpty(method)) continue;
        var timeoutMs = message["timeoutMs"]?.GetValue<int>() ?? 60_000;
        try
        {
            var parameters = message["params"]?.DeepClone() ?? new JsonObject();
            var result = method.StartsWith("Target.", StringComparison.Ordinal) ||
                method.StartsWith("Browser.", StringComparison.Ordinal)
                ? await native.BrowserRequestAsync(method, parameters, tabId: tabId, timeoutMs: timeoutMs)
                : await native.RequestAsync("cdp", new JsonObject {
                    ["tabId"] = tabId,
                    ["method"] = method,
                    ["params"] = parameters,
                    ["timeoutMs"] = timeoutMs,
                }, timeoutMs);
            native.SendPage(connection, new JsonObject { ["id"] = id, ["result"] = result?.DeepClone() ?? new JsonObject() });
        }
        catch (Exception error)
        {
            native.SendPage(connection, ErrorReply(id, error.Message));
        }
    }
}

static async Task PumpBrowserSocket(WebSocket socket, Guid connection, NativeChannel native)
{
    while (socket.State == WebSocketState.Open)
    {
        var message = await ReceiveJson(socket);
        if (message is null) break;
        var id = message["id"]?.DeepClone();
        var method = message["method"]?.GetValue<string>();
        if (id is null || string.IsNullOrEmpty(method)) continue;
        var timeoutMs = message["timeoutMs"]?.GetValue<int>() ?? 60_000;
        try
        {
            var sessionId = message["sessionId"]?.GetValue<string>();
            var payload = new JsonObject {
                ["method"] = method,
                ["params"] = message["params"]?.DeepClone() ?? new JsonObject(),
                ["timeoutMs"] = timeoutMs,
            };
            if (!string.IsNullOrEmpty(sessionId)) payload["sessionId"] = sessionId;
            var result = string.IsNullOrEmpty(sessionId)
                ? await native.BrowserRequestAsync(method, payload["params"]?.DeepClone() ?? new JsonObject(), timeoutMs: timeoutMs)
                : await native.RequestAsync("cdp", payload, timeoutMs);
            result ??= new JsonObject();
            native.SendBrowser(connection, new JsonObject { ["id"] = id, ["result"] = result });
        }
        catch (Exception error)
        {
            native.SendBrowser(connection, ErrorReply(id, error.Message));
        }
    }
}

static JsonObject ErrorReply(JsonNode id, string message) => new() {
    ["id"] = id,
    ["error"] = new JsonObject { ["code"] = -32000, ["message"] = message },
};

static async Task<bool> WaitForPortAsync(int port, TimeSpan timeout)
{
    var deadline = DateTime.UtcNow + timeout;
    while (true)
    {
        var probe = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, port);
        try
        {
            probe.Start();
            probe.Stop();
            return true;
        }
        catch (System.Net.Sockets.SocketException)
        {
            if (DateTime.UtcNow >= deadline) return false;
            await Task.Delay(150);
        }
    }
}

static async Task<JsonObject?> ReceiveJson(WebSocket socket)
{
    using var stream = new MemoryStream();
    var buffer = new byte[64 * 1024];
    while (true)
    {
        var read = await socket.ReceiveAsync(buffer, CancellationToken.None);
        if (read.MessageType == WebSocketMessageType.Close) return null;
        stream.Write(buffer, 0, read.Count);
        if (stream.Length > 64 * 1024 * 1024) throw new InvalidOperationException("bridge message exceeded 64 MB");
        if (read.EndOfMessage) break;
    }
    return JsonNode.Parse(stream.ToArray())?.AsObject();
}

sealed class SocketRegistration(string? tabId, WebSocket socket)
{
    public string? TabId { get; } = tabId;
    public WebSocket Socket { get; } = socket;
    public Channel<string> Outbox { get; } = Channel.CreateBounded<string>(
        new BoundedChannelOptions(2048)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });
}

sealed class NativeChannel(Stream input, Stream output, Action<string> log)
{
    readonly ConcurrentDictionary<string, TaskCompletionSource<JsonNode?>> pending = new();
    readonly ConcurrentDictionary<Guid, SocketRegistration> pageSockets = new();
    readonly ConcurrentDictionary<Guid, SocketRegistration> browserSockets = new();
    readonly SemaphoreSlim outputLock = new(1, 1);
    public string? ExtensionVersion { get; private set; }
    public string? ExtensionUserAgent { get; private set; }
    public string? ExtensionProtocol { get; private set; }

    public Guid AddPageSocket(string tabId, WebSocket socket) => Add(pageSockets, new SocketRegistration(tabId, socket));
    public void RemovePageSocket(Guid id) => Remove(pageSockets, id);
    public Guid AddBrowserSocket(WebSocket socket) => Add(browserSockets, new SocketRegistration(null, socket));
    public void RemoveBrowserSocket(Guid id) => Remove(browserSockets, id);

    Guid Add(ConcurrentDictionary<Guid, SocketRegistration> sockets, SocketRegistration registration)
    {
        var id = Guid.NewGuid();
        sockets[id] = registration;
        _ = PumpAsync(registration);
        return id;
    }

    static void Remove(ConcurrentDictionary<Guid, SocketRegistration> sockets, Guid id)
    {
        if (sockets.TryRemove(id, out var registration)) registration.Outbox.Writer.TryComplete();
    }

    static async Task PumpAsync(SocketRegistration registration)
    {
        await foreach (var text in registration.Outbox.Reader.ReadAllAsync())
        {
            if (registration.Socket.State != WebSocketState.Open) break;
            var bytes = Encoding.UTF8.GetBytes(text);
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            try
            {
                await registration.Socket.SendAsync(bytes, WebSocketMessageType.Text, true, cts.Token);
            }
            catch
            {
                break;
            }
        }
        registration.Outbox.Writer.TryComplete();
    }

    static void Enqueue(IEnumerable<SocketRegistration> registrations, JsonNode message)
    {
        // Serialize once before fan-out: JsonNode is not thread-safe, and one
        // string per broadcast is cheaper than one tree per socket.
        var text = message.ToJsonString();
        foreach (var registration in registrations.ToArray())
        {
            // A slow client can only lose its own events, never stall the
            // native read loop or another socket.
            registration.Outbox.Writer.TryWrite(text);
        }
    }

    public void SendPage(Guid id, JsonNode message)
    {
        if (pageSockets.TryGetValue(id, out var registration)) registration.Outbox.Writer.TryWrite(message.ToJsonString());
    }

    public void SendBrowser(Guid id, JsonNode message)
    {
        if (browserSockets.TryGetValue(id, out var registration)) registration.Outbox.Writer.TryWrite(message.ToJsonString());
    }

    public async Task<JsonNode?> RequestAsync(string op, JsonObject payload, int timeoutMs = 30_000)
    {
        var requestId = Guid.NewGuid().ToString("N");
        var completion = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[requestId] = completion;
        await SendNativeAsync(new JsonObject {
            ["kind"] = "request", ["requestId"] = requestId, ["op"] = op, ["payload"] = payload,
        });
        try { return await completion.Task.WaitAsync(TimeSpan.FromMilliseconds(timeoutMs)); }
        finally { pending.TryRemove(requestId, out _); }
    }

    public async Task<JsonNode?> BrowserRequestAsync(string method, JsonNode parameters, string? tabId = null, int timeoutMs = 60_000)
    {
        var payload = new JsonObject {
            ["method"] = method,
            ["params"] = parameters.DeepClone(),
            ["timeoutMs"] = timeoutMs,
        };
        if (!string.IsNullOrEmpty(tabId)) payload["tabId"] = tabId;
        try
        {
            return await RequestAsync("browserCdp", payload, timeoutMs);
        }
        catch (InvalidOperationException error) when (error.Message.Contains("unsupported bridge operation: browserCdp", StringComparison.Ordinal)) {
            return await LegacyBrowserRequestAsync(method, parameters, tabId);
        }
    }

    async Task<JsonNode?> LegacyBrowserRequestAsync(string method, JsonNode parameters, string? tabId)
    {
        var args = parameters.AsObject();
        switch (method)
        {
            case "Target.createTarget": {
                var tab = await RequestAsync("createTab", new JsonObject {
                    ["url"] = args["url"]?.GetValue<string>() ?? "about:blank",
                    ["active"] = args["background"]?.GetValue<bool>() != true,
                });
                return new JsonObject { ["targetId"] = tab?["id"]?.DeepClone() };
            }
            case "Target.closeTarget":
                await RequestAsync("closeTab", new JsonObject { ["tabId"] = args["targetId"]?.DeepClone() ?? tabId });
                return new JsonObject { ["success"] = true };
            case "Target.activateTarget":
                await RequestAsync("activateTab", new JsonObject { ["tabId"] = args["targetId"]?.DeepClone() ?? tabId });
                return new JsonObject();
            case "Target.attachToTarget": {
                var targetId = args["targetId"]?.GetValue<string>() ?? tabId ?? throw new InvalidOperationException("Target.attachToTarget requires targetId");
                return new JsonObject { ["sessionId"] = $"raw-edge-tab-{targetId}" };
            }
            case "Target.detachFromTarget":
            case "Target.setDiscoverTargets":
            case "Target.setAutoAttach":
            case "Target.setRemoteLocations":
            case "Target.disposeBrowserContext":
            case "Browser.setDownloadBehavior":
                return new JsonObject();
            case "Target.getBrowserContexts":
                return new JsonObject { ["browserContextIds"] = new JsonArray() };
            case "Target.createBrowserContext":
                throw new InvalidOperationException("isolated browser contexts are unavailable in extension mode");
            case "Browser.getVersion":
                return new JsonObject { ["product"] = "RawBridge/legacy-extension", ["protocolVersion"] = "1.3" };
            case "Target.getTargets": {
                var tabs = await RequestAsync("listTabs", new JsonObject());
                var infos = new JsonArray();
                foreach (var tab in tabs?.AsArray() ?? [])
                {
                    if (tab is null) continue;
                    infos.Add(new JsonObject {
                        ["targetId"] = tab["id"]?.DeepClone(),
                        ["type"] = "page",
                        ["title"] = tab["title"]?.DeepClone(),
                        ["url"] = tab["url"]?.DeepClone(),
                        ["attached"] = false,
                    });
                }
                return new JsonObject { ["targetInfos"] = infos };
            }
            case "Target.getTargetInfo": {
                var wanted = args["targetId"]?.GetValue<string>() ?? tabId;
                var tabs = await RequestAsync("listTabs", new JsonObject());
                var tab = tabs?.AsArray().FirstOrDefault(item => item?["id"]?.GetValue<string>() == wanted)
                    ?? throw new InvalidOperationException($"No tab with id: {wanted}");
                return new JsonObject { ["targetInfo"] = new JsonObject {
                    ["targetId"] = tab["id"]?.DeepClone(),
                    ["type"] = "page",
                    ["title"] = tab["title"]?.DeepClone(),
                    ["url"] = tab["url"]?.DeepClone(),
                    ["attached"] = false,
                } };
            }
            default: {
                var selected = tabId;
                if (string.IsNullOrEmpty(selected)) {
                    var tabs = await RequestAsync("listTabs", new JsonObject());
                    selected = tabs?.AsArray().FirstOrDefault(tab => tab?["active"]?.GetValue<bool>() == true)?["id"]?.GetValue<string>()
                        ?? tabs?.AsArray().FirstOrDefault()?["id"]?.GetValue<string>();
                }
                if (string.IsNullOrEmpty(selected)) throw new InvalidOperationException("browser has no tab target available for this CDP command");
                return await RequestAsync("cdp", new JsonObject {
                    ["tabId"] = selected,
                    ["method"] = method,
                    ["params"] = parameters.DeepClone(),
                });
            }
        }
    }

    public async Task ReadLoopAsync()
    {
        var sizeBytes = new byte[4];
        while (await ReadExactlyOrEof(input, sizeBytes)) {
            var length = BitConverter.ToInt32(sizeBytes, 0);
            if (length <= 0 || length > 64 * 1024 * 1024) throw new InvalidOperationException("invalid native message length");
            var payload = new byte[length];
            if (!await ReadExactlyOrEof(input, payload)) break;
            var message = JsonNode.Parse(payload)?.AsObject();
            if (message is null) continue;
            var kind = message["kind"]?.GetValue<string>();
            if (kind == "hello") {
                ExtensionVersion = message["version"]?.GetValue<string>();
                ExtensionUserAgent = message["userAgent"]?.GetValue<string>();
                ExtensionProtocol = message["protocolVersion"]?.GetValue<string>();
                log($"extension hello version={ExtensionVersion} protocol={ExtensionProtocol}");
                if (!string.IsNullOrEmpty(ExtensionProtocol) && ExtensionProtocol != "1")
                {
                    log($"extension protocol {ExtensionProtocol} differs from host protocol 1");
                }
            } else if (kind == "response") {
                var requestId = message["requestId"]?.GetValue<string>();
                if (requestId is not null && pending.TryRemove(requestId, out var completion)) {
                    if (message["ok"]?.GetValue<bool>() == true) completion.TrySetResult(message["result"]?.DeepClone());
                    else completion.TrySetException(new InvalidOperationException(message["error"]?.GetValue<string>() ?? "extension request failed"));
                }
            } else if (kind == "event") {
                var tabId = message["tabId"]?.ToString();
                var sessionId = message["sessionId"]?.ToString();
                var eventPayload = new JsonObject {
                    ["method"] = message["method"]?.DeepClone(),
                    ["params"] = message["params"]?.DeepClone() ?? new JsonObject(),
                };
                if (!string.IsNullOrEmpty(tabId)) {
                    Enqueue(pageSockets.Values.Where(s => s.TabId == tabId), eventPayload);
                }
                if (!string.IsNullOrEmpty(sessionId)) {
                    var browserPayload = eventPayload.DeepClone().AsObject();
                    browserPayload["sessionId"] = sessionId;
                    Enqueue(browserSockets.Values, browserPayload);
                }
            } else if (kind == "browserEvent") {
                Enqueue(browserSockets.Values, new JsonObject {
                    ["method"] = message["method"]?.DeepClone(), ["params"] = message["params"]?.DeepClone() ?? new JsonObject(),
                });
            } else if (kind == "browserSessionEvent") {
                Enqueue(browserSockets.Values, new JsonObject {
                    ["sessionId"] = message["sessionId"]?.DeepClone(),
                    ["method"] = message["method"]?.DeepClone(),
                    ["params"] = message["params"]?.DeepClone() ?? new JsonObject(),
                });
            } else if (kind == "bridgeWarning") {
                var warning = message["message"]?.GetValue<string>() ?? "unknown bridge warning";
                log($"extension warning: {warning}");
                Enqueue(browserSockets.Values, new JsonObject {
                    ["method"] = "Raw.bridgeWarning",
                    ["params"] = new JsonObject { ["message"] = warning },
                });
            }
        }
    }

    async Task SendNativeAsync(JsonNode value)
    {
        var payload = Encoding.UTF8.GetBytes(value.ToJsonString());
        var size = BitConverter.GetBytes(payload.Length);
        await outputLock.WaitAsync();
        try
        {
            await output.WriteAsync(size);
            await output.WriteAsync(payload);
            await output.FlushAsync();
        }
        finally { outputLock.Release(); }
    }

    static async Task<bool> ReadExactlyOrEof(Stream stream, byte[] buffer)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var count = await stream.ReadAsync(buffer.AsMemory(offset));
            if (count == 0) return false;
            offset += count;
        }
        return true;
    }
}
