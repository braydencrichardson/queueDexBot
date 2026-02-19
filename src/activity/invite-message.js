function normalizeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    const protocol = String(parsed.protocol || "").toLowerCase();
    if (protocol !== "https:" && protocol !== "http:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function formatActivityInviteResponse({
  inviteUrl,
  reused = false,
  voiceChannelName = "voice",
  activityWebUrl = "",
}) {
  const normalizedInviteUrl = String(inviteUrl || "").trim();
  if (!normalizedInviteUrl) {
    throw new Error("inviteUrl is required");
  }
  const lines = [
    `Activity: <${normalizedInviteUrl}>`,
  ];

  const normalizedWebUrl = normalizeHttpUrl(activityWebUrl);
  if (normalizedWebUrl) {
    lines.push(`Web: <${normalizedWebUrl}>`);
  }
  return lines.join("\n");
}

module.exports = {
  formatActivityInviteResponse,
};
