import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config. Every spec drives the real game in a real GPU-backed Chromium,
 * exactly like tools/shot.mjs -- the launch args below are copied from there on
 * purpose: without --use-angle=metal the renderer falls back to a software path
 * that boots so slowly the `window.__game` wait times out.
 *
 * workers: 1 and fullyParallel: false are NOT laziness. Each page is a full
 * WebGL scene with a procedural texture forge; two of them on one GPU makes
 * frames take long enough that timing-sensitive assertions start flapping. The
 * suite is meant to be a trustworthy freeze of a working build, not a fast one.
 *
 * webServer reuses the dev server if one is already up (there usually is one on
 * 5273 during development) and only spawns its own when the port is cold.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.js',

  // A cold module graph + texture forge routinely needs 20-30s just to boot, and
  // occasionally far more when the GPU is busy.
  //
  // 120s, NOT 60s, and the reason is a contradiction rather than a preference:
  // fixtures.bootGame waits up to 90s for `window.__game` and says so in its
  // docblock, but a 60s TEST budget expires first, so that 90s could never be
  // spent and the documented tolerance was fiction. Measured: one spec in a
  // clean baseline run failed on exactly that (`page.waitForFunction` at
  // fixtures.js:84, "Test timeout of 60000ms exceeded") and passed on retry —
  // which docs/TESTING.md is explicit is a broken spec, not an acceptable one.
  // The budget now exceeds the boot wait it contains, so a boot that is merely
  // slow is not reported as a failure.
  timeout: 120000,
  expect: { timeout: 15000 },

  fullyParallel: false,
  workers: 1,
  retries: 1,
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: 'http://localhost:5273',
    viewport: { width: 1600, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 900 },
        launchOptions: {
          args: [
            '--use-angle=metal',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist',
            '--mute-audio',
            '--hide-scrollbars',
          ],
        },
      },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5273',
    reuseExistingServer: true,
    timeout: 120000,
  },
});
