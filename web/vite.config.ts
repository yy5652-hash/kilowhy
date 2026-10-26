import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: [
            "react",
            "react-dom",
            "react-dom/client",
            "react/jsx-runtime",
          ],
          charts: ["recharts"],
          primitives: ["radix-ui"],
          motion: ["motion/react"],
          answers: ["./src/fixtures/index.ts"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5174",
        changeOrigin: true,
      },
    },
  },
});
