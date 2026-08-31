import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Mirrors vite.config.ts, so anything importing the build stamp still
  // compiles under the test runner.
  define: { __BUILD_ID__: JSON.stringify('test') },
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
})
