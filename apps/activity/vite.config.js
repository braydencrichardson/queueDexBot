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
  const allowedHosts = configuredHosts.length
    ? configuredHosts
    : [
      "localhost",
      "127.0.0.1",
    ];
  const noCacheHeaders = {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
  };

  return {
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      allowedHosts,
      headers: noCacheHeaders,
    },
    preview: {
      host: true,
      port: 4173,
      strictPort: true,
      allowedHosts,
      headers: noCacheHeaders,
    },
  };
});
