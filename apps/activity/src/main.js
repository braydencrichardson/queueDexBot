import { DiscordSDK } from "@discord/embedded-app-sdk";
import "./style.css";

const root = document.getElementById("app");

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
      <p class="kicker">queueDex Activity</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="subtitle${error ? " error" : ""}">${escapeHtml(subtitle)}</p>
      <dl>${rowHtml}</dl>
    </section>
  `;
}

async function bootstrap() {
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

  renderStatus({
    title: "Connecting to Discord",
    subtitle: "Waiting for Embedded App SDK handshake...",
    rows: [{ label: "Client ID", value: clientId }],
  });

  try {
    const discordSdk = new DiscordSDK(clientId);
    await discordSdk.ready();

    renderStatus({
      title: "Activity is live",
      subtitle: "SDK connected. This is a placeholder view ready for queue controls.",
      rows: [
        { label: "Client ID", value: clientId },
        { label: "Guild", value: discordSdk.guildId || "unknown" },
        { label: "Channel", value: discordSdk.channelId || "unknown" },
        { label: "Instance", value: discordSdk.instanceId || "unknown" },
      ],
    });
  } catch (error) {
    renderStatus({
      title: "Failed to initialize",
      subtitle: "Discord SDK setup failed. Check URL Mapping, tunnel HTTPS, and EMBEDDED enablement.",
      error: true,
      rows: [{ label: "Error", value: error?.message || String(error) }],
    });
  }
}

void bootstrap();
