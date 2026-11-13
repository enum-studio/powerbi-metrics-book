import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/.venv/**",
    "**/dist/**",
    "**/coverage/**",
    "**/.astro/**",
    "**/playwright-report/**",
    "**/test-results/**",
    // Written by drizzle-kit on every generate.
    "apps/api/drizzle/**",
    ".claude/worktrees/**",
  ]),
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: [
      "apps/**/*.ts",
      "apps/**/*.tsx",
      "packages/**/*.ts",
      "packages/**/*.tsx",
    ],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // packages/tokens has no tsconfig of its own yet; its config and
          // test files are linted with the base compiler options.
          allowDefaultProject: ["packages/tokens/*.ts"],
          defaultProject: "tsconfig.base.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
