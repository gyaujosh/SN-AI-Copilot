import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Deliberately small.
 *
 * No stylistic rules: formatting is already consistent, and a lint run that
 * argues about quotes trains you to ignore lint output. What is kept catches
 * things review misses — a hook with the wrong dependency array, an unused
 * import, an empty block that was meant to hold something.
 *
 * `recommended`, not `recommendedTypeChecked`: type-aware linting needs a
 * project service and roughly triples the run, and `tsc --strict` already
 * covers most of what it would add.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      // Injected into the ServiceNow page context, not bundled. It is ES5 by
      // necessity and references page globals this config cannot know about.
      "public/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // TypeScript resolves identifiers far better than this rule can, and it
      // has no idea about the ServiceNow page globals the content scripts use.
      "no-undef": "off",
      // The content scripts are deliberately conservative ES5-style IIFEs that
      // run inside a page we do not control. Rewriting their `var`s changes
      // hoisting semantics in exchange for nothing.
      "no-var": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      // ServiceNow JSON is loosely typed by nature; `any` at those boundaries
      // is deliberate, and strict mode polices the rest.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}", "preview/**/*.tsx"],
    languageOptions: {
      globals: { ...globals.browser, chrome: "readonly" },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    // The two classic hook rules only. v7's recommended set adds the React
    // Compiler purity rules, which flag long-standing, working patterns here
    // (Date.now() during render for staleness labels, and the like).
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["test/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
