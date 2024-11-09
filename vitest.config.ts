import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['lsif/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});