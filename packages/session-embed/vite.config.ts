import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  base: "./",
  build: {
    target: "esnext",
    cssCodeSplit: false,
    lib: { entry: "src/index.tsx", formats: ["es"], fileName: () => "session-embed.js" },
    rollupOptions: {
      output: {
        chunkFileNames: "assets/[name]-[hash].js",
        // the host links the stylesheet by name, so it must not carry a hash
        assetFileNames: (asset) =>
          asset.names.some((n) => n.endsWith(".css")) ? "session-embed.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
  worker: { format: "es" },
})
