import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  test: {
    environment: 'jsdom', // DOM for the sanitizer/enhancer tests; harmless for the pure ones
    include: ['lib/**/*.test.ts'],
  },
});
