const { InviteTargetType } = require("discord.js");

const DEFAULT_ACTIVITY_INVITE_MAX_AGE_SECONDS = 2 * 60 * 60;
const DEFAULT_ACTIVITY_INVITE_CACHE_MAX_ENTRIES = 400;
const DEFAULT_ACTIVITY_INVITE_EXPIRY_GRACE_MS = 15 * 1000;

function createActivityInviteService(options = {}) {
  const configuredMaxAgeSeconds = Number(options.maxAgeSeconds);
  const maxAgeSeconds = Number.isFinite(configuredMaxAgeSeconds) && configuredMaxAgeSeconds > 0
    ? Math.floor(configuredMaxAgeSeconds)
    : DEFAULT_ACTIVITY_INVITE_MAX_AGE_SECONDS;
  const configuredCacheMaxEntries = Number(options.cacheMaxEntries);
  const cacheMaxEntries = Number.isFinite(configuredCacheMaxEntries) && configuredCacheMaxEntries > 0
    ? Math.floor(configuredCacheMaxEntries)
    : DEFAULT_ACTIVITY_INVITE_CACHE_MAX_ENTRIES;
  const configuredExpiryGraceMs = Number(options.expiryGraceMs);
  const expiryGraceMs = Number.isFinite(configuredExpiryGraceMs) && configuredExpiryGraceMs >= 0
    ? Math.floor(configuredExpiryGraceMs)
    : DEFAULT_ACTIVITY_INVITE_EXPIRY_GRACE_MS;

  const inviteCache = new Map();
  const pendingInvites = new Map();

  function buildCacheKey(guildId, channelId, applicationId) {
    return `${String(guildId || "")}:${String(channelId || "")}:${String(applicationId || "")}`;
  }

  function getCachedInvite(cacheKey) {
    const cached = inviteCache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (!Number.isFinite(cached.expiresAt) || cached.expiresAt <= Date.now() + expiryGraceMs) {
      inviteCache.delete(cacheKey);
      return null;
    }
    return cached;
  }

  function setCachedInvite(cacheKey, invite) {
    const inviteUrl = invite?.url || (invite?.code ? `https://discord.gg/${invite.code}` : null);
    if (!inviteUrl) {
      return null;
    }

    let expiresAt = Number(invite?.expiresTimestamp);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
      const inviteMaxAgeSeconds = Number(invite?.maxAge);
      const safeMaxAgeSeconds = Number.isFinite(inviteMaxAgeSeconds) && inviteMaxAgeSeconds > 0
        ? inviteMaxAgeSeconds
        : maxAgeSeconds;
      expiresAt = Date.now() + safeMaxAgeSeconds * 1000;
    }

    if (inviteCache.size >= cacheMaxEntries) {
      const oldestKey = inviteCache.keys().next().value;
      if (oldestKey) {
        inviteCache.delete(oldestKey);
      }
    }

    const entry = {
      url: inviteUrl,
      expiresAt,
    };
    inviteCache.set(cacheKey, entry);
    return entry;
  }

  async function getOrCreateInvite({
    voiceChannel,
    applicationId,
    reason = null,
  }) {
    if (!voiceChannel || typeof voiceChannel.createInvite !== "function") {
      throw new Error("Voice channel does not support invite creation");
    }

    const normalizedApplicationId = String(applicationId || "").trim();
    if (!normalizedApplicationId) {
      throw new Error("Application ID is required to create an Activity invite");
    }

    const cacheKey = buildCacheKey(voiceChannel?.guild?.id, voiceChannel?.id, normalizedApplicationId);
    const cached = getCachedInvite(cacheKey);
    if (cached) {
      return {
        ...cached,
        reused: true,
      };
    }

    const inFlight = pendingInvites.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const createPromise = (async () => {
      const inviteOptions = {
        targetType: InviteTargetType.EmbeddedApplication,
        targetApplication: normalizedApplicationId,
        unique: false,
        maxAge: maxAgeSeconds,
      };
      const normalizedReason = String(reason || "").trim();
      if (normalizedReason) {
        inviteOptions.reason = normalizedReason;
      }
      const invite = await voiceChannel.createInvite(inviteOptions);
      const saved = setCachedInvite(cacheKey, invite);
      if (!saved?.url) {
        throw new Error("Invite URL missing from createInvite response");
      }
      return {
        ...saved,
        reused: false,
      };
    })();

    pendingInvites.set(cacheKey, createPromise);
    createPromise.then(
      () => {
        pendingInvites.delete(cacheKey);
      },
      () => {
        pendingInvites.delete(cacheKey);
      }
    );
    return createPromise;
  }

  return {
    buildCacheKey,
    getCachedInvite,
    getOrCreateInvite,
  };
}

module.exports = {
  createActivityInviteService,
  DEFAULT_ACTIVITY_INVITE_MAX_AGE_SECONDS,
  DEFAULT_ACTIVITY_INVITE_CACHE_MAX_ENTRIES,
  DEFAULT_ACTIVITY_INVITE_EXPIRY_GRACE_MS,
};
