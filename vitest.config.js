import { defineConfig } from 'vitest/config';

/**
 * Unit-test config. Deliberately separate from vite.config.js: the game's build
 * config carries chunking rules that mean nothing to a test runner, and Vitest
 * picks this file over vite.config.js when both exist.
 *
 * Scope: only tests/unit. E2E lives in tests/e2e and is driven by Playwright,
 * which has its own config; if Vitest were allowed to glob the whole repo it
 * would try to run the .spec.js files and fail on `@playwright/test` imports.
 *
 * Environment is `node` by default because most of what is worth unit-testing
 * here is pure maths (Grid, Config, TowerDefs, Waves, Pathfinder) and jsdom
 * costs ~200ms of setup per file. A file that needs a DOM opts in with a
 * docblock pragma on its very first line:
 *
 *     // @vitest-environment jsdom
 *
 * Anything importing three.js or src/main.js does NOT belong here -- it needs a
 * real GPU context. Those assertions go in tests/e2e.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    // Collapses ONE known three.js warning (2 506 identical lines, 98.5% of the
    // suite's output) into a single counted summary. It is a filter on one exact
    // prefix, not a mute -- see the file's docblock.
    setupFiles: ['tests/unit/setup.js'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    // Unit tests are pure; nothing should ever take a second.
    testTimeout: 10000,
  },
});
