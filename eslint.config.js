import deprecation from "eslint-plugin-deprecation";
import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import prettier from "eslint-plugin-prettier";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import ts from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import xo from "eslint-config-xo";
// @ts-check

const compat = new FlatCompat();

/**
 * @type {import('eslint').Linter.Config}
 */
export default [
  js.configs.recommended,
  ...compat.config(ts.configs["eslint-recommended"]),
  ...compat.extends("plugin:@typescript-eslint/recommended"),
  ...compat.config(xo),
  ...compat.config(prettier.configs.recommended),
  {
    languageOptions: {
      globals: {
        node: true,
      },
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        project: "./tsconfig.json",
        sourceType: "module",
        warnOnUnsupportedTypeScriptVersion: false,
      },
    },
    plugins: { deprecation, ts, simpleImportSort },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      camelcase: "off",
      "prettier/prettier": "warn",
      "no-redeclare": "off",
      "@typescript-eslint/no-redeclare": ["error"],
      "no-unused-vars": "off",
    },
  },
];
