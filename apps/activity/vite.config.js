import { defineConfig, loadEnv } from "vite";

function parseAllowedHosts(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const configuredHosts = parseAllowedHosts(env.VITE_ALLOWED_HOSTS);
  const apiProxyTarget = String(env.VITE_ACTIVITY_API_PROXY_TARGET || "http://127.0.0.1:8787").trim();
  const allowedHosts = configuredHosts.length
    ? configuredHosts
    : [
      "localhost",
      "127.0.0.1",
    ];
  const proxy = apiProxyTarget
    ? {
      "/auth": {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: false,
      },
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: false,
      },
    }
    : undefined;
  const noCacheHeaders = {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
  };

  return {
    define: {
      __QDEX_ACTIVITY_BUILD__: JSON.stringify(`${new Date().toISOString()}|${mode}`),
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      allowedHosts,
      headers: noCacheHeaders,
      proxy,
    },
    preview: {
      host: true,
      port: 4173,
      strictPort: true,
      allowedHosts,
      headers: noCacheHeaders,
      proxy,
    },
  };
});
