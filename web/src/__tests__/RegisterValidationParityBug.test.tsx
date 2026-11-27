import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Bugfix: Paridad de validación cliente-servidor en Registro (AuthExperience.tsx)', () => {
  const authExpPath = path.resolve(__dirname, '../pages/AuthExperience.tsx');
  const authExpCode = fs.readFileSync(authExpPath, 'utf-8');

  it('AuthExperience.tsx debe exigir estrictamente password.length >= 8 en validatePersonal/passwordScore aun con alta entropía', () => {
    const validatePersonalMatch = authExpCode.match(/function\s+validatePersonal\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(validatePersonalMatch).not.toBeNull();
    const validatePersonalBody = validatePersonalMatch![0];

    // Debe verificar explícitamente data.password.length < 8 en validatePersonal (o bloquear en passwordScore si length < 8)
    const enforcesMin8InValidate = /data\.password\.length\s*<\s*8/.test(validatePersonalBody);
    const enforcesMin8InScore = /if\s*\(\s*password\.length\s*<\s*8\s*\)\s*return\s+0/.test(authExpCode);
    expect(enforcesMin8InValidate || enforcesMin8InScore).toBe(true);
  });

  it('AuthExperience.tsx debe validar longitud mínima de 2 caracteres (trim().length < 2) en firstName y lastName', () => {
    const validatePersonalMatch = authExpCode.match(/function\s+validatePersonal\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(validatePersonalMatch).not.toBeNull();
    const validatePersonalBody = validatePersonalMatch![0];

    expect(validatePersonalBody).toMatch(/firstName\.trim\(\)\.length\s*<\s*2/);
    expect(validatePersonalBody).toMatch(/lastName\.trim\(\)\.length\s*<\s*2/);
  });
});
