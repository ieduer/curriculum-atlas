#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildSync } from 'esbuild';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BRIDGE_SOURCES = ['src/index.ts', 'src/retrieval.ts', 'src/admin.ts'];
const MIGRATION_ORDER = [
  '0008_release_ownership_fences.sql',
  '0009_compendium_embedded_items.sql',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function exactFile(root, path) {
  const bytes = readFileSync(resolve(root, path));
  return { path, sha256: sha256(bytes), bytes: bytes.length };
}

function bridgeRuntime(root) {
  const result = buildSync({
    absWorkingDir: root,
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    legalComments: 'none',
    logLevel: 'silent',
    sourcemap: false,
    write: false,
  });
  if (result.outputFiles.length !== 1) throw new Error('bridge Worker runtime bundle is incomplete');
  const bytes = Buffer.from(result.outputFiles[0].contents);
  return {
    entrypoint: 'src/index.ts',
    format: 'esm',
    target: 'es2022',
    sha256: sha256(bytes),
    bytes: bytes.length,
  };
}

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
}

function probe(db, stage) {
  const tables = tableNames(db);
  const embeddedItems = tables.has('embedded_items');
  const releaseOwnershipFences = tables.has('release_publication_ownership')
    && tables.has('release_publication_activation_claim');
  const paragraphColumns = columnNames(db, 'paragraphs');
  const commentColumns = columnNames(db, 'comments');
  const coreCounts = JSON.parse(db.prepare(`SELECT json_object(
    'subjects',(SELECT COUNT(*) FROM subjects),
    'periods',(SELECT COUNT(*) FROM periods),
    'document_relations',(SELECT COUNT(*) FROM document_relations),
    'chapters',(SELECT COUNT(*) FROM chapters),
    'document_classifications',(SELECT COUNT(*) FROM document_classifications),
    'document_sources',(SELECT COUNT(*) FROM document_sources),
    'primary_document_sources',(SELECT COUNT(*) FROM document_sources WHERE is_primary=1),
    'subject_insights',(SELECT COUNT(*) FROM subject_insights),
    'terms',(SELECT COUNT(*) FROM terms),
    'term_relations',(SELECT COUNT(*) FROM term_relations),
    'version_diffs',(SELECT COUNT(*) FROM version_diffs),
    'online_verifications',(SELECT COUNT(*) FROM online_verifications),
    'online_evidence',(SELECT COUNT(*) FROM online_evidence),
    'embedded_items',${embeddedItems ? '(SELECT COUNT(*) FROM embedded_items)' : '0'}
  ) AS value`).get().value);
  if (Object.keys(coreCounts).length !== 14 || coreCounts.embedded_items !== 0) {
    throw new Error(`${stage} bridge core-count projection is incomplete`);
  }
  const adminCommentsProjection = embeddedItems ? 'column' : 'null';
  db.prepare(`SELECT c.id,c.parent_id,c.document_id,${embeddedItems
    ? 'c.embedded_item_id'
    : 'NULL AS embedded_item_id'},c.paragraph_id,c.author_name,
    c.author_kind,c.body,c.status,c.moderation_note,c.created_at,c.updated_at,d.title AS document_title
    FROM comments c LEFT JOIN documents d ON d.id=c.document_id
    WHERE (?='all' OR c.status=?) ORDER BY c.created_at DESC,c.id DESC LIMIT ? OFFSET ?`)
    .all('all', 'all', 1, 0);
  return {
    stage,
    release_ownership_fences: releaseOwnershipFences,
    embedded_items: embeddedItems,
    paragraphs_embedded_item_id: paragraphColumns.has('embedded_item_id'),
    comments_embedded_item_id: commentColumns.has('embedded_item_id'),
    core_table_key_count: Object.keys(coreCounts).length,
    admin_comments_projection: adminCommentsProjection,
    admin_comments_query: true,
  };
}

