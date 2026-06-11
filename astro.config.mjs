import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { NodeGlobalsPolyfillPlugin } from "@esbuild-plugins/node-globals-polyfill";
import { VitePWA } from "vite-plugin-pwa";
import { manifest } from "./src/utils/manifest"

const isDev = process.argv.includes("dev");

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
        "node:stream": "stream-browserify",
      },
    },
    build: {
      rollupOptions: {
        plugins: [
          NodeGlobalsPolyfillPlugin({
            buffer: true,
          }),
        ],
      },
    },
    plugins: [
      !isDev && VitePWA({
        registerType: "autoUpdate",
        manifest,
        workbox: {
          globDirectory: 'dist',
          globPatterns: [
            '**/*.{svg,png,jpg,jpeg,gif,webp,woff,woff2,ttf,eot,ico}',
            // '**/*.{ js,css,svg,png,jpg,jpeg,gif,webp,woff,woff2,ttf,eot,ico}',
          ],
          navigateFallback: null,
        },
      })
    ].filter(Boolean)
  },
  adapter: isDev ? node({ mode: "standalone" }) : cloudflare(),
  integrations: [
    tailwind({
      applyBaseStyles: false,
    }),
    react(),
  ],
});
