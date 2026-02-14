const RESOURCE_DISPOSE_KEY = "__queueDexDispose";

function createSoundcloudResourceFactory(deps) {
  const {
    playdl,
    createAudioResource,
    StreamType,
  } = deps;

  async function createSoundcloudResource(url) {
    const stream = await playdl.stream(url);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type ?? StreamType.Arbitrary,
      metadata: {
        source: "soundcloud",
        pipeline: "play-dl-soundcloud-passthrough",
        inputType: stream.type ?? StreamType.Arbitrary,
      },
    });
    if (typeof stream.stream?.destroy === "function") {
      resource[RESOURCE_DISPOSE_KEY] = () => {
        stream.stream.destroy();
      };
    }
    return resource;
  }

  return {
    createSoundcloudResource,
  };
}

module.exports = {
  createSoundcloudResourceFactory,
};
