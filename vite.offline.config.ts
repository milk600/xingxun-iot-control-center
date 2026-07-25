import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "offline",
  base: "/",
  publicDir: "../public",
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "next/navigation",
        replacement: fileURLToPath(new URL("./offline/next-navigation.ts", import.meta.url)),
      },
      {
        find: "@",
        replacement: fileURLToPath(new URL("./", import.meta.url)),
      },
    ],
  },
  build: {
    outDir: "../android/app/src/main/assets/web",
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false,
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three/")) return "three";
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
});
