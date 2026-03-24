import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(),
           VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Yatriso',
        short_name: 'Yatriso',
        description: 'Your Cloudflare-first travel companion',
        theme_color: '#ffffff',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      }
    })],
  build: {
    outDir: "../../dist",
    emptyOutDir: true
  }
});
