import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "lib/**",
      "scripts/**",
      ".deploy-test/**",
      ".jest-cache/**",
      "**/*.cjs",
      "**/*.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The eslint-disable directives in the source target type-checked rules that this lighter,
    // non-type-checked config does not enable, so don't flag them as unused.
    linterOptions: { reportUnusedDisableDirectives: false },
    languageOptions: { globals: { ...globals.node } },
    // The ANSI-stripping regex in review.ts intentionally matches the ESC (\x1b) control character.
    rules: { "no-control-regex": "off" },
  },
  {
    files: ["**/*.test.ts"],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
);
