import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

export const repoRoot = path.resolve(__dirname, '../../../..');
export const backendRoot = path.join(repoRoot, 'backend');
export const tsxCliPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

export interface TsxSubprocessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  stdout: string;
  stderr: string;
  parsedJsonLines: Array<Record<string, unknown>>;
}

export function runTsxSnippet(
  code: string,
  envOverrides: Record<string, string | undefined> = {},
  timeoutMs = 15000
): TsxSubprocessResult {
  const tempFile = path.join(
    repoRoot,
    'tests',
    'e2e',
    `.tmp-sub-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`
  );

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, val] of Object.entries(envOverrides)) {
    if (val === undefined) {
      delete env[key];
    } else {
      env[key] = val;
    }
  }

  const backendNodeModules = path.join(backendRoot, 'node_modules');
  const rootNodeModules = path.join(repoRoot, 'node_modules');
  const existingNodePath = env.NODE_PATH
    ? env.NODE_PATH.split(path.delimiter).filter(Boolean)
    : [];
  env.NODE_PATH = Array.from(
    new Set([backendNodeModules, rootNodeModules, ...existingNodePath])
  ).join(path.delimiter);

  const repoRootPosix = repoRoot.replace(/\\/g, '/');
  const normalizedCode = code.replace(/(['"])\.\/backend\//g, `$1${repoRootPosix}/backend/`);

  try {
    fs.writeFileSync(tempFile, normalizedCode, 'utf8');
    const proc = spawnSync(process.execPath, [tsxCliPath, tempFile], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
    });

    const stdout = proc.stdout ?? '';
    const stderr = proc.stderr ?? '';
    const parsedJsonLines: Array<Record<string, unknown>> = [];

    for (const rawLine of stdout.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          parsedJsonLines.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Not a valid JSON line
      }
    }

    return {
      status: proc.status,
      signal: proc.signal,
      ...(proc.error ? { error: proc.error.message } : {}),
      stdout,
      stderr,
      parsedJsonLines,
    };
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}