function assertBridgeSource(root) {
  const index = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
  const retrieval = readFileSync(resolve(root, 'src/retrieval.ts'), 'utf8');
  const admin = readFileSync(resolve(root, 'src/admin.ts'), 'utf8');
  for (const [label, source, patterns] of [
    ['Worker', index, [
      /schemaCapabilities\(env/, /legacy_bridge/, /capabilities\.embeddedItems/,
      /releaseOwnershipFences/, /sqlite_master/,
    ]],
    ['retrieval', retrieval, [/sqlite_master/, /embeddedItems \?/, /NULL AS embedded_item_id/]],
    ['admin', admin, [/embeddedItems/, /c\.embedded_item_id/, /NULL AS embedded_item_id/]],
  ]) {
    for (const pattern of patterns) {
      if (!pattern.test(source)) throw new Error(`${label} bridge source lacks ${pattern}`);
    }
  }
}

export function validateDualSchemaBootstrapReceipt(value, { root = DEFAULT_ROOT, verifyFiles = true } = {}) {
  if (value?.schema_version !== 1 || value?.contract !== 'curriculum_dual_schema_bootstrap_v1'
      || value?.generated_by !== 'scripts/verify-dual-schema-bootstrap.mjs'
      || value?.verified !== true) throw new Error('dual-schema bootstrap receipt identity is invalid');
  if (stableStringify(value.executable_order) !== stableStringify([
    'deploy_bridge_worker',
    'apply_0008_release_ownership_fences',
    'apply_0009_compendium_embedded_items',
    'collect_post_migration_environment_evidence',
  ])) throw new Error('dual-schema bootstrap executable order is invalid');
  if (!Array.isArray(value.bridge_sources) || !Array.isArray(value.migrations)
      || value.bridge_sources.map((entry) => entry.path).join(',') !== BRIDGE_SOURCES.join(',')
      || value.migrations.map((entry) => entry.name).join(',') !== MIGRATION_ORDER.join(',')) {
    throw new Error('dual-schema bootstrap source or migration order is invalid');
  }
  if (value.bridge_runtime?.entrypoint !== 'src/index.ts'
      || value.bridge_runtime?.format !== 'esm'
      || value.bridge_runtime?.target !== 'es2022'
      || !SHA256_PATTERN.test(String(value.bridge_runtime?.sha256 || ''))
      || !Number.isSafeInteger(value.bridge_runtime?.bytes)
      || value.bridge_runtime.bytes <= 0) {
    throw new Error('dual-schema bootstrap Worker runtime identity is invalid');
  }
  for (const entry of [...value.bridge_sources, ...value.migrations]) {
    if (!SHA256_PATTERN.test(String(entry.sha256 || '')) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
      throw new Error('dual-schema bootstrap file identity is invalid');
    }
  }
  const expectedProbes = [
    { stage: 'legacy_0007', release_ownership_fences: false, embedded_items: false, paragraphs_embedded_item_id: false, comments_embedded_item_id: false, core_table_key_count: 14, admin_comments_projection: 'null', admin_comments_query: true },
    { stage: 'fenced_0008', release_ownership_fences: true, embedded_items: false, paragraphs_embedded_item_id: false, comments_embedded_item_id: false, core_table_key_count: 14, admin_comments_projection: 'null', admin_comments_query: true },
    { stage: 'compendium_0009', release_ownership_fences: true, embedded_items: true, paragraphs_embedded_item_id: true, comments_embedded_item_id: true, core_table_key_count: 14, admin_comments_projection: 'column', admin_comments_query: true },
  ];
  if (stableStringify(value.probes) !== stableStringify(expectedProbes)) {
    throw new Error('dual-schema bootstrap executable probes are invalid');
  }
  const { receipt_sha256: declared, ...projection } = value;
  if (!SHA256_PATTERN.test(String(declared || '')) || sha256(stableStringify(projection)) !== declared) {
    throw new Error('dual-schema bootstrap receipt hash mismatch');
  }
  if (verifyFiles) {
    const expectedSources = BRIDGE_SOURCES.map((path) => exactFile(root, path));
    const expectedRuntime = bridgeRuntime(root);
    const expectedMigrations = MIGRATION_ORDER.map((name) => {
      const file = exactFile(root, `migrations/${name}`);
      return { name, sha256: file.sha256, bytes: file.bytes };
    });
    if (stableStringify(value.bridge_sources) !== stableStringify(expectedSources)
        || stableStringify(value.bridge_runtime) !== stableStringify(expectedRuntime)
        || stableStringify(value.migrations) !== stableStringify(expectedMigrations)) {
      throw new Error('dual-schema bootstrap receipt does not bind the candidate source bytes');
    }
  }
  return value;
}

export function verifyDualSchemaBootstrap({ root = DEFAULT_ROOT } = {}) {
  assertBridgeSource(root);
  const db = new DatabaseSync(':memory:');
  try {
    for (let index = 1; index <= 7; index += 1) {
      const prefix = String(index).padStart(4, '0');
      const migration = [
        '0001_initial.sql',
        '0002_source_provenance_and_ocr_quality.sql',
        '0003_online_verification.sql',
        '0004_document_classifications.sql',
        '0005_page_publication_gate.sql',
        '0006_corpus_import_release.sql',
        '0007_document_taxonomy_contract.sql',
      ][index - 1];
      if (!migration.startsWith(prefix)) throw new Error('bootstrap migration inventory drift');
      db.exec(readFileSync(resolve(root, 'migrations', migration), 'utf8'));
    }
    const probes = [probe(db, 'legacy_0007')];
    db.exec(readFileSync(resolve(root, 'migrations', MIGRATION_ORDER[0]), 'utf8'));
    probes.push(probe(db, 'fenced_0008'));
    db.exec(readFileSync(resolve(root, 'migrations', MIGRATION_ORDER[1]), 'utf8'));
    probes.push(probe(db, 'compendium_0009'));
    const projection = {
      schema_version: 1,
      contract: 'curriculum_dual_schema_bootstrap_v1',
      generated_by: 'scripts/verify-dual-schema-bootstrap.mjs',
      verified: true,
      executable_order: [
        'deploy_bridge_worker',
        'apply_0008_release_ownership_fences',
        'apply_0009_compendium_embedded_items',
        'collect_post_migration_environment_evidence',
      ],
      bridge_sources: BRIDGE_SOURCES.map((path) => exactFile(root, path)),
      bridge_runtime: bridgeRuntime(root),
      migrations: MIGRATION_ORDER.map((name) => {
        const file = exactFile(root, `migrations/${name}`);
        return { name, sha256: file.sha256, bytes: file.bytes };
      }),
      probes,
    };
    return validateDualSchemaBootstrapReceipt({
      ...projection,
      receipt_sha256: sha256(stableStringify(projection)),
    }, { root });
  } finally {
    db.close();
  }
}

function main() {
  const receipt = verifyDualSchemaBootstrap({ root: process.argv[2] || DEFAULT_ROOT });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`verify-dual-schema-bootstrap: ${error.message}\n`);
    process.exitCode = 1;
  }
}
