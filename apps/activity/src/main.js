import { DiscordSDK } from "@discord/embedded-app-sdk";
import "./style.css";

const root = document.getElementById("app");
const SDK_READY_TIMEOUT_MS = 10000;
const UPTIME_INTERVAL_MS = 1000;
let liveTicker = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderStatus({ title, subtitle, rows = [], error = false }) {
  const rowHtml = rows
    .map(({ label, value }) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
  root.innerHTML = `
    <section class="shell">
      <p class="kicker">queueDexBot Activity</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="subtitle${error ? " error" : ""}">${escapeHtml(subtitle)}</p>
      <dl>${rowHtml}</dl>
    </section>
  `;
}

function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleTimeString();
}

function formatUptime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const segments = [];
  if (hours > 0) {
    segments.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    segments.push(`${minutes}m`);
  }
  segments.push(`${seconds}s`);
  return segments.join(" ");
}

function stopLiveTicker() {
  if (liveTicker) {
    clearInterval(liveTicker);
    liveTicker = null;
  }
}

function renderLiveDashboard({ connectedAt, sdk }) {
  const guildId = sdk.guildId || "unknown";
  const channelId = sdk.channelId || "unknown";
  const instanceId = sdk.instanceId || "unknown";
  root.innerHTML = `
    <section class="shell">
      <div class="top-row">
        <p class="kicker">queueDexBot Activity</p>
        <span class="chip chip-ok">Connected</span>
      </div>
      <h1>queueDexBot Live Panel</h1>
      <p class="subtitle">Activity session is active. Live bot data can plug into this layout next.</p>
      <section class="panel-grid">
        <article class="panel-card">
          <h2>Session</h2>
          <dl>
            <dt>Mode</dt><dd>embedded</dd>
            <dt>Connected at</dt><dd id="connected-at">${escapeHtml(formatTime(connectedAt))}</dd>
            <dt>Uptime</dt><dd id="uptime">0s</dd>
          </dl>
        </article>
        <article class="panel-card">
          <h2>Discord Context</h2>
          <dl>
            <dt>Guild</dt><dd>${escapeHtml(guildId)}</dd>
            <dt>Channel</dt><dd>${escapeHtml(channelId)}</dd>
            <dt>Instance</dt><dd>${escapeHtml(instanceId)}</dd>
          </dl>
        </article>
        <article class="panel-card panel-card-wide">
          <h2>Now Playing (Next Step)</h2>
          <p class="muted">No backend feed connected yet. This section will show queue, active track, and controls.</p>
          <div class="placeholder-line"></div>
          <div class="placeholder-line short"></div>
        </article>
      </section>
      <p class="footer-note">Local clock: <span id="clock">${escapeHtml(formatTime(new Date()))}</span></p>
    </section>
  `;

  stopLiveTicker();
  liveTicker = setInterval(() => {
    const uptimeNode = root.querySelector("#uptime");
    const clockNode = root.querySelector("#clock");
    if (uptimeNode) {
      uptimeNode.textContent = formatUptime(Date.now() - connectedAt.getTime());
    }
    if (clockNode) {
      clockNode.textContent = formatTime(new Date());
    }
  }, UPTIME_INTERVAL_MS);
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

async function bootstrap() {
  stopLiveTicker();
  const query = new URLSearchParams(window.location.search);
  const hasFrameId = query.has("frame_id");
  if (!hasFrameId) {
    renderStatus({
      title: "queueDexBot",
      subtitle: "This endpoint is only available when launched from Discord.",
    });
    return;
  }

  const clientId = String(import.meta.env.VITE_DISCORD_CLIENT_ID || "").trim();
  if (!clientId) {
    renderStatus({
      title: "Missing client id",
      subtitle: "Set VITE_DISCORD_CLIENT_ID in apps/activity/.env before launching this Activity.",
      error: true,
      rows: [{ label: "Expected var", value: "VITE_DISCORD_CLIENT_ID" }],
    });
    return;
  }

  const discordSdk = new DiscordSDK(clientId);

  renderStatus({
    title: "Connecting to Discord",
    subtitle: "Waiting for Embedded App SDK handshake...",
    rows: [{ label: "Mode", value: "embedded" }],
  });

  try {
    await withTimeout(
      discordSdk.ready(),
      SDK_READY_TIMEOUT_MS,
      "Connection timed out. Please close and relaunch this Activity from Discord."
    );

    renderLiveDashboard({
      connectedAt: new Date(),
      sdk: discordSdk,
    });
  } catch (error) {
    const message = String(error?.message || "");
    const isTimeout = message.toLowerCase().includes("timed out");
    renderStatus({
      title: "Failed to initialize",
      subtitle: isTimeout
        ? "Connection timed out. Please close and relaunch this Activity from Discord."
        : "Connection was interrupted. Please close and relaunch this Activity from Discord.",
      error: true,
      rows: [{ label: "Error", value: error?.message || String(error) }],
    });
  }
}

void bootstrap();
