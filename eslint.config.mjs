// The linter: only the rules that find likely bugs, as errors, so `npm run check` (and the
// GitHub Action) fails on them. Promises first: a promise nobody awaits or catches can fail in
// silence (the 2.2 analysis found the start-up one, which left the window hidden).
//   npm run lint
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "src-tauri/**", "dev/**", "samples/**", "docs/**", "scripts/**"] },
  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true, ignoreIIFE: false }],
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
    },
  },
);
