import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The components are JSX with the automatic runtime, the way Next compiles them; the one
  // component test renders the server markup, so the transform has to match the app.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
