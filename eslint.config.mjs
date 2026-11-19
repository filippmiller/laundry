import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "drizzle/**", ".pgdata*/**", "dist/**", "coverage/**", "temp/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { process: "readonly", console: "readonly", setInterval: "readonly", clearInterval: "readonly", setTimeout: "readonly", clearTimeout: "readonly", fetch: "readonly", require: "readonly", module: "readonly", __dirname: "readonly", Buffer: "readonly", URL: "readonly" } },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      // Unused *arguments* may be marked with a leading underscore (a deliberate
      // "this parameter is intentionally unused" marker). Unused *variables* — which is
      // what an unused import is — may not: allowing it let a stub workspace hide every
      // unused import behind `api as _api` instead of deleting it.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
