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
      groupId: Number.isInteger(tab.groupId) ? tab.groupId : -1,
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
  .raw-dot-layer{
    position:fixed; inset:0; z-index:2147483647; pointer-events:none;
    opacity:0; transition:opacity .45s ease;
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  .raw-dot-layer.raw-dot-on{opacity:1}
  .raw-dot-layer.raw-glow-out{opacity:0}
  .raw-dot-layer .raw-dot-canvas{display:block;width:100%;height:100%}
  .raw-dot-layer .raw-dot-label{
    position:absolute;left:50%;bottom:24px;transform:translateX(-50%);
    padding:7px 13px;border-radius:999px;
    background:rgba(13,15,19,.82);color:#dfe8ff;
    font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    letter-spacing:.04em;white-space:nowrap;
    border:1px solid rgba(140,175,255,.45);
    box-shadow:0 0 22px rgba(90,140,255,.45);
    -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
    animation:raw-dot-label-pulse 1.6s ease-in-out infinite;
  }
  .raw-dot-layer .raw-dot-label::before{
    content:"";display:inline-block;width:6px;height:6px;margin-right:7px;
    border-radius:50%;background:#8fb0ff;box-shadow:0 0 10px #8fb0ff;
    animation:raw-dot-label-pulse 1.6s ease-in-out infinite;vertical-align:1px;
  }
  @keyframes raw-dot-label-pulse{0%,100%{opacity:.62}50%{opacity:1}}
#raw-agent-cursor {
  position: fixed;
  left: 0;
  top: 0;
  width: 32px;
  height: 32px;
  z-index: 2147483647;
  pointer-events: none;
  will-change: transform;
}
#raw-agent-cursor .raw-cursor-arrow {
  position: absolute;
  inset: 0;
  background-image: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADvElEQVR42u1WTUgrVxT+zp07P5nJv0GoGDQhr2BdtGBLkbarFjd1oVDQUgRDV82j6ObhVihddBUaIYsuLOLG4rJFBKHd2iq4qvTRLrpoNBqxSqpObube2415+OyzmPhcvffBgblz5jLffOc7dw7wEi/xooOuLqLRKAEgpRRxzrXjOLparer7JGC0Lrq7u7kQwvJ935JSWkEQMCklcrmcrtVq98cgm82SaZomgFHTNL/v6ur6x3XdxwA+AdBrmqbDOTeu7ikWi7qF6+vWvVsjnU4zznnYsqxfRkZGxNLSkp6ZmdEAfgXwGWMsyTkP9ff309WXFYtFDQDXSbQrAD86OjKCIBjM5XJvzc/PY2hoCJOTk0ilUq+Vy+Wv9/f3La31D4eHh3uJREI87wow3/cJgBuPx+E4zpNEPp9HoVAwAXyutR71fd89OzuzWvnZ2Vl08sX/daFh2ADeHxgY0Ds7O7rRaDwVxWJR9/X1NQE8AvDgutStcnTsAcuybAAf3ESgWq3qUqmkiehPAI8YY+8xxt59SkbG3rkabRGwbft/FWhFqVTSmUympcSrjDHXtm3jzh541oH0LExMTGBubo4bhvEQwJjW2g2CwI5Go+xOBIjoVg/G43Hk83mUy+W+bDb7pdY6L6Xs9X3fiUajHSvB290wPj4OALxQKDyUUppCiG8A6Fgs5p+enrbdFUxK2daGWCyG6elplMvlvkwm8wWAj5vNZlIpxTsqQbsEWhgbG8PU1BS79MMrQggeiURYpyZsG5FIBIODgwCQAOBJKbkQgtr2AOccQohb104phXq9ju3tbSwvLwPAHwBOGWPKMIz2/wWXXXAj80ajgb29Payvr+vNzU25sbFxfnx8fKG1PgHwG4CvAOwDCDzP0+fn5+0RYIwBwI3MV1dXsbKygq2traN6vb4tpfwZwAGAPQD7jLEKgAvXdYNarda+ApdHt9JaQyn1JLG7u4uFhQW9uLj4O4CfAHwL4G8iuiCiJhEJIgrC4XDD87ygUql05mbP8ywAb6TTab22tqYbjYY+OTnRo6OjKhwO/wXgUyJ6E0AvEaUsywqHQiEXgMUY4z09PXSns5hzbhBRBMB36XT6pFAoqOHhYQHgRwAfAehnjKVCoZBj2zZPJBKE5whyHIeUUrYQ4nUAH1qW9XYQBDWl1AoRPSaiI8Mw/GQy6R8cHOh7mYpN02SGYTjNZtNWSjmXnSEYY8LzvAvLsmQnBrv1VKyU0vF4XDHGAillk3MuiMh3XVekUilZqVTudTR/sfEvJMbyeGoxdHEAAAAASUVORK5CYII=");
  background-size: 32px 32px;
  background-repeat: no-repeat;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, .45));
}
#raw-agent-cursor .raw-cursor-ring {
  position: absolute;
  left: -5px;
  top: 1px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid rgba(140, 175, 255, .9);
  opacity: 0;
}
#raw-agent-cursor.raw-cursor-down .raw-cursor-ring {
  animation: raw-cursor-ping .5s ease-out;
}
@keyframes raw-cursor-ping {
  0% { transform: scale(.35); opacity: .95; }
  100% { transform: scale(2.6); opacity: 0; }
}
`;

  // Injected into the page with chrome.scripting.executeScript, so it must be
  // self-contained: no references to extension-scope helpers.
  function agentGlowShow(id, idleMs, owner) {
    const KEY = "__rawAgentDots";
    // The driving runtime may publish its identity on the page; fall back to a
    // generic label so a human still sees that the tab is being driven. The
    // isolated world cannot read page variables, so the identity travels as a
    // DOM attribute written by rawSyncOwnerAttr (MAIN world).
    const fromAttr = document.documentElement && document.documentElement.getAttribute("data-raw-owner");
    const badgeText = String(fromAttr || (window.__rawOwner && window.__rawOwner.label) || owner || "").trim() || "raw controlling";
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const prior = window[KEY];
    if (prior && prior.node && prior.node.isConnected && prior.node.id === id) {
      prior.node.dataset.owner = badgeText;
      const priorBadge = prior.node.querySelector(".raw-dot-label");
      if (priorBadge) priorBadge.textContent = badgeText;
      prior.touch();
      return;
    }

    const node = document.createElement("div");
    node.id = id;
    node.className = "raw-dot-layer";
    const canvas = document.createElement("canvas");
    canvas.className = "raw-dot-canvas";
    const badge = document.createElement("span");
    badge.className = "raw-dot-label";
    badge.textContent = badgeText;
    node.dataset.owner = badgeText;
    node.appendChild(canvas);
    node.appendChild(badge);
    (document.documentElement || document.body).appendChild(node);
    requestAnimationFrame(() => node.classList.add("raw-dot-on"));

    const isDark = typeof window.__rawForceDark === "boolean" ? window.__rawForceDark : (() => {
      const el = document.body || document.documentElement;
      const bg = getComputedStyle(el).backgroundColor || "";
      const m = /rgba?\(([^)]+)\)/.exec(bg);
      if (!m) return matchMedia("(prefers-color-scheme: dark)").matches;
      const parts = m[1].split(",").map(Number);
      const [r, g, b] = parts;
      const a = parts.length > 3 ? parts[3] : 1;
      if (!a) return matchMedia("(prefers-color-scheme: dark)").matches;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    })();

    const ctx = canvas.getContext("2d");
    const hotRGB = isDark ? [196, 214, 255] : [36, 50, 78];
    const baseAlpha = 0;
    const hotAlpha = 0.95;

    const ALPHA_STEPS = 6;
    const THRESHOLD = 0.04;

    let w = 0;
    let h = 0;
    let dpr = 1;
    let spacing = 16;
    let dots = [];
    let raf = 0;
    let idle = 0;
    let stopped = false;
    let dotR = 1.2;
    let omega = 0.1;

    const layout = () => {
      w = node.clientWidth || window.innerWidth;
      h = node.clientHeight || window.innerHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // dense field: 0.75x the previous gap
      spacing = clamp(Math.sqrt((w * h) / 3600) * 0.964, 16.5, 22);
      const cols = Math.ceil(w / spacing) + 1;
      const rows = Math.ceil(h / spacing) + 1;
      const padX = (w - (cols - 1) * spacing) / 2;
      const padY = (h - (rows - 1) * spacing) / 2;
      // one fixed dot size: the wave only changes brightness now
      dotR = Math.max(0.9, spacing * 0.055);

      // long wavelength: a few broad, slow crests instead of tight rings
      const wavelength = Math.max(240, Math.min(w, h) * 0.42);
      const travel = Math.min(w, h) * 0.17 * 0.67; // px per second (0.67x the previous pace)
      omega = (travel / wavelength) * 6.2832;
      const k = 6.2832 / wavelength;
      // the source is a circle, not a point: radius is half a period and its
      // centre sits one whole period below the middle of the screen
      const srcX = w / 2;
      const srcR = wavelength / 2;
      // the centre stays below the viewport: the visible part is only the top
      // arc of the source circle, tangent to the bottom edge
      const srcY = h + srcR;
      const rimFade = Math.max(18, wavelength * 0.05);
      let maxReach = 1;
      for (let cy2 = 0; cy2 <= h; cy2 += h / 2) {
        for (let cx2 = 0; cx2 <= w; cx2 += w / 2) {
          maxReach = Math.max(maxReach, Math.hypot(cx2 - srcX, cy2 - srcY) - srcR);
        }
      }

      dots = [];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const px = padX + x * spacing;
          const py = padY + y * spacing;
          const dist = Math.sqrt((px - srcX) * (px - srcX) + (py - srcY) * (py - srcY));
          const away = dist - srcR; // distance travelled from the circle rim
          const inside = away <= 0;
          const envelope = inside ? 0 : Math.pow(1 - clamp(away / maxReach, 0, 1), 0.75);
          const rim = inside ? 0 : clamp(away / rimFade, 0, 1);
          dots.push({ x: px, y: py, env: envelope * rim, phase: inside ? 0 : away * k });
        }
      }

    };

    const draw = (ts) => {
      if (stopped) return;
      const time = ts * 0.001;
      const paths = new Array(ALPHA_STEPS);
      for (let i = 0; i < ALPHA_STEPS; i++) paths[i] = new Path2D();

      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        const s = 0.5 + 0.5 * Math.cos(d.phase - time * omega);
        // same lit band as before (support starts where s^2 used to cross the
        // threshold), but a linear ramp that saturates fast: the edges fade
        // quickly while the number of lit dots stays put
        const ramp = (s - 0.1765) * 1.7;
        const power = (ramp > 1 ? 1 : ramp < 0 ? 0 : ramp) * d.env;
        if (power <= THRESHOLD) continue;
        const step = Math.min(ALPHA_STEPS - 1, (power * ALPHA_STEPS) | 0);
        const path = paths[step];
        path.moveTo(d.x + dotR, d.y);
        path.arc(d.x, d.y, dotR, 0, 6.2832);
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "rgb(" + hotRGB[0] + "," + hotRGB[1] + "," + hotRGB[2] + ")";
      // brighter buckets sit on top so overlaps resolve toward the crest
      for (let a = 0; a < ALPHA_STEPS; a++) {
        ctx.globalAlpha = baseAlpha + (hotAlpha - baseAlpha) * ((a + 0.5) / ALPHA_STEPS);
        ctx.fill(paths[a]);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };

    const api = {
      node,
      touch() {
        clearTimeout(idle);
        node.classList.remove("raw-glow-out");
        idle = setTimeout(api.stop, idleMs);
      },
      stop() {
        if (stopped) return;
        stopped = true;
        clearTimeout(idle);
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", layout);
        document.removeEventListener("visibilitychange", onHide);
        node.classList.add("raw-glow-out");
        setTimeout(() => node.remove(), 450);
        if (window[KEY] === api) delete window[KEY];
      },
    };

    const onHide = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else if (!stopped) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      }
    };

    window[KEY] = api;
    window.addEventListener("resize", layout);
    document.addEventListener("visibilitychange", onHide);

    layout();
    raf = requestAnimationFrame(draw);
    api.touch();
  }

  // Agent pointer, in two layers:
  //   * positioning is owned by this one component, so every later mouse event
  //     continues from wherever the pointer currently sits;
  //   * motion is a short ease-out tween (quick off the mark, settling slowly)
  //     instead of a teleport, and the pointer stays on screen afterwards until
  //     the tab is detached or navigates.
  function agentCursorShow(id, x, y, down) {
    // Injected standalone: everything it needs must live inside this function.
    // Hotspot of icons/pointer.png is (3, 9), hence the offsets below.
    const CURSOR_HOT_X = 3;
    const CURSOR_HOT_Y = 9;
    const KEY = "__rawCursorState";
    const FLOAT_RADIUS = 150; // px: idle drift never leaves this disc
    let state = window[KEY];

    if (!state || !state.node || !state.node.isConnected) {
      const node = document.createElement("div");
      node.id = id;
      node.innerHTML = '<div class="raw-cursor-arrow"></div><div class="raw-cursor-ring"></div>';
      (document.documentElement || document.body).appendChild(node);
      node.style.transform = "translate3d(" + (x - CURSOR_HOT_X) + "px," + (y - CURSOR_HOT_Y) + "px,0)";
      state = {
        node, x, y, tx: x, ty: y, fromX: x, fromY: y, start: 0, duration: 0,
        raf: 0, floatRaf: 0, anchorX: x, anchorY: y, floatStart: 0, p1: 0, p2: 0, p3: 0, p4: 0,
      };
      window[KEY] = state;
    }

    // Any real input ends the idle drift and the pointer continues from where
    // the drift left it, so there is no visible snap.
    if (state.floatRaf) {
      cancelAnimationFrame(state.floatRaf);
      state.floatRaf = 0;
      // state.x/state.y already hold the drifted position, so the glide starts
      // exactly where the pointer is on screen
    }

    state.tx = x;
    state.ty = y;

    if (down && state.node) {
      state.node.classList.remove("raw-cursor-down");
      void state.node.offsetWidth;
      state.node.classList.add("raw-cursor-down");
    }

    // Idle drift: a continuous, organic wander inside a disc around the point
    // the pointer last rested at. Two superposed rotations with unrelated
    // periods give a slow figure-eight-ish path that never parks, so the
    // pointer keeps moving instead of hopping to a random target and waiting.
    const FLOAT_A = FLOAT_RADIUS * 0.55;
    const FLOAT_B = FLOAT_RADIUS * 0.45; // A + B <= FLOAT_RADIUS
    const startFloat = () => {
      state.anchorX = state.x;
      state.anchorY = state.y;
      state.floatStart = performance.now();
      state.p1 = Math.random() * Math.PI * 2;
      state.p2 = Math.random() * Math.PI * 2;
      state.p3 = Math.random() * Math.PI * 2;
      state.p4 = Math.random() * Math.PI * 2;
      const tick = () => {
        const t = performance.now() - state.floatStart;
        const px = state.anchorX +
          FLOAT_A * Math.sin(t * 0.00091 + state.p1) +
          FLOAT_B * Math.sin(t * 0.00052 + state.p2);
        const py = state.anchorY +
          FLOAT_A * Math.cos(t * 0.00077 + state.p3) +
          FLOAT_B * Math.cos(t * 0.00049 + state.p4);
        let dx = px - state.anchorX;
        let dy = py - state.anchorY;
        const len = Math.hypot(dx, dy);
        if (len > FLOAT_RADIUS) {
          dx = (dx / len) * FLOAT_RADIUS;
          dy = (dy / len) * FLOAT_RADIUS;
        }
        state.x = state.anchorX + dx;
        state.y = state.anchorY + dy;
        state.node.style.transform =
          "translate3d(" + (state.x - CURSOR_HOT_X) + "px," + (state.y - CURSOR_HOT_Y) + "px,0)";
        state.floatRaf = requestAnimationFrame(tick);
      };
      state.floatRaf = requestAnimationFrame(tick);
    };

    if (state.raf) return;
    const dist = Math.hypot(state.tx - state.x, state.ty - state.y);
    if (dist < 0.5) {
      if (!state.floatRaf) startFloat();
      return;
    }

    state.fromX = state.x;
    state.fromY = state.y;
    state.start = performance.now();
    // short moves snap quickly; long jumps take a little longer but stay under
    // 700ms so the pointer never lags behind the action it belongs to
    state.duration = Math.max(150, Math.min(700, 130 + dist * 0.9));

    const step = (now) => {
      const t = Math.min(1, (now - state.start) / state.duration);
      // ease-out cubic: almost all of the distance in the first half
      const eased = 1 - Math.pow(1 - t, 3);
      state.x = state.fromX + (state.tx - state.fromX) * eased;
      state.y = state.fromY + (state.ty - state.fromY) * eased;
      state.node.style.transform =
        "translate3d(" + (state.x - CURSOR_HOT_X) + "px," + (state.y - CURSOR_HOT_Y) + "px,0)";
      if (t < 1) {
        state.raf = requestAnimationFrame(step);
        return;
      }
      state.raf = 0;
      // a newer target may have arrived mid-flight: pick it up seamlessly
      if (Math.abs(state.tx - state.x) > 0.5 || Math.abs(state.ty - state.y) > 0.5) {
        state.fromX = state.x;
        state.fromY = state.y;
        state.start = performance.now();
        state.duration = Math.max(150, Math.min(700, 130 + Math.hypot(state.tx - state.x, state.ty - state.y) * 0.9));
        state.raf = requestAnimationFrame(step);
        return;
      }
      startFloat();
    };
    state.raf = requestAnimationFrame(step);
  }

  // MAIN world: copy the runtime identity from the page variable onto the DOM,
  // where the isolated world (and the overlay it renders) can read it.
  function rawSyncOwnerAttr() {
    try {
      const o = window.__rawOwner;
      if (o && o.label) document.documentElement.setAttribute("data-raw-owner", String(o.label));
    } catch {
      // pages without a documentElement
    }
  }

  function agentCursorHide(id) {
    const KEY = "__rawCursorState";
    const state = window[KEY];
    if (state) {
      if (state.raf) cancelAnimationFrame(state.raf);
      if (state.floatRaf) cancelAnimationFrame(state.floatRaf);
      if (window[KEY] === state) delete window[KEY];
    }
    const node = document.getElementById(id);
    if (node) node.remove();
  }

  function agentGlowHide(id) {
    const KEY = "__rawAgentDots";
    const state = window[KEY];
    if (state && state.node && state.node.id === id) { state.stop(); return; }
    const node = document.getElementById(id);
    if (!node) return;
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
        await chromeApi.scripting.executeScript({
          target: { tabId },
          func: agentCursorHide,
          args: [CURSOR_ID],
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

    const CURSOR_ID = "raw-agent-cursor";
    const lastCursorPaint = new Map();

    /** Paint the agent's pointer where it actually dispatched a mouse event. */
    async function paintAgentPointer(tabId, payload) {
      if (!chromeApi.scripting?.executeScript) return;
      if (String(payload?.method ?? "") !== "Input.dispatchMouseEvent") return;
      const params = payload?.params ?? {};
      if (typeof params.x !== "number" || typeof params.y !== "number") return;
      const down = /Pressed/.test(String(params.type ?? ""));
      const now = Date.now();
      const last = lastCursorPaint.get(tabId) ?? 0;
      // Moves are throttled: a drag can dispatch dozens per frame.
      if (!down && now - last < 45) return;
      lastCursorPaint.set(tabId, now);
      try {
        await chromeApi.scripting.executeScript({
          target: { tabId },
          func: agentCursorShow,
          args: [CURSOR_ID, params.x, params.y, down],
        });
      } catch {
        // Restricted pages cannot host the overlay.
      }
    }

    /** Pull the runtime's identity onto the DOM, then repaint the banner. */
    async function refreshOverlay(tabId) {
      if (!chromeApi.scripting?.executeScript) return;
      try {
        await chromeApi.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: rawSyncOwnerAttr,
          args: [],
        });
      } catch {
        // Strict-CSP pages may reject MAIN-world injection; the banner then
        // falls back to the generic label.
      }
      await showGlow(tabId);
    }

    async function sendTabCommand(payload) {
      const tab = await tabFor(payload);
      const tabId = await ensureAttached(tab.id);
      await refreshOverlay(tabId);
      await paintAgentPointer(tabId, payload);

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
              void refreshOverlay(tabId);
              resolve(res);
            }
          })
          .catch((err) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              void refreshOverlay(tabId);
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
        case "Raw.findGroup": {
          const title = String(params.title ?? "");
          if (!title) throw new Error("Raw.findGroup needs title");
          const windowId = Number.isInteger(params.windowId) ? params.windowId : undefined;
          const groups = await chromeApi.tabGroups.query({ title });
          const match = groups.find((group) => windowId === undefined || group.windowId === windowId);
          return { groupId: match ? match.id : null };
        }
        case "Raw.groupTabs": {
          const tabIds = (Array.isArray(params.tabIds) ? params.tabIds : []).map((id) => tabIdFrom(id));
          if (tabIds.length === 0) throw new Error("Raw.groupTabs needs tabIds");
          const existing = Number.isInteger(params.groupId) && params.groupId > 0 ? params.groupId : undefined;
          const groupId = await chromeApi.tabs.group(existing ? { tabIds, groupId: existing } : { tabIds });
          const update = {};
          if (params.title !== undefined) update.title = String(params.title);
          if (params.color !== undefined) update.color = String(params.color);
          if (Object.keys(update).length > 0) await chromeApi.tabGroups.update(groupId, update);
          return { groupId };
        }
        case "Raw.ungroupTabs": {
          const tabIds = (Array.isArray(params.tabIds) ? params.tabIds : []).map((id) => tabIdFrom(id));
          if (tabIds.length === 0) throw new Error("Raw.ungroupTabs needs tabIds");
          await chromeApi.tabs.ungroup(tabIds);
          return { ok: true, tabIds };
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
