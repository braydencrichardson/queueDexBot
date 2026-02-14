function normalizeResolverQuery(query, deps) {
  const { normalizeIncomingUrl, logInfo } = deps;
  const queryToResolve = normalizeIncomingUrl(query);
  if (queryToResolve !== query) {
    logInfo("Normalized incoming URL before resolve", { from: query, to: queryToResolve });
  }
  return queryToResolve;
}

function isProbablyUrl(value) {
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    return Boolean(url?.protocol && url?.hostname);
  } catch {
    return false;
  }
}

function isValidYouTubeVideoId(value) {
  return /^[a-zA-Z0-9_-]{11}$/.test(String(value || ""));
}

module.exports = {
  isProbablyUrl,
  isValidYouTubeVideoId,
  normalizeResolverQuery,
};
