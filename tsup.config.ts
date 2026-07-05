import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', transports: 'src/transports/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
});
