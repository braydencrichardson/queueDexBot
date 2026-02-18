import { DiscordSDK } from "@discord/embedded-app-sdk";
import "./style.css";

const root = document.getElementById("app");
const SDK_READY_TIMEOUT_MS = 10000;

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

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

async function bootstrap() {
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

    renderStatus({
      title: "Activity is live",
      subtitle: "SDK connected. This is a placeholder view ready for queue controls.",
      rows: [{ label: "Mode", value: "embedded" }],
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
