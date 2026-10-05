import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Tests that resize and stitch images (sharp) take a few seconds on a cold, slow CI runner,
    // for example the first one on a Windows runner; the 5 second default timed one out.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
