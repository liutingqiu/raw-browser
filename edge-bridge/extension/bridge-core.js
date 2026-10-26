(function installRawEdgeBridgeCore(root) {
  const SESSION_PREFIX = "raw-edge-tab-";

  function tabIdFrom(value) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    const text = String(value ?? "");
    const normalized = text.startsWith(SESSION_PREFIX) ? text.slice(SESSION_PREFIX.length) : text;
    const tabId = Number(normalized);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error(`invalid Edge tab id: ${text}`);
    return tabId;
  }

  function sessionIdFor(tabId) {
    return `${SESSION_PREFIX}${tabIdFrom(tabId)}`;
  }

  function serializableTab(tab) {
    return {
      id: String(tab.id),
      title: tab.title ?? "",
      url: tab.url ?? tab.pendingUrl ?? "about:blank",
      active: tab.active === true,
      discarded: tab.discarded === true,
      status: tab.status ?? "complete",
      windowId: tab.windowId,
      favIconUrl: tab.favIconUrl ?? "",
    };
  }

  function targetInfo(tab) {
    const value = serializableTab(tab);
    return {
      targetId: value.id,
      type: "page",
      title: value.title,
      url: value.url,
      active: value.active,
      discarded: value.discarded,
      attached: false,
      canAccessOpener: true,
      browserContextId: "",
    };
  }

  function windowBounds(win) {
    return {
      left: win.left,
      top: win.top,
      width: win.width,
      height: win.height,
      windowState: win.state ?? "normal",
    };
  }

  const AGENT_GLOW_ID = "raw-agent-glow";
  const AGENT_GLOW_IDLE_MS = 12_000;
  const AGENT_GLOW_CSS = `
#raw-agent-glow {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483647;
  border: 4px solid transparent;
  border-image: linear-gradient(125deg, #5b86ff 0%, #a17bff 35%, #8fe0ff 65%, #5b86ff 100%) 1;
  box-shadow:
    inset 0 0 0 1px rgba(160, 195, 255, .90),
    inset 0 0 28px rgba(90, 140, 255, .65),
    inset 0 0 90px rgba(125, 95, 255, .35);
  animation: raw-agent-glow-breathe 3.8s ease-in-out infinite;
  opacity: 1;
  transition: opacity .45s ease;
}
#raw-agent-glow.raw-glow-out {
  opacity: 0;
  animation: none;
}
#raw-agent-glow::after {
  content: "raw controlling";
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(13, 15, 19, .82);
  color: #dfe8ff;
  font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: .04em;
  border: 1px solid rgba(140, 175, 255, .45);
  box-shadow: 0 0 22px rgba(90, 140, 255, .45);
  backdrop-filter: blur(8px);
}
@keyframes raw-agent-glow-breathe {
  0%, 100% { opacity: .55; }
  50% { opacity: .95; }
}
`;

  // Injected into the page with chrome.scripting.executeScript, so it must be
  // self-contained: no references to extension-scope helpers.
  function agentGlowShow(id, idleMs) {
    const remove = (node) => {
      clearTimeout(node.__rawGlowTimer);
      node.classList.add("raw-glow-out");
      setTimeout(() => node.remove(), 450);
    };
    const existing = document.getElementById(id);
    if (existing) {
      existing.classList.remove("raw-glow-out");
      clearTimeout(existing.__rawGlowTimer);
      existing.__rawGlowTimer = setTimeout(() => remove(existing), idleMs);
      return;
    }
    const node = document.createElement("div");
    node.id = id;
    node.className = "raw-glow";
    node.__rawGlowTimer = setTimeout(() => remove(node), idleMs);
    (document.documentElement ?? document.body).appendChild(node);
  }

  function agentGlowHide(id) {
    const node = document.getElementById(id);
    if (!node) return;
    clearTimeout(node.__rawGlowTimer);
    node.classList.add("raw-glow-out");
    setTimeout(() => node.remove(), 450);
  }

  function createBridgeExecutor(chromeApi) {
    const attachedTabs = new Set();
    const attachingTabs = new Map();
    const glowCssTabs = new Set();
    let discoverTargets = false;
    let autoAttachTargets = false;

    async function ensureAttached(value) {
      const tabId = tabIdFrom(value);
      if (attachedTabs.has(tabId)) return tabId;
      const pending = attachingTabs.get(tabId);
      if (pending) return pending;
      const attaching = (async () => {
        try {
          await Promise.race([
            chromeApi.debugger.attach({ tabId }, "1.3"),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`debugger attach timed out on tab ${tabId}`)), 5000))
          ]);
        } catch (error) {
          const message = String(error?.message ?? error);
          if (/another debugger is already attached/i.test(message)) {
            // It may be our own attachment left behind by a previous service
            // worker lifetime. Detach (which only affects this extension) and
            // make one clean attempt before blaming someone else.
            try {
              await chromeApi.debugger.detach({ tabId });
              await chromeApi.debugger.attach({ tabId }, "1.3");
              attachedTabs.add(tabId);
              return tabId;
            } catch {
              attachedTabs.delete(tabId);
              throw new Error(`another debugger is already attached to tab ${tabId}; close DevTools or the other extension and retry`);
            }
          }
          if (!/already attached/i.test(message)) throw error;
        }
        attachedTabs.add(tabId);
        return tabId;
      })();
      attachingTabs.set(tabId, attaching);
      try {
        return await attaching;
      } finally {
        attachingTabs.delete(tabId);
      }
    }

    async function showGlow(tabId) {
      if (!attachedTabs.has(tabId)) return;
      if (!chromeApi.scripting?.insertCSS || !chromeApi.scripting?.executeScript) return;
      try {
        if (!glowCssTabs.has(tabId)) {
          await chromeApi.scripting.insertCSS({
            target: { tabId, allFrames: false },
            css: AGENT_GLOW_CSS,
          });
          glowCssTabs.add(tabId);
        }
        await chromeApi.scripting.executeScript({
          target: { tabId },
          func: agentGlowShow,
          args: [AGENT_GLOW_ID, AGENT_GLOW_IDLE_MS],
        });
      } catch {
        // Restricted pages and tabs that close mid-command cannot host the overlay.
      }
    }

    async function hideGlow(tabId) {
      glowCssTabs.delete(tabId);
      if (!chromeApi.scripting?.executeScript) return;
      try {
        await chromeApi.scripting.executeScript({
          target: { tabId },
          func: agentGlowHide,
          args: [AGENT_GLOW_ID],
        });
      } catch {
        // The tab may already be gone.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await chromeApi.scripting.removeCSS?.({
          target: { tabId, allFrames: false },
          css: AGENT_GLOW_CSS,
        });
      } catch {
        // The tab may already be gone.
      }
    }

    async function detach(value) {
      const tabId = tabIdFrom(value);
      const wasAttached = attachedTabs.delete(tabId);
      await hideGlow(tabId);
      if (wasAttached) await chromeApi.debugger.detach({ tabId });
    }

    async function listTabs() {
      return (await chromeApi.tabs.query({})).map(serializableTab);
    }

    async function tabFor(params = {}, required = true) {
      const raw = params.tabId ?? params.targetId ?? params.sessionId;
      if (raw !== undefined && raw !== null && raw !== "") return await chromeApi.tabs.get(tabIdFrom(raw));
      const [active] = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
      const fallback = active ?? (await chromeApi.tabs.query({}))[0];
      if (!fallback && required) throw new Error("Edge has no tab target available for this CDP command");
      return fallback;
    }

    async function sendTabCommand(payload) {
      const tab = await tabFor(payload);
      const tabId = await ensureAttached(tab.id);
      await showGlow(tabId);

      const timeoutMs = typeof payload.timeoutMs === "number" ? payload.timeoutMs : 30_000;
      return await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`CDP ${payload.method} timed out on tab ${tabId} after ${timeoutMs}ms (tab may be sleeping or unresponsive)`));
          }
        }, timeoutMs);

        chromeApi.debugger.sendCommand({ tabId }, payload.method, payload.params ?? {})
          .then((res) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              void showGlow(tabId);
              resolve(res);
            }
          })
          .catch((err) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              void showGlow(tabId);
              reject(err);
            }
          });
      });
    }

    async function activate(value) {
      const tab = await chromeApi.tabs.get(tabIdFrom(value));
      await chromeApi.tabs.update(tab.id, { active: true });
      await chromeApi.windows.update(tab.windowId, { focused: true });
    }

    /** cookies carry a lot of noise; keep the fields a caller can act on */
    function cookieView(cookie) {
      if (!cookie) return null;
      return {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure === true,
        httpOnly: cookie.httpOnly === true,
        session: cookie.session === true,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expirationDate,
        storeId: cookie.storeId,
      };
    }

    async function browserCommand(payload) {
      const method = String(payload.method ?? "");
      const params = payload.params ?? {};
      switch (method) {
        case "Target.getTargets": {
          const tabs = await chromeApi.tabs.query({});
          return { targetInfos: tabs.map((tab) => ({ ...targetInfo(tab), attached: attachedTabs.has(tab.id) })) };
        }
        case "Target.getTargetInfo": {
          const tab = await tabFor(params);
          return { targetInfo: { ...targetInfo(tab), attached: attachedTabs.has(tab.id) } };
        }
        case "Target.createTarget": {
          if (params.browserContextId) {
            throw new Error("isolated browser contexts are unavailable in extension mode");
          }
          const tab = await chromeApi.tabs.create({ url: params.url || "about:blank", active: params.background !== true });
          return { targetId: String(tab.id) };
        }
        case "Target.closeTarget": {
          const explicit = params.targetId ?? params.tabId ?? params.sessionId;
          if (explicit === undefined || explicit === null || explicit === "") {
            throw new Error("Target.closeTarget requires targetId");
          }
          const tab = await chromeApi.tabs.get(tabIdFrom(explicit));
          await chromeApi.tabs.remove(tab.id);
          attachedTabs.delete(tab.id);
          glowCssTabs.delete(tab.id);
          return { success: true };
        }
        case "Target.activateTarget": {
          const tab = await tabFor(params);
          await activate(tab.id);
          return {};
        }
        case "Target.attachToTarget": {
          const tab = await tabFor(params);
          await ensureAttached(tab.id);
          return { sessionId: sessionIdFor(tab.id) };
        }
        case "Target.detachFromTarget": {
          const tab = await tabFor(params);
          await detach(tab.id);
          return {};
        }
        case "Target.setDiscoverTargets":
          discoverTargets = params.discover === true;
          return {};
        case "Target.setAutoAttach":
          autoAttachTargets = params.autoAttach === true;
          return {};
        case "Target.setRemoteLocations":
          return {};
        case "Target.getBrowserContexts":
          return { browserContextIds: [] };
        case "Target.createBrowserContext":
          throw new Error("isolated browser contexts are unavailable in extension mode");
        case "Target.disposeBrowserContext":
          return {};
        case "Browser.getVersion": {
          const brand = (root.navigator?.userAgentData?.brands ?? []).find((item) => /Edge|Chrome/i.test(item.brand));
          return {
            protocolVersion: "1.3",
            product: `${brand?.brand ?? "Chromium"}/${brand?.version ?? "extension"}`,
            revision: "",
            userAgent: root.navigator?.userAgent ?? "",
            jsVersion: "",
          };
        }
        case "Browser.getWindowForTarget": {
          const tab = await tabFor(params);
          const win = await chromeApi.windows.get(tab.windowId);
          return { windowId: win.id, bounds: windowBounds(win) };
        }
        case "Browser.getWindowBounds": {
          const win = await chromeApi.windows.get(Number(params.windowId));
          return { bounds: windowBounds(win) };
        }
        case "Browser.setWindowBounds": {
          const bounds = params.bounds ?? {};
          await chromeApi.windows.update(Number(params.windowId), {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
            state: bounds.windowState,
          });
          return {};
        }
        case "Browser.setDownloadBehavior":
          // Edge extensions cannot choose the profile's download directory.
          // Downloads still work; they land in the browser's configured
          // folder and are reported through Browser.download* events.
          return { supported: false };
        case "Browser.cancelDownload":
          await chromeApi.downloads.cancel(Number(params.guid));
          return {};
        case "Raw.restoreClosedTab": {
          const restored = await chromeApi.sessions.restore(params.sessionId);
          if (restored?.tab) return { tab: serializableTab(restored.tab) };
          if (restored?.window) {
            return {
              window: {
                id: restored.window.id,
                tabs: (restored.window.tabs ?? []).map(serializableTab),
              },
            };
          }
          return {};
        }
        /* ---------------------------------------------------------------- *
         * Extension-only capabilities.
         *
         * CDP has no equivalent for these: proxy configuration, browsing
         * data, history, bookmarks, extension management and system
         * notifications all sit above the debugging protocol. Ported from
         * reasonix-browser-bridge (MIT) so a single bridge covers both.
         * ---------------------------------------------------------------- */
        case "Raw.proxyGet": {
          const settings = await chromeApi.proxy.settings.get(params.incognito === true ? { incognito: true } : {});
          return { value: settings.value, levelOfControl: settings.levelOfControl };
        }
        case "Raw.proxySet": {
          const value = params.value;
          if (!value || typeof value !== "object" || typeof value.mode !== "string") {
            throw new Error(
              "Raw.proxySet needs a proxy value object, e.g. { mode: 'direct' } or { mode: 'fixed_servers', rules: { singleProxy: { host, port } } }",
            );
          }
          await chromeApi.proxy.settings.set({ value, scope: params.scope ?? "regular" });
          const applied = await chromeApi.proxy.settings.get({});
          return { ok: true, value: applied.value };
        }
        case "Raw.proxyClear": {
          await chromeApi.proxy.settings.clear({ scope: params.scope ?? "regular" });
          const applied = await chromeApi.proxy.settings.get({});
          return { ok: true, value: applied.value };
        }
        case "Raw.notify": {
          // notifications.create rejects a missing image, so resolve whatever
          // icon the manifest actually declares instead of a fixed path
          const declared = chromeApi.runtime.getManifest().icons ?? {};
          const icon = declared["128"] ?? declared["48"] ?? declared["32"] ?? declared["16"] ?? "icons/icon128.png";
          const id = await chromeApi.notifications.create({
            type: "basic",
            iconUrl: chromeApi.runtime.getURL(icon),
            title: String(params.title ?? "raw"),
            message: String(params.message ?? ""),
            silent: params.silent === true,
          });
          return { id };
        }
        case "Raw.historySearch": {
          const query = Object.assign({ text: "", maxResults: 100 }, params.query ?? {});
          const items = await chromeApi.history.search(query);
          return items.map((item) => ({
            url: item.url,
            title: item.title,
            lastVisitTime: item.lastVisitTime,
            visitCount: item.visitCount,
          }));
        }
        case "Raw.bookmarksList":
          return await chromeApi.bookmarks.getTree();
        case "Raw.managementList": {
          const items = await chromeApi.management.getAll();
          return items.map((item) => ({
            id: item.id,
            name: item.name,
            enabled: item.enabled,
            type: item.type,
            version: item.version,
            installType: item.installType,
          }));
        }
        case "Raw.clearBrowsingData": {
          const requested = params.dataTypes ?? {};
          const cleared = Object.keys(requested).filter((key) => requested[key] === true);
          // destructive: never remove anything the caller did not name
          if (cleared.length === 0) {
            throw new Error("Raw.clearBrowsingData requires at least one explicit dataTypes flag; it clears nothing by default");
          }
          const options = params.options ?? {};
          await chromeApi.browsingData.remove(options, requested);
          return { ok: true, cleared, options };
        }
        case "Raw.cookiesAll":
          return (await chromeApi.cookies.getAll(params.details ?? {})).map(cookieView);
        case "Raw.cookiesGet":
          return cookieView(await chromeApi.cookies.get(params.details ?? {}));
        case "Raw.cookiesSet": {
          const details = params.details ?? {};
          if (!details.url || !details.name) throw new Error("Raw.cookiesSet needs at least { url, name }");
          return cookieView(await chromeApi.cookies.set(details));
        }
        case "Raw.cookiesRemove": {
          const details = params.details ?? {};
          if (!details.url || !details.name) throw new Error("Raw.cookiesRemove needs { url, name }");
          return await chromeApi.cookies.remove(details);
        }
        case "Raw.updateTab": {
          const tab = await tabFor(params);
          const update = params.update ?? {};
          if (Object.keys(update).length === 0) {
            throw new Error("Raw.updateTab needs an update object, e.g. { pinned: true } or { muted: true }");
          }
          return serializableTab(await chromeApi.tabs.update(tab.id, update));
        }
        case "Raw.download": {
          const options = params.options ?? {};
          if (!options.url) throw new Error("Raw.download needs { url }");
          return { id: await chromeApi.downloads.download(options) };
        }
        case "Raw.cancelDownload": {
          if (params.id === undefined || params.id === null) throw new Error("Raw.cancelDownload needs a download id");
          await chromeApi.downloads.cancel(params.id);
          return { ok: true, id: params.id };
        }
        case "Raw.setExtensionEnabled": {
          if (!params.id) throw new Error("Raw.setExtensionEnabled needs an extension id");
          if (params.id === chromeApi.runtime.id) {
            throw new Error("refusing to disable the Raw Browser Bridge itself");
          }
          const enabled = params.enabled !== false;
          await chromeApi.management.setEnabled(params.id, enabled);
          return { ok: true, id: params.id, enabled };
        }
        case "Raw.frames": {
          const tab = await tabFor(params);
          const frames = await chromeApi.webNavigation.getAllFrames({ tabId: tab.id });
          return (frames ?? []).map((frame) => ({
            frameId: frame.frameId,
            parentFrameId: frame.parentFrameId,
            url: frame.url,
            errorOccurred: frame.errorOccurred === true,
          }));
        }
        case "Raw.insertCSS": {
          const tab = await tabFor(params);
          await chromeApi.scripting.insertCSS({
            target: { tabId: tab.id, allFrames: params.allFrames === true },
            css: String(params.css ?? ""),
          });
          return { ok: true, tabId: tab.id };
        }
        case "Raw.removeCSS": {
          const tab = await tabFor(params);
          await chromeApi.scripting.removeCSS({
            target: { tabId: tab.id, allFrames: params.allFrames === true },
            css: String(params.css ?? ""),
          });
          return { ok: true, tabId: tab.id };
        }
        case "Browser.close":
          // Standard Browser.close takes no confirmation and would close every
          // window in the user's real profile. Require an explicit opt-in.
          throw new Error("Browser.close is disabled in extension mode; call Raw.closeBrowser with { confirm: true } or close tabs individually");
        case "Raw.closeBrowser": {
          if (params.confirm !== true) {
            throw new Error("Raw.closeBrowser requires { confirm: true }");
          }
          const windows = await chromeApi.windows.getAll({ windowTypes: ["normal"] });
          for (const win of windows) await chromeApi.windows.remove(win.id);
          attachedTabs.clear();
          glowCssTabs.clear();
          return { ok: true, windows: windows.length };
        }
        default:
          // chrome.debugger exposes all protocol domains supported by the
          // attached Edge build. Forward without a technical allow/deny list;
          // the calling prompt remains the authority for permitted actions.
          return await sendTabCommand({ ...payload, params });
      }
    }

    async function execute(request) {
      const payload = request.payload ?? {};
      switch (request.op) {
        case "listTabs":
          return await listTabs();
        case "createTab":
          return serializableTab(await chromeApi.tabs.create({ url: payload.url || "about:blank", active: payload.active !== false }));
        case "closeTab": {
          const tabId = tabIdFrom(payload.tabId);
          await chromeApi.tabs.remove(tabId);
          attachedTabs.delete(tabId);
          glowCssTabs.delete(tabId);
          return {};
        }
        case "activateTab":
          await activate(payload.tabId);
          return {};
        case "restoreClosedTab":
          return await browserCommand({ method: "Raw.restoreClosedTab", params: payload });
        case "detachTab":
          await detach(payload.tabId);
          return {};
        case "cdp":
          return await sendTabCommand(payload);
        case "browserCdp":
          return await browserCommand(payload);
        default:
          throw new Error(`unsupported bridge operation: ${request.op}`);
      }
    }

    return {
      execute,
      ensureAttached,
      noteDetached(value) {
        const tabId = tabIdFrom(value);
        attachedTabs.delete(tabId);
        void hideGlow(tabId);
      },
      noteNavigated(value) {
        glowCssTabs.delete(tabIdFrom(value));
      },
      isAttached(value) {
        return attachedTabs.has(tabIdFrom(value));
      },
      shouldEmitTargetEvents() {
        return discoverTargets;
      },
      shouldAutoAttach() {
        return autoAttachTargets;
      },
    };
  }

  root.RawEdgeBridgeCore = { createBridgeExecutor, serializableTab, sessionIdFor, tabIdFrom, targetInfo };
})(globalThis);
