import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The web app lives in src/web. In development Vite serves it and forwards /api to the server;
// in production the server serves the built files from dist/web itself.
export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: { port: 5180, proxy: { "/api": "http://127.0.0.1:3101" } },
});
