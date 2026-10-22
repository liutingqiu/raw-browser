const HOST = "com.raw.edge_bridge";
const KEEPALIVE_ALARM = "raw-bridge-keepalive";
importScripts("bridge-core.js");

let nativePort;
let reconnectTimer;
let reconnectDelay = 1000;
let paused = false;
const bridge = RawEdgeBridgeCore.createBridgeExecutor(chrome);

/**
 * Exactly one native port per service worker. A second connectNative call while
 * a port is still open starts a second host process, and every fresh host
 * retires the previous one, so the two ends would kill each other in a loop and
 * the bridge port would flap instead of serving requests.
 */
function post(message) {
  if (!nativePort) {
    scheduleReconnect();
    return;
  }
  try {
    nativePort.postMessage(message);
  } catch {
    const broken = nativePort;
    dropPort(broken);
    scheduleReconnect();
  }
}

function dropPort(port) {
  if (nativePort !== port) return;
  nativePort = undefined;
  try {
    port.disconnect();
  } catch {
    // already gone
  }
}

function scheduleReconnect() {
  if (paused || reconnectTimer) return;
  const delay = reconnectDelay;
  // Exponential backoff: a missing or crashing host used to be relaunched
  // once per second forever.
  reconnectDelay = Math.min(Math.round(reconnectDelay * 1.8), 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay + Math.floor(Math.random() * 250));
}

function connect() {
  if (paused || nativePort) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  let port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    scheduleReconnect();
    return;
  }
  nativePort = port;
  port.onMessage.addListener(handleNativeMessage);
  port.onDisconnect.addListener(() => {
    dropPort(port);
    scheduleReconnect();
  });
  // A port that survives this long did reach a working host; failures that
  // happen immediately keep backing off.
  setTimeout(() => {
    if (nativePort === port) reconnectDelay = 1000;
  }, 5000);
  post({
    kind: "hello",
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    protocolVersion: "1",
    userAgent: navigator.userAgent,
  });
}

// The host process only lives while a native port is open, and an idle service
// worker is torn down after a few minutes, which takes the port down with it.
// A short alarm keeps both ends resident so the bridge stays reachable.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  connect();
});

async function handleNativeMessage(message) {
  if (message?.kind !== "request" || typeof message.requestId !== "string") return;
  try {
    const result = await bridge.execute(message);
    post({ kind: "response", requestId: message.requestId, ok: true, result: result ?? {} });
    try {
      await emitLifecycleEvents(message);
    } catch (error) {
      post({ kind: "bridgeWarning", message: String(error?.message ?? error) });
    }
  } catch (error) {
    post({
      kind: "response",
      requestId: message.requestId,
      ok: false,
      error: String(error?.message ?? error),
    });
  }
}

/**
 * Target discovery/auto-attach also apply to tabs that were already open when
 * the client asked. Real CDP delivers those as lifecycle events; without this
 * a browser-level client sees an empty target list until the next tab opens.
 */
async function emitLifecycleEvents(message) {
  const method = message.payload?.method;
  const params = message.payload?.params ?? {};
  if (method === "Target.setDiscoverTargets" && params.discover === true) {
    const tabs = await bridge.execute({ op: "listTabs", payload: {} });
    for (const tab of tabs ?? []) {
      post({ kind: "browserEvent", method: "Target.targetCreated", params: { targetInfo: RawEdgeBridgeCore.targetInfo(tab) } });
    }
  }
  if (method === "Target.setAutoAttach" && params.autoAttach === true) {
    const tabs = await bridge.execute({ op: "listTabs", payload: {} });
    for (const tab of tabs ?? []) {
      try {
        await bridge.ensureAttached(tab.id);
        post({
          kind: "browserEvent",
          method: "Target.attachedToTarget",
          params: {
            sessionId: RawEdgeBridgeCore.sessionIdFor(tab.id),
            targetInfo: { ...RawEdgeBridgeCore.targetInfo(tab), attached: true },
            waitingForDebugger: false,
          },
        });
      } catch (error) {
        post({ kind: "bridgeWarning", message: String(error?.message ?? error) });
      }
    }
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  // One frame carries both identities; the host fans it out to page and
  // browser sockets. The old version sent the same payload twice.
  post({
    kind: "event",
    tabId: source.tabId,
    sessionId: RawEdgeBridgeCore.sessionIdFor(source.tabId),
    method,
    params: params ?? {},
  });
});

chrome.debugger.onDetach.addListener((source) => {
  if (!source.tabId) return;
  bridge.noteDetached(source.tabId);
  post({
    kind: "browserEvent",
    method: "Target.detachedFromTarget",
    params: {
      sessionId: RawEdgeBridgeCore.sessionIdFor(source.tabId),
      targetId: String(source.tabId),
      reason: source.reason,
    },
  });
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (bridge.shouldEmitTargetEvents()) {
    post({ kind: "browserEvent", method: "Target.targetCreated", params: { targetInfo: RawEdgeBridgeCore.targetInfo(tab) } });
  }
  if (bridge.shouldAutoAttach()) {
    try {
      await bridge.ensureAttached(tab.id);
      post({
        kind: "browserEvent",
        method: "Target.attachedToTarget",
        params: {
          sessionId: RawEdgeBridgeCore.sessionIdFor(tab.id),
          targetInfo: { ...RawEdgeBridgeCore.targetInfo(tab), attached: true },
          waitingForDebugger: false,
        },
      });
    } catch (error) {
      post({ kind: "bridgeWarning", message: String(error?.message ?? error) });
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, _change, tab) => {
  if (!bridge.shouldEmitTargetEvents()) return;
  post({ kind: "browserEvent", method: "Target.targetInfoChanged", params: { targetInfo: RawEdgeBridgeCore.targetInfo(tab) } });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  bridge.noteDetached(tabId);
  if (!bridge.shouldEmitTargetEvents()) return;
  post({ kind: "browserEvent", method: "Target.targetDestroyed", params: { targetId: String(tabId) } });
});

chrome.downloads.onCreated.addListener((item) => {
  post({
    kind: "browserEvent",
    method: "Browser.downloadWillBegin",
    params: {
      guid: String(item.id),
      url: item.url ?? "",
      suggestedFilename: (item.filename ?? "download").split(/[\\/]/).pop(),
    },
  });
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state && !delta.bytesReceived && !delta.filename) return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item) return;
  post({
    kind: "browserEvent",
    method: "Browser.downloadProgress",
    params: {
      guid: String(item.id),
      state: item.state === "complete" ? "completed" : item.state === "interrupted" ? "canceled" : "inProgress",
      receivedBytes: item.bytesReceived ?? 0,
      totalBytes: item.totalBytes ?? 0,
      filePath: item.filename,
    },
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "raw-status") {
    sendResponse({
      connected: Boolean(nativePort),
      paused,
      version: chrome.runtime.getManifest().version,
      protocolVersion: "1",
      browser: navigator.userAgent,
    });
    return;
  }
  if (message?.type === "raw-disconnect") {
    paused = true;
    chrome.storage.local.set({ paused: true });
    if (nativePort) dropPort(nativePort);
    sendResponse({ ok: true, paused });
    return;
  }
  if (message?.type === "raw-reconnect") {
    paused = false;
    chrome.storage.local.set({ paused: false });
    connect();
    sendResponse({ ok: true, paused });
  }
});

function bootstrap() {
  chrome.storage.local.get({ paused: false }, (state) => {
    paused = state.paused === true;
    if (!paused) connect();
  });
}

chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup.addListener(bootstrap);
bootstrap();
