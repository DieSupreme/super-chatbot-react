import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/renderer/setup.js'],
    include: ['test/renderer/**/*.test.{js,jsx}'],
  },
});
