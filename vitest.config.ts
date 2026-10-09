import { defineConfig } from 'vitest/config';

const skipLiveKit = process.env.CALLSIM_SKIP_LIVEKIT === '1';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.git/**',
      ...(skipLiveKit ? ['test/livekit-run.test.ts', 'test/mcp-livekit.test.ts'] : []),
    ],
  },
});
