// ESLint flat config — Next.js recommended (core-web-vitals + TypeScript).
// eslint-config-next 15.x ships legacy "extends" configs, so FlatCompat bridges
// them. Run through Docker (the host has no npm) — see CLAUDE.md "Lint".
// The Docker builder stage runs `npm run lint`: an ERROR fails the build,
// warnings do not.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "coverage/**",
      "public/**",
      "next-env.d.ts",
      // not app source
      "USB Files/**",
      "backups/**",
      "uploads/**",
      "timesheet-template/**",
      "docs/**",
      "scripts/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // Effects with deliberately partial dependency lists carry a disable
      // comment explaining why; keep it a warning.
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // The full backup/restore code and test mocks use `any` on purpose
      // (with file-level disable comments); elsewhere it is a heads-up only.
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
    },
  },
  {
    // Plain Node CommonJS scripts (e.g. prisma/migrate-state.js, run by the
    // migrate image) — require() is the correct import form there.
    files: ["prisma/**/*.js", "**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { require: "readonly", module: "writable", process: "readonly", console: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

export default eslintConfig;
