import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      // Same prefix-trap rationale as faijs-extra: `@faicad/faijs-fcstd` does not
      // match `@faicad/faijs/` prefix rule, so it is safe to alias core here.
      { find: '@faicad/faijs', replacement: new URL('../core/src', import.meta.url).pathname },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 300000,
    hookTimeout: 300000,
  },
})
