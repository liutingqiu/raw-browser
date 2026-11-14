import test from "node:test";
import assert from "node:assert/strict";
import { markRead, hasRead, requireRead, clearRead } from "../dist/term/read-guard.js";
import { TmuxDriver } from "../dist/term/tmux-driver.js";

test("ReadGuard: enforces observe-before-act lifecycle", async () => {
  const paneId = "%test_pane_42";
  clearRead(paneId);

  // 1. Initial state: not read
  assert.equal(hasRead(paneId), false);
  assert.throws(() => requireRead(paneId), /Must observe\/read pane/);

  // 2. Mark read
  markRead(paneId);
  assert.equal(hasRead(paneId), true);
  assert.doesNotThrow(() => requireRead(paneId));

  // 3. Expiration check
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hasRead(paneId, 10), false);

  // 4. Clear read
  markRead(paneId);
  clearRead(paneId);
  assert.equal(hasRead(paneId), false);
});

test("TmuxDriver: validates safety gates and prevents shell injection", async () => {
  const driver = new TmuxDriver();
  const pane = "%target_99";
  clearRead(pane);

  // 1. Cannot wake without reading first
  await assert.rejects(
    async () => {
      await driver.wakePane(pane, "task-1234");
    },
    /Must observe\/read pane/
  );

  // 2. Cannot wake with illegal / malicious taskId characters
  markRead(pane);
  await assert.rejects(
    async () => {
      await driver.wakePane(pane, "task-123; rm -rf /");
    },
    /Invalid taskId/
  );

  await assert.rejects(
    async () => {
      await driver.wakePane(pane, "task`cat /etc/passwd`");
    },
    /Invalid taskId/
  );

  // 3. Name pane rejects empty or invalid characters
  await assert.rejects(
    async () => {
      await driver.namePane(pane, "   ");
    },
    /Pane name must contain alphanumeric/
  );
});
