import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    env: {
      // Every git the tests start — theirs and the engine's — runs without
      // automatic housekeeping. After a burst of merges git starts `gc --auto`
      // in the background, and it was still writing .git/objects when a test
      // removed its temporary repository: "ENOTEMPTY: directory not empty",
      // twice in a row on the publish job, which held back two releases.
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'gc.auto',
      GIT_CONFIG_VALUE_0: '0',
      GIT_CONFIG_KEY_1: 'maintenance.auto',
      GIT_CONFIG_VALUE_1: 'false',
    },
  },
})
