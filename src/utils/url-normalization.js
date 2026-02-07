function isYoutubeHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "youtube.com"
    || host.endsWith(".youtube.com")
    || host === "youtu.be"
    || host.endsWith(".youtu.be");
}

function normalizeIncomingUrl(value) {
  if (!value) {
    return value;
  }

  try {
    const parsed = new URL(value);
    let changed = false;

    if (parsed.protocol === "http:") {
      parsed.protocol = "https:";
      changed = true;
    }

    if (isYoutubeHost(parsed.hostname) && parsed.hostname === "youtube.com") {
      parsed.hostname = "www.youtube.com";
      changed = true;
    }

    return changed ? parsed.toString() : value;
  } catch {
    return value;
  }
}

module.exports = {
  isYoutubeHost,
  normalizeIncomingUrl,
};
