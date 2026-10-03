// ESLint (flat config) for the Kardinal Screens server.
//
// SCOPE NOTE, READ BEFORE WIDENING: this lints the Kardinal layer's own
// server JavaScript (the AI operator, the Sentry wrapper, their tests).
// The upstream ScreenTinker tree was written without a linter (a full-tree
// run reports ~500 pre-existing findings, mostly in code we did not write),
// so gating CI on the whole tree would mean either a 500-fix churn commit or
// a permanently red gate. We lint what we own; upstream files stay as-is.
// Widen the `files` lists deliberately, one directory at a time, fixing as
// you go — never by flipping a switch on the whole tree.
import globals from 'globals';

const baseRules = {
  // Dead code and typos are the two cheapest bug classes a linter buys.
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
  'no-undef': 'error',
  // Silent catch blocks hide failures; name the error _e if it is truly ignorable.
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-cond-assign': 'error',
  'no-throw-literal': 'error',
  // == is allowed only for null/undefined checks; everything else must be explicit.
  eqeqeq: ['error', 'smart'],
};

export default [
  {
    files: ['lib/**/*.js', 'routes/**/*.js', 'services/**/*.js', 'middleware/**/*.js', 'db/**/*.js', 'ws/**/*.js', 'test/**/*.js', 'scripts/**/*.js', '*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: baseRules,
  },
];
