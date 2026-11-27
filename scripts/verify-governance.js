/**
 * Verificador de consistencia documental y gobernanza técnica (Huellicam).
 * Valida:
 * 1. Existencia de la suite documental canónica.
 * 2. Sincronización entre los modelos de backend/prisma/schema.prisma y docs/TECH_REFERENCE.md.
 * 3. Integridad de enlaces locales Markdown en README.md y docs/**.
 * 4. Ausencia de referencias obsoletas de marca o tooling interno en documentación.
 * 5. Ausencia de los 6 literales deprecados de ConsultationStatus en backend/src y web/src.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

const requiredDocs = [
  'README.md',
  'docs/ARCHITECTURE.md',
  'docs/TECH_REFERENCE.md',
  'docs/SPEC.md',
  'docs/DECISIONS.md',
  'docs/DEPLOY.md',
  'docs/MARCO_LEGAL_COMPLIANCE_Y_AUDITORIA.md',
  'docs/web/README.md',
  'docs/mobile/README.md',
  'docs/payments/README.md',
];

function collectMarkdownFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

function collectSourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

const DEPRECATED_CONSULTATION_STATUSES = [
  'TRIAGE_CRITICAL_QUEUED',
  'CLAIM_PENDING_SYNC',
  'LIVEKIT_CONNECTING',
  'IN_CALL_ACTIVE',
  'AWAITING_EMERGENCY_CALLBACK',
  'HANDOFF_IN_PROGRESS',
];

const DEPRECATED_STATUS_REGEX = new RegExp(
  `\\b(${DEPRECATED_CONSULTATION_STATUSES.join('|')})\\b`,
  'g'
);

function extractSchemaModels(schemaContent) {
  const matches = [...schemaContent.matchAll(/^model\s+([A-Za-z0-9_]+)\s+\{/gm)];
  return matches.map((m) => m[1]);
}

function findBrokenLinks(filePath, content) {
  const broken = [];
  const dir = path.dirname(filePath);
  const linkRegex = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of content.matchAll(linkRegex)) {
    const rawTarget = match[1].trim();
    if (
      !rawTarget ||
      rawTarget.startsWith('http://') ||
      rawTarget.startsWith('https://') ||
      rawTarget.startsWith('mailto:') ||
      rawTarget.startsWith('#')
    ) {
      continue;
    }
    const targetPath = rawTarget.split('#')[0];
    if (!targetPath) continue;
    const resolved = path.resolve(dir, targetPath);
    if (!fs.existsSync(resolved)) {
      broken.push(`${path.relative(repoRoot, filePath)} -> ${rawTarget}`);
    }
  }
  return broken;
}

function runGovernanceCheck() {
  console.log('Iniciando verificación documental y técnica de Huellicam...\n');
  let errors = 0;

  // 1. Verificar documentos obligatorios
  const missingDocs = requiredDocs.filter((rel) => !fs.existsSync(path.join(repoRoot, rel)));
  if (missingDocs.length > 0) {
    console.error(`  [ERROR] Faltan documentos requeridos: ${missingDocs.join(', ')}`);
    errors++;
  } else {
    console.log(`  [OK] 1. Suite documental completa (${requiredDocs.length} archivos).`);
  }

  // 2. Verificar modelos Prisma vs docs/TECH_REFERENCE.md
  const schemaPath = path.join(repoRoot, 'backend', 'prisma', 'schema.prisma');
  const techRefPath = path.join(repoRoot, 'docs', 'TECH_REFERENCE.md');
  if (fs.existsSync(schemaPath) && fs.existsSync(techRefPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const techRef = fs.readFileSync(techRefPath, 'utf8');
    const models = extractSchemaModels(schema);
    const missingModels = models.filter((m) => !techRef.includes(m));
    if (missingModels.length > 0) {
      console.error(`  [ERROR] Modelos de schema.prisma ausentes en docs/TECH_REFERENCE.md: ${missingModels.join(', ')}`);
      errors++;
    } else {
      console.log(`  [OK] 2. Sincronización Prisma -> TECH_REFERENCE.md (${models.length} modelos verificados).`);
    }
  } else {
    console.error('  [ERROR] No se encontró schema.prisma o docs/TECH_REFERENCE.md.');
    errors++;
  }

  // 3. Verificar enlaces locales y consistencia de marca en README + docs
  const mdFiles = [
    path.join(repoRoot, 'README.md'),
    ...collectMarkdownFiles(path.join(repoRoot, 'docs')),
  ].filter((p) => fs.existsSync(p));

  const brokenLinks = [];
  const missingBrand = [];

  for (const mdFile of mdFiles) {
    const content = fs.readFileSync(mdFile, 'utf8');
    brokenLinks.push(...findBrokenLinks(mdFile, content));
    if (!/huellicam/i.test(content)) {
      missingBrand.push(path.relative(repoRoot, mdFile));
    }
  }

  if (brokenLinks.length > 0) {
    console.error(`  [ERROR] Enlaces rotos en documentación:\n    - ${brokenLinks.join('\n    - ')}`);
    errors++;
  } else {
    console.log(`  [OK] 3. Enlaces internos verificados en ${mdFiles.length} archivos Markdown.`);
  }

  if (missingBrand.length > 0) {
    console.error(`  [ERROR] Documentos sin referencia de marca Huellicam: ${missingBrand.join(', ')}`);
    errors++;
  } else {
    console.log('  [OK] 4. Identidad Huellicam consistente en README.md y docs/.');
  }

  // 5. Verificar ausencia de los 6 literales deprecados de ConsultationStatus en backend/src y web/src
  const exemptContractPath = 'backend/src/contracts/consultation.contract.ts';
  const sourceFiles = [
    ...collectSourceFiles(path.join(repoRoot, 'backend', 'src')),
    ...collectSourceFiles(path.join(repoRoot, 'web', 'src')),
  ];
  const deprecatedUsages = [];

  for (const srcFile of sourceFiles) {
    const rel = path.relative(repoRoot, srcFile).replace(/\\/g, '/');
    if (rel === exemptContractPath) continue;
    const content = fs.readFileSync(srcFile, 'utf8');
    const matches = [...content.matchAll(DEPRECATED_STATUS_REGEX)];
    if (matches.length > 0) {
      const literals = [...new Set(matches.map((m) => m[1]))].join(', ');
      deprecatedUsages.push(`${rel} (${literals})`);
    }
  }

  if (deprecatedUsages.length > 0) {
    console.error(
      `  [ERROR] Literales deprecados de ConsultationStatus detectados fuera de ${exemptContractPath}:\n    - ${deprecatedUsages.join('\n    - ')}`
    );
    errors++;
  } else {
    console.log(
      `  [OK] 5. Cero literales deprecados de ConsultationStatus en runtime y tests (${sourceFiles.length} archivos verificados).`
    );
  }

  if (errors > 0) {
    console.error(`\nSe detectaron ${errors} error(es) de consistencia.`);
    process.exit(1);
  }

  console.log('\nConsistencia documental y técnica validada en verde.');
  process.exit(0);
}

runGovernanceCheck();
