/**
 * Injected into every page (once) as a single expression.
 * Kept in a real .js file so regex escapes are not mangled by template literals.
 */
(() => {
  if (window.__mai) return 'ready';

  const textOf = (el) => {
    const labelled = (el.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent || '')
      .join(' ');
    const labels = el.labels ? [...el.labels].map((label) => label.innerText || label.textContent || '').join(' ') : '';
    return [
      el.innerText || el.textContent || '', el.value || '', el.getAttribute('aria-label') || '',
      labelled, labels, el.getAttribute('placeholder') || '', el.getAttribute('title') || '', el.getAttribute('alt') || '',
    ].join(' ').replace(/\s+/g, ' ').trim();
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    const s = (view || window).getComputedStyle(el);
    if (s.visibility === 'hidden' || s.visibility === 'collapse' || s.display === 'none' || Number(s.opacity) === 0) return false;
    // Ancestors can hide a child that still has a non-zero box. Walk up,
    // crossing a shadow boundary through the host element.
    let node = el.parentElement || (el.parentNode && el.parentNode.host) || null;
    while (node && node.nodeType === 1) {
      const parentStyle = (view || window).getComputedStyle(node);
      if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden' || parentStyle.visibility === 'collapse' || Number(parentStyle.opacity) === 0) {
        return false;
      }
      node = node.parentElement || (node.parentNode && node.parentNode.host) || null;
    }
    let win = el.ownerDocument && el.ownerDocument.defaultView;
    while (win && win !== window) {
      const frame = win.frameElement;
      if (!frame || !visible(frame)) return false;
      win = frame.ownerDocument && frame.ownerDocument.defaultView;
    }
    return true;
  };

  const INTERACTIVE =
    'a,button,input,textarea,select,[role=button],[role=link],[role=checkbox],[role=tab],[role=textbox],[onclick],[contenteditable=true]';
  const TEXTY = 'a,button,[role=button],[role=link],input,textarea,li,span,div,h1,h2,h3,label,td,p';

  const ROLE_RE = /^role=([a-z]+)(?:\[name[*^$]?=["']?([^"']+)["']?\])?$/i;

  /** "text=Foo" / ":has-text(\"Foo\")" -> the needle, else null */
  const textNeedleOf = (s) => {
    let raw = null;
    if (s.startsWith('text=')) raw = s.slice(5);
    else if (s.startsWith(':has-text')) {
      const open = s.indexOf('(');
      if (open < 0) return null;
      raw = s.slice(open + 1, s.endsWith(')') ? -1 : undefined);
    }
    if (raw === null) return null;
    return raw.trim().replace(/^["']/, '').replace(/["']$/, '');
  };

  const roleSelector = (role) => {
    if (role === 'button') return 'button,[role=button],input[type=submit],input[type=button],input[type=reset]';
    if (role === 'link') return 'a,[role=link]';
    if (role === 'textbox') {
      return 'input:not([type=submit]):not([type=button]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]),textarea,[role=textbox],[contenteditable=true]';
    }
    if (role === 'checkbox') return 'input[type=checkbox],[role=checkbox]';
    if (role === 'combobox') return 'select,[role=combobox]';
    return '[role=' + role + ']';
  };

  /** top document plus every reachable same-origin frame document */
  const documents = () => {
    const out = [];
    const visit = (doc) => {
      if (!doc || out.includes(doc)) return;
      out.push(doc);
      let frames = [];
      try {
        frames = [...doc.querySelectorAll('iframe,frame')];
      } catch {
        return;
      }
      for (const frame of frames) {
        try {
          visit(frame.contentDocument);
        } catch {
          /* cross-origin iframe */
        }
      }
    };
    visit(document);
    return out;
  };

  /**
   * Every element matching the selector, including open shadow roots.
   * querySelectorAll alone stops at a shadow boundary, which is where most
   * modern component libraries keep their controls.
   */
  const queryAll = (selector) => {
    const out = [];
    const visit = (root) => {
      try {
        out.push(...root.querySelectorAll(selector));
      } catch {
        /* invalid selector in this root */
      }
      let hosts = [];
      try {
        hosts = root.querySelectorAll('*');
      } catch {
        return;
      }
      for (const host of hosts) {
        if (host.shadowRoot) visit(host.shadowRoot);
      }
    };
    for (const doc of documents()) visit(doc);
    return out;
  };

  /** element references handed out by snapshot(), kept out of the DOM */
  const refs = new Map();

  /** every locator syntax: number | css | css= | xpath= | text= | :has-text() | role= */
  const findAll = (sel) => {
    if (typeof sel === 'number' || (typeof sel === 'string' && /^\d+$/.test(sel.trim()) && !sel.includes('='))) {
      const el = refs.get(Number(sel));
      return el ? [el] : [];
    }
    if (sel === undefined || sel === null || sel === '') return [];
    const s = String(sel).trim();

    if (s.startsWith('css=')) return queryAll(s.slice(4));

    if (s.startsWith('xpath=')) {
      const out = [];
      for (const doc of documents()) {
        const view = doc.defaultView || window;
        const it = doc.evaluate(s.slice(6), doc, null, view.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < it.snapshotLength; i++) out.push(it.snapshotItem(i));
      }
      return out;
    }

    const needle = textNeedleOf(s);
    if (needle !== null) {
      const lower = needle.toLowerCase();
      if (!lower) return [];
      return queryAll(TEXTY)
        .filter((el) => visible(el) && textOf(el).toLowerCase().includes(lower))
        .sort((a, b) => textOf(a).length - textOf(b).length);
    }

    const roleMatch = ROLE_RE.exec(s);
    if (roleMatch) {
      const role = roleMatch[1].toLowerCase();
      const name = (roleMatch[2] || '').toLowerCase();
      return queryAll(roleSelector(role)).filter(
        (el) => visible(el) && (!name || textOf(el).toLowerCase().includes(name)),
      );
    }

    try {
      return queryAll(s);
    } catch {
      return [];
    }
  };

  const find = (sel) => findAll(sel)[0] || null;

  const absoluteRect = (el, scroll) => {
    const frames = [];
    let owner = el.ownerDocument && el.ownerDocument.defaultView;
    while (owner && owner !== window) {
      const frame = owner.frameElement;
      if (!frame) break;
      frames.push(frame);
      owner = frame.ownerDocument && frame.ownerDocument.defaultView;
    }
    if (scroll) {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      for (const frame of frames) frame.scrollIntoView({ block: 'center', inline: 'center' });
    }
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let win = el.ownerDocument && el.ownerDocument.defaultView;
    while (win && win !== window) {
      const frame = win.frameElement;
      if (!frame) break;
      const fr = frame.getBoundingClientRect();
      left += fr.left;
      top += fr.top;
      win = frame.ownerDocument && frame.ownerDocument.defaultView;
    }
    return { x: left + r.width / 2, y: top + r.height / 2, w: r.width, h: r.height };
  };
  const rect = (el) => absoluteRect(el, true);

  /** interactive elements from a document and its same-origin frames/shadow roots */
  const collect = (root, out) => {
    try {
      out.push(...root.querySelectorAll(INTERACTIVE));
    } catch {
      /* cross-origin document */
    }
    let hosts = [];
    try {
      hosts = root.querySelectorAll('*');
    } catch {
      hosts = [];
    }
    for (const host of hosts) {
      if (host.shadowRoot) collect(host.shadowRoot, out);
    }
    let frames = [];
    try {
      frames = [...root.querySelectorAll('iframe,frame')];
    } catch {
      /* ignore */
    }
    for (const f of frames) {
      try {
        if (f.contentDocument) collect(f.contentDocument, out);
      } catch {
        /* cross-origin iframe: skip */
      }
    }
    return out;
  };

  const snapshot = (opts) => {
    opts = opts || {};
    const scope = opts.scope || 'full';
    const max = Math.max(1, Math.min(Number(opts.max) || 400, 2000));
    const root = opts.root ? document.querySelector(opts.root) : null;
    if (opts.root && !root) return '(snapshot root not found: ' + opts.root + ')';

    const inViewport = (el) => {
      if (scope !== 'viewport') return true;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    };

    const lines = [];
    // Remove indices left by an older build; numbering now lives in `refs`
    // so snapshotting never mutates the page's DOM or trips its observers.
    queryAll('[data-mai]').forEach((e) => e.removeAttribute('data-mai'));
    refs.clear();
    lines.push('# ' + (document.title || '').replace(/\s+/g, ' ').trim());
    lines.push('# ' + location.href);
    lines.push('# scope=' + scope + (opts.root ? ' root=' + opts.root : ''));
    lines.push('');
    lines.push('## elements');

    const candidates = root ? collect(root, []) : collect(document, []);
    let i = 0;
    for (const el of candidates) {
      if (!visible(el) || !inViewport(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type');
      const index = i;
      refs.set(index, el);
      lines.push('[' + index + '] ' + tag + (type ? ':' + type : '') + ' "' + textOf(el).slice(0, 120) + '"');
      if (++i >= max) {
        lines.push('(element list truncated at ' + max + ')');
        break;
      }
    }
    if (!i) lines.push('(no interactive elements found)');

    lines.push('');
    lines.push('## text');
    const bodies = root ? [root] : documents().map((doc) => doc.body).filter(Boolean);
    lines.push(bodies.map((body) => body.innerText || '').join('\n\n').replace(/\n{3,}/g, '\n\n').slice(0, 6000));
    return lines.join('\n');
  };

  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    text: textOf(el).slice(0, 200),
    value: 'value' in el ? el.value : undefined,
    href: el.href || undefined,
    visible: visible(el),
    box: (() => {
      const r = absoluteRect(el, false);
      // x/y stay center points (what mouseMove/click expect); left/top are
      // the unambiguous corners.
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        left: Math.round(r.x - r.w / 2),
        top: Math.round(r.y - r.h / 2),
        width: Math.round(r.w),
        height: Math.round(r.h),
      };
    })(),
  });

  /* ------------------------------------------------------------------ *
   * rich text injection
   * Plain `el.value = x` only reaches uncontrolled <input>/<textarea>.
   * Editors that own their own document model (Monaco, CodeMirror) and
   * every React-controlled field ignore it. Each probe below reports the
   * strategy that actually ran, so a silent no-op is never mistaken for
   * a successful write.
   * ------------------------------------------------------------------ */

  const viewOf = (el) => (el.ownerDocument && el.ownerDocument.defaultView) || window;

  const closestTo = (el, selector) => {
    if (!el || !el.closest) return null;
    try {
      return el.closest(selector);
    } catch {
      return null;
    }
  };

  const monacoFor = (el) => {
    const editor = viewOf(el).monaco && viewOf(el).monaco.editor;
    if (!editor || typeof editor.getEditors !== 'function') return null;
    let editors = [];
    try {
      editors = editor.getEditors() || [];
    } catch {
      return null;
    }
    if (!editors.length) return null;
    const domOf = (instance) => {
      try {
        return instance.getDomNode ? instance.getDomNode() : null;
      } catch {
        return null;
      }
    };
    const owner = editors.find((instance) => {
      const dom = domOf(instance);
      // a disposed editor can still be registered while its node is gone
      if (!dom || typeof dom !== 'object') return false;
      const domContains = typeof dom.contains === 'function' ? (node) => dom.contains(node) : () => false;
      const elContains = typeof el.contains === 'function' ? (node) => el.contains(node) : () => false;
      return dom === el || domContains(el) || elContains(dom);
    });
    if (owner) {
      return {
        kind: 'monaco',
        read: () => { try { return owner.getValue ? owner.getValue() : ''; } catch { return ''; } },
        write: (text) => owner.setValue(text),
      };
    }
    const focused = editors.find((instance) => {
      try {
        return typeof instance.hasTextFocus === 'function' && instance.hasTextFocus();
      } catch {
        return false;
      }
    });
    if (focused) {
      return {
        kind: 'monaco-focused',
        read: () => { try { return focused.getValue ? focused.getValue() : ''; } catch { return ''; } },
        write: (text) => focused.setValue(text),
      };
    }

    // Only fall back to a lone (or unidentifiable) editor when the target
    // really is part of one. Without this guard a page that happens to hold a
    // single Monaco instance swallows every setValue on the page, including
    // plain inputs that have nothing to do with the editor.
    const insideEditor = closestTo(el, '.monaco-editor') !== null;
    const hostsEditor = typeof el.querySelector === 'function' && el.querySelector('.monaco-editor') !== null;
    const isMonacoInput =
      (el.tagName || '').toLowerCase() === 'textarea' &&
      typeof el.classList?.contains === 'function' &&
      el.classList.contains('inputarea');
    if (!insideEditor && !hostsEditor && !isMonacoInput) return null;

    if (editors.length === 1) {
      return {
        kind: 'monaco-single',
        read: () => { try { return editors[0].getValue ? editors[0].getValue() : ''; } catch { return ''; } },
        write: (text) => editors[0].setValue(text),
      };
    }
    return { kind: 'monaco-ambiguous', count: editors.length, write: null, read: null };
  };

  const codeMirror5For = (el) => {
    const host = el.classList && el.classList.contains('CodeMirror') ? el : closestTo(el, '.CodeMirror');
    const instance = host && host.CodeMirror;
    return instance && typeof instance.setValue === 'function' ? instance : null;
  };

  const codeMirror6For = (el) => {
    const host = closestTo(el, '.cm-editor');
    const content = host ? host.querySelector('.cm-content') : null;
    const candidates = [el, content, host].filter(Boolean);
    for (const node of candidates) {
      const view = node.cmView && node.cmView.view;
      if (view && view.state && typeof view.dispatch === 'function') return view;
    }
    return null;
  };

  const selectAllContents = (el, doc) => {
    const selection = viewOf(el).getSelection ? viewOf(el).getSelection() : null;
    if (!selection) return false;
    const range = doc.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  };

  const writeNativeValue = (el, text) => {
    const tag = (el.tagName || '').toLowerCase();
    const view = viewOf(el);
    const prototype = tag === 'textarea'
      ? (view.HTMLTextAreaElement || Object).prototype
      : tag === 'select'
        ? (view.HTMLSelectElement || Object).prototype
        : (view.HTMLInputElement || Object).prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value') && Object.getOwnPropertyDescriptor(prototype, 'value').set;
    if (setter) setter.call(el, text);
    else el.value = text;
  };

  const setValue = (sel, value, opts) => {
    opts = opts || {};
    const text = String(value === undefined || value === null ? '' : value);
    const el = find(sel);
    if (!el) return { ok: false, strategy: 'none', detail: 'element not found: ' + String(sel) };

    const tag = (el.tagName || '').toLowerCase();
    const inputType = String(el.type || (el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    if (tag === 'input' && inputType === 'file') {
      return { ok: false, strategy: 'file-input', detail: 'file inputs must be written with setInputFiles()' };
    }

    const monaco = monacoFor(el);
    if (monaco && monaco.write) {
      let next = text;
      if (opts.append && typeof monaco.read === 'function') {
        try { next = String(monaco.read() || '') + text; } catch { next = text; }
      }
      monaco.write(next);
      return { ok: true, strategy: monaco.kind, length: next.length };
    }
    if (monaco && monaco.kind === 'monaco-ambiguous') {
      return {
        ok: false,
        strategy: monaco.kind,
        detail: 'window.monaco exposes ' + monaco.count + ' editors and none contains this element; pass the editor container',
      };
    }

    const cm5 = codeMirror5For(el);
    if (cm5) {
      let next = text;
      if (opts.append) {
        try { next = String(cm5.getValue ? cm5.getValue() : '') + text; } catch { next = text; }
      }
      cm5.setValue(next);
      return { ok: true, strategy: 'codemirror5', length: next.length };
    }

    const cm6 = codeMirror6For(el);
    if (cm6) {
      const current = cm6.state && cm6.state.doc && typeof cm6.state.doc.toString === 'function'
        ? cm6.state.doc.toString()
        : '';
      const next = opts.append ? current + text : text;
      cm6.dispatch({ changes: { from: 0, to: cm6.state.doc.length, insert: next } });
      return { ok: true, strategy: 'codemirror6', length: next.length };
    }

    el.scrollIntoView({ block: 'center' });
    el.focus();

    if (el.isContentEditable) {
      const doc = el.ownerDocument;
      const current = String(el.innerText || el.textContent || '');
      const next = opts.append ? current + text : text;
      let replaced = false;
      try {
        replaced = selectAllContents(el, doc) && doc.execCommand('insertText', false, next);
      } catch {
        replaced = false;
      }
      if (!replaced) {
        el.textContent = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (opts.notifyChange !== false) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ok: true, strategy: 'contenteditable', length: next.length };
    }

    const current = 'value' in el ? String(el.value === undefined || el.value === null ? '' : el.value) : '';
    const next = opts.append ? current + text : text;
    writeNativeValue(el, next);

    const view = viewOf(el);
    const InputEventCtor = view.InputEvent;
    const inputEvent = InputEventCtor
      ? new InputEventCtor('input', { bubbles: true, data: text, inputType: 'insertText' })
      : new Event('input', { bubbles: true });
    el.dispatchEvent(inputEvent);
    if (opts.notifyChange !== false) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, strategy: 'input', length: next.length };
  };

  Object.defineProperty(window, '__mai', { value: { find, findAll, describe, visible, textOf, rect, snapshot, setValue } });
  return 'ready';
})()
