function createResolverHttpClient(deps) {
  const {
    httpsModule,
    requestTimeoutMs,
    redirectMaxHops,
    soundcloudUserAgent,
    youtubeUserAgent,
  } = deps;

  function httpGetJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = httpsModule.get(url, { headers }, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      });
      req.setTimeout(requestTimeoutMs, () => {
        req.destroy(new Error(`HTTP request timeout after ${requestTimeoutMs}ms`));
      });
      req.on("error", reject);
    });
  }

  function httpGetText(url, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = httpsModule.get(url, { headers }, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          resolve(data);
        });
      });
      req.setTimeout(requestTimeoutMs, () => {
        req.destroy(new Error(`HTTP request timeout after ${requestTimeoutMs}ms`));
      });
      req.on("error", reject);
    });
  }

  function resolveRedirect(url, maxHops = redirectMaxHops) {
    if (maxHops <= 0) {
      return Promise.resolve(url);
    }
    const headers = {
      "User-Agent": soundcloudUserAgent || youtubeUserAgent || "Mozilla/5.0",
    };
    return new Promise((resolve, reject) => {
      const req = httpsModule.get(url, { headers }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString();
          resolve(resolveRedirect(nextUrl, maxHops - 1));
          return;
        }
        resolve(url);
      });
      req.setTimeout(requestTimeoutMs, () => {
        req.destroy(new Error(`HTTP request timeout after ${requestTimeoutMs}ms`));
      });
      req.on("error", reject);
    });
  }

  return {
    httpGetJson,
    httpGetText,
    resolveRedirect,
  };
}

module.exports = {
  createResolverHttpClient,
};
