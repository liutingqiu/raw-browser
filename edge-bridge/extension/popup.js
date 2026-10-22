const statusEl = document.getElementById("status");
const detailEl = document.getElementById("detail");
const toggleEl = document.getElementById("toggle");

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "raw-status" });
  if (!status) {
    statusEl.textContent = "No background response";
    detailEl.textContent = "";
    return;
  }
  statusEl.textContent = status.paused ? "Paused" : status.connected ? "Connected" : "Connecting…";
  detailEl.textContent = `extension ${status.version} · protocol ${status.protocolVersion}\n${status.browser}`;
  toggleEl.textContent = status.paused ? "Reconnect" : "Disconnect";
  toggleEl.dataset.paused = status.paused ? "1" : "0";
}

toggleEl.addEventListener("click", async () => {
  const paused = toggleEl.dataset.paused === "1";
  await chrome.runtime.sendMessage({ type: paused ? "raw-reconnect" : "raw-disconnect" });
  await refresh();
});

refresh();
