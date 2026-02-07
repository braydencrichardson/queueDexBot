function normalizeQueryInput(input) {
  const trimmed = input.trim();
  return trimmed.replace(/^\/?play\s+/i, "");
}

module.exports = {
  normalizeQueryInput,
};
