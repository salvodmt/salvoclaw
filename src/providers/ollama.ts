import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

function readDotEnv(): Record<string, string> {
  try {
    const file = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8');
    const result: Record<string, string> = {};
    for (const line of file.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

registerProviderContainerConfig('ollama', (ctx) => {
  const env: Record<string, string> = {
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, 'host.docker.internal'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, 'host.docker.internal'),
  };

  // Read OLLAMA_* from process.env first, then from .env as fallback.
  const envFile = readDotEnv();
  for (const key of ['OLLAMA_BASE_URL', 'OLLAMA_MODEL'] as const) {
    const value = ctx.hostEnv[key] || envFile[key];
    if (value) env[key] = value;
  }
  return { env };
});
