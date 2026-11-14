#!/usr/bin/env node
/**
 * A fake `raw-bridge` for MCP tests: keeps tabs in a JSON file instead of a
 * browser, so tab ownership can be exercised without Chrome or an extension.
 */
import fs from "node:fs";

const stateFile = process.env.STUB_TABS;
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));

function save() {
  fs.writeFileSync(stateFile, JSON.stringify(state));
}
function print(value, code = 0) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(code);
}

const [, , command, ...args] = process.argv;
switch (command) {
  case "status":
    print({ bridge: "StubBridge/0.0", port: 0 });
    break;
  case "tabs":
    print(state.tabs);
    break;
  case "new": {
    const id = String(state.nextId++);
    const tab = { id, url: args[0] ?? "about:blank", title: "stub", active: false };
    state.tabs.push(tab);
    state.lastBackground = process.env.RAW_TAB_BACKGROUND ?? null;
    save();
    print({ id, url: tab.url, title: tab.title });
    break;
  }
  case "goto": {
    const [tabId, url] = args;
    const tab = state.tabs.find((item) => item.id === String(tabId));
    if (!tab) print({ error: `no page tab matched ${String(tabId)}` }, 1);
    tab.url = url;
    save();
    print({ tabId: tab.id, url });
    break;
  }
  case "close": {
    const id = String(args[0]);
    state.tabs = state.tabs.filter((item) => item.id !== id);
    save();
    print({ closed: id });
    break;
  }
  case "press":
    print({ pressed: args[1] ?? "", tabId: String(args[0]) });
    break;
  case "scroll":
    print({ tabId: String(args[0]), scrollY: Number(args[1]) || 0 });
    break;
  case "select":
    print({ tabId: String(args[0]), value: args[2] ?? "", label: args[2] ?? "" });
    break;
  case "title":
    print("stub title");
    break;
  case "url":
    print("https://stub.example/");
    break;
  case "text":
    print(`stub text for tab ${String(args[0])}`);
    break;
  case "click":
    print({ clicked: args[1] ?? "", tabId: String(args[0]) });
    break;
  case "fill":
    print({ filled: args[1] ?? "", tabId: String(args[0]) });
    break;
  case "snapshot":
    print({ snapshot: `# stub ${String(args[0])}` });
    break;
  case "frames":
    print([]);
    break;
  case "cookies":
    print([]);
    break;
  case "screenshot":
    print({ saved: args[1] ?? "stub.png", bytes: 1 });
    break;
  case "eval": {
    const expression = args[1] ?? "";
    if (expression.includes("location.href")) {
      print({ url: "https://copied.example/", scrollX: 0, scrollY: 0 });
      break;
    }
    print({ tabId: String(args[0]), expression });
    break;
  }
  default:
    print({ error: `stub: unknown command ${command}` }, 1);
}
