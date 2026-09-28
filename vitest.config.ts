import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      // Same prefix-trap rationale as faijs-extra: `@faicad/faijs-fcstd` does not
      // match `@faicad/faijs/` prefix rule, so it is safe to alias core here.
      // The sketch library is more specific than core, so its aliases come first.
      { find: '@faicad/faijs-sketch/node', replacement: new URL('../sketch/src/node.ts', import.meta.url).pathname },
      { find: '@faicad/faijs-sketch', replacement: new URL('../sketch/src', import.meta.url).pathname },
      { find: '@faicad/faijs-draw', replacement: new URL('../draw/src', import.meta.url).pathname },
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
