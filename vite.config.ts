import { defineConfig } from "vite";
import fs from "fs";

const https = fs.existsSync(".certs/key.pem")
  ? { key: fs.readFileSync(".certs/key.pem"), cert: fs.readFileSync(".certs/cert.pem") }
  : undefined;

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
  },
  server: { https },
});
