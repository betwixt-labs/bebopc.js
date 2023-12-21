/// <reference types="vitest" />
import { defineConfig, splitVendorChunkPlugin } from "vite";
import { comlink } from "vite-plugin-comlink";
import Inspect from "vite-plugin-inspect";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { resolve } from "path";

// https://vitejs.dev/config/
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{js,ts}"]
  },
  base: "./",
  plugins: [
    Inspect(),
    comlink(),
    splitVendorChunkPlugin(),
    nodePolyfills(),
    viteStaticCopy({
      targets: [
        /* {
          src: "node_modules/coi-serviceworker/coi-serviceworker.min.js",
          dest: ".",
        },*/
        /*{
          src: "./bin/bebopc.wasm",
          dest: ".",
        },
        */
      ],
    }),
  ],
  worker: {
    plugins: () => [comlink()],
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: Infinity,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "bebopc",
      fileName: "bebopc",
    },
  },
});
