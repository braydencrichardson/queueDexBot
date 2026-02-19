function normalizeActivityUrl(value) {
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

function appendActivityWebLine(lines, activityWebUrl = "") {
  if (!Array.isArray(lines)) {
    return false;
  }
  const normalizedWebUrl = normalizeActivityUrl(activityWebUrl);
  if (!normalizedWebUrl) {
    return false;
  }
  const alreadyIncluded = lines.some((line) => String(line || "").includes(normalizedWebUrl));
  if (alreadyIncluded) {
    return false;
  }
  lines.push(`Web: <${normalizedWebUrl}>`);
  return true;
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

  appendActivityWebLine(lines, activityWebUrl);
  return lines.join("\n");
}

function getActivityInviteFailureMessage(error) {
  if (error?.code === 50234) {
    return "This app is not Activities-enabled yet (missing EMBEDDED flag). Enable Activities for this application in the Discord Developer Portal, then try again.";
  }
  if (error?.code === 50013 || error?.code === 50001) {
    return "I couldn't create an Activity invite in this voice channel. Check that I can create invites there.";
  }
  return "Couldn't create an Activity invite right now. Try again in a moment.";
}

module.exports = {
  appendActivityWebLine,
  formatActivityInviteResponse,
  getActivityInviteFailureMessage,
  normalizeActivityUrl,
};
