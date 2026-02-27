import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { VitePWA } from "vite-plugin-pwa";
import { manifest } from "./src/utils/manifest";

// https://astro.build/config
export default defineConfig({
  output: "server",
  vite: {
    define: {
      global: "globalThis",
    },
    resolve: {
      alias: {
        stream: "stream-browserify",
      },
    },
    optimizeDeps: {
      include: ["buffer", "stream-browserify"],
      esbuildOptions: {
        define: {
          global: "globalThis",
        },
      },
    },
    plugins: [
      VitePWA({
        registerType: "autoUpdate",
        manifest,
        workbox: {
          globDirectory: "dist",
          globPatterns: [
            "**/*.{svg,png,jpg,jpeg,gif,webp,woff,woff2,ttf,eot,ico}",
            // '**/*.{ js,css,svg,png,jpg,jpeg,gif,webp,woff,woff2,ttf,eot,ico}',
          ],
          navigateFallback: null,
        },
      }),
    ],
  },
  adapter: cloudflare({
    platformProxy: {
      enabled: true,
      configPath: "wrangler.jsonc",
    },
  }),
  integrations: [
    tailwind({
      applyBaseStyles: false,
    }),
    react(),
  ],
});
