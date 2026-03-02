import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist-panel",
    lib: {
      entry: "src/panel.ts",
      formats: ["iife"],
      name: "HypertreePanel",
      fileName: () => "hypertree.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
