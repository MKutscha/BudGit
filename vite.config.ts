import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    VitePWA({
      disable: mode !== "web", // Desktop-Build bleibt ohne Service Worker
      registerType: "prompt", // kein automatisches Neuladen mitten in der Eingabe
      injectRegister: false,
      manifest: {
        name: "BudGit", short_name: "BudGit", lang: "de",
        description: "Haushaltskosten fair teilen",
        start_url: "/", scope: "/", display: "standalone",
        background_color: "#edf0ee", theme_color: "#0e5b4c",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: { globPatterns: ["**/*.{js,css,html,svg,png,woff2}"], navigateFallback: "/index.html" },
    }),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
