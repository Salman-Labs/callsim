import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

export function packageVersion(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
      cached = parsed.version ?? '0.0.0';
      return cached;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = '0.0.0';
  return cached;
}
