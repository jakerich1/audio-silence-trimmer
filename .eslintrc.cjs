// .eslintrc.cjs
module.exports = {
  root: true,
  env: { node: true, es2022: true },

  // Don't lint build artifacts or config files
  ignorePatterns: [
    "dist/",
    "node_modules/",
    ".eslintrc.cjs",
    "tsconfig*.json",
    "*.config.js",
    "*.config.cjs",
    "*.config.mjs"
  ],

  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["./tsconfig.eslint.json"],
    tsconfigRootDir: __dirname,
    sourceType: "module"
  },

  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking"
  ],

  rules: {
    // Ban explicit any
    "@typescript-eslint/no-explicit-any": "error",
    // Good hygiene
    "@typescript-eslint/consistent-type-imports": "error",
    "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: true }],
    "@typescript-eslint/ban-ts-comment": ["error", { "ts-ignore": "allow-with-description" }]
  },

  // JS config files (if you decide to lint them later) — parse as plain JS, no TS project
  overrides: [
    {
      files: ["*.js", "*.cjs", "*.mjs"],
      parser: "espree",
      parserOptions: { sourceType: "script" },
      rules: {}
    }
  ]
};
