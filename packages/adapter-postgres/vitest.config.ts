import { defineConfig } from "vitest/config";

// dist/ holds compiled copies of the tests; running both would race on one database.
export default defineConfig({
  test: { exclude: ["dist/**", "node_modules/**"] },
});
