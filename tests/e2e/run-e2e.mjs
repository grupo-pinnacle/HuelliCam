import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

const args = new Set(process.argv.slice(2));
const nodeOnly = args.has('--node-only');
const domOnly = args.has('--dom-only');

const results = [];

function runStep(name, commandArgs) {
  console.log(`\n=== [E2E] Running ${name} ===`);
  const proc = spawnSync(process.execPath, commandArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CI: 'true',
      FORCE_COLOR: '0',
    },
  });
  const exitCode = typeof proc.status === 'number' ? proc.status : 1;
  results.push({ name, exitCode });
  console.log(`=== [E2E] ${name} exited with code ${exitCode} ===`);
  return exitCode;
}

if (!domOnly) {
  const jestBin = path.join(repoRoot, 'node_modules', 'jest', 'bin', 'jest.js');
  const jestConfig = path.join(__dirname, 'jest.config.js');
  runStep('Node/Backend E2E (Jest)', [
    jestBin,
    '--config',
    jestConfig,
    '--runInBand',
    '--no-color',
  ]);
}

if (!nodeOnly) {
  const vitestConfig = path.join(__dirname, 'vitest.config.ts');
  if (fs.existsSync(vitestConfig)) {
    const vitestBin = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
    runStep('Frontend/DOM E2E (Vitest)', [
      vitestBin,
      'run',
      '--config',
      vitestConfig,
      '--no-color',
    ]);
  } else {
    console.log('\n=== [E2E] Frontend/DOM E2E skipped (vitest.config.ts not found yet) ===');
  }
}

console.log('\n=== [E2E] Summary ===');
for (const entry of results) {
  console.log(`- ${entry.name}: ${entry.exitCode === 0 ? 'PASS' : `FAIL (${entry.exitCode})`}`);
}

const hasFailure = results.some((r) => r.exitCode !== 0);
process.exit(hasFailure ? 1 : 0);
