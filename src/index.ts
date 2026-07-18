import { answerWithEvidence } from './ai';
import { getSession, requireAdmin, requireAuthenticated } from './auth';
import { clampInt, HttpError, json, readJson, requireSameOrigin, secureHeaders, textParam } from './http';
import { retrieve } from './retrieval';
import { enforceRateLimit, verifyTurnstile } from './security';
import type { Env, Session } from './types';

const VERSION = '2026.07.18-v11';
const R2_CURRENT_POINTER_KEY = 'release/current.json';
const R2_INGEST_MANIFEST_KEY = 'catalog/ingest-manifest.json';
const R2_RELEASE_PREFIX = 'releases';
const R2_RELEASE_ID_PATTERN = /^release-[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_RELEASE_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_INGEST_MANIFEST_BYTES = 64 * 1024 * 1024;
const GRAPH_SHARD_TRANSPORT = 'immutable-content-addressed-graph-shards-v1';
const MAX_GRAPH_INDEX_BYTES = 512 * 1024;
const REQUIRED_CLASSIFICATION_COUNTS = {
  documents: 196,
  academicIdentities: 160,
  subjects: 159,
  assessmentSubjects: 1,
  displayFacets: 12,
  courses: 16,
  scopes: 20,
  unclassified: 0,
} as const;
const CORE_TABLE_COUNT_KEYS = [
  'subjects',
  'periods',
  'document_relations',
  'chapters',
  'document_classifications',
  'document_sources',
  'primary_document_sources',
  'subject_insights',
  'terms',
  'term_relations',
  'version_diffs',
  'online_verifications',
  'online_evidence',
  'embedded_items',
] as const;
const LEGACY_ZERO_CORE_TABLES = new Set<string>([
  'subjects',
  'document_relations',
  'chapters',
  'version_diffs',
]);
type CoreTableCountKey = typeof CORE_TABLE_COUNT_KEYS[number];
type CoreTableCounts = Record<CoreTableCountKey, number>;

interface CommentInput {
  documentId?: string;
  paragraphId?: number;
  parentId?: string;
  authorName?: string;
  body?: string;
  turnstileToken?: string;
}

interface AiInput {
  query?: string;
  subject?: string;
}

interface CorpusReleaseStatus {
  release_id: string;
  release_fingerprint_sha256: string;
  manifest_sha256: string;
  state: string;
  expected_documents: number;
  expected_paragraphs: number;
  expected_fts_rows: number;
  expected_page_gates: number;
  expected_displayed_paragraphs: number;
  accepted_ocr_documents: number;
  expected_chunks: number;
  expected_core_counts_json: string;
  actual_documents: number | null;
  actual_paragraphs: number | null;
  actual_fts_rows: number | null;
  actual_page_gates: number | null;
  actual_displayed_paragraphs: number | null;
  actual_chunks: number | null;
  actual_core_counts_json: string | null;
  live_documents: number;
  live_paragraphs: number;
  live_fts_rows: number;
  live_page_gates: number;
  live_displayed_paragraphs: number;
  live_accepted_ocr_documents: number;
  live_chunks: number;
  live_core_counts_json: string;
}

interface R2ReleasePointer {
  schema_version: 1;
  release_id: string;
  release_manifest_key: string;
  release_manifest_sha256: string;
  release_manifest_bytes: number;
  managed_object_count: number;
}

interface R2ReleaseAsset {
  key: string;
  release_key: string;
  sha256: string;
  bytes: number;
  content_type?: string;
}

interface GraphReleaseHealth {
  ready: boolean;
  transportProfile: string | null;
  buildRevision: string | null;
  shardCount: number;
  shardBytes: number;
  descriptorSetSha256: string | null;
}

function optionalParagraphId(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000_000_000) {
    throw new HttpError(400, '段落编号无效');
  }
  return value;
}

function cacheJson(data: unknown, seconds = 300): Response {
  return json(data, 200, { 'cache-control': `public, max-age=${seconds}, stale-while-revalidate=${seconds * 4}` });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function graphReleaseHealth(env: Env): Promise<GraphReleaseHealth> {
  try {
    const indexes = [] as Array<Record<string, unknown>>;
    const indexBytes = [] as Array<ArrayBuffer>;
    for (const path of ['/data/concept-evolution.json', '/data/concept-evolution-academic.json']) {
      const response = await env.ASSETS.fetch(new Request(new URL(path, env.SITE_ORIGIN)));
      const bytes = await response.arrayBuffer();
      if (!response.ok || bytes.byteLength < 1 || bytes.byteLength > MAX_GRAPH_INDEX_BYTES) throw new Error('graph index unavailable');
      indexes.push(JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>);
      indexBytes.push(bytes);
    }
    const [core, academic] = indexes as Array<{
      transport_profile?: unknown;
      build_revision?: unknown;
      academic_model_ref?: { sha256?: unknown; bytes?: unknown; transport_profile?: unknown };
      shard_manifest?: { transport_profile?: unknown; build_revision?: unknown; max_shard_bytes?: unknown; assets?: unknown };
    }>;
    if (core.transport_profile !== GRAPH_SHARD_TRANSPORT || academic.transport_profile !== GRAPH_SHARD_TRANSPORT
      || typeof core.build_revision !== 'string' || !SHA256_PATTERN.test(core.build_revision)
      || academic.build_revision !== core.build_revision
      || core.academic_model_ref?.sha256 !== await sha256Hex(indexBytes[1])
      || core.academic_model_ref?.bytes !== indexBytes[1].byteLength
      || core.academic_model_ref?.transport_profile !== GRAPH_SHARD_TRANSPORT) throw new Error('graph index identity drift');
    const descriptors: Array<Record<string, unknown>> = [];
    const ids = new Set<string>();
    const paths = new Set<string>();
    const kindById = new Map<string, string>();
    for (const index of indexes as Array<{ build_revision: string; shard_manifest?: { transport_profile?: unknown; build_revision?: unknown; max_shard_bytes?: unknown; assets?: unknown } }>) {
      const manifest = index.shard_manifest;
      if (manifest?.transport_profile !== GRAPH_SHARD_TRANSPORT || manifest.build_revision !== index.build_revision
        || manifest.max_shard_bytes !== MAX_GRAPH_INDEX_BYTES || !Array.isArray(manifest.assets)) throw new Error('graph shard manifest drift');
      for (const descriptor of manifest.assets as Array<Record<string, unknown>>) {
        const id = String(descriptor.id || '');
        const path = String(descriptor.path || '');
        const kind = String(descriptor.kind || '');
        const counts = descriptor.counts;
        const descriptorKeys = Object.keys(descriptor).sort();
        if (!id || ids.has(id) || !path.startsWith('/data/graph-shards/') || path.includes('..') || paths.has(path)
          || !kind
          || descriptorKeys.join(',') !== 'build_revision,bytes,counts,filters,id,kind,path,sha256'
          || !counts || typeof counts !== 'object' || Array.isArray(counts)
          || Object.values(counts as Record<string, unknown>).some((count) => !Number.isInteger(count) || Number(count) < 0)
          || !descriptor.filters || typeof descriptor.filters !== 'object' || Array.isArray(descriptor.filters)
          || descriptor.build_revision !== index.build_revision || !SHA256_PATTERN.test(String(descriptor.sha256 || ''))
          || !Number.isInteger(descriptor.bytes) || Number(descriptor.bytes) < 1 || Number(descriptor.bytes) > MAX_GRAPH_INDEX_BYTES) {
          throw new Error('graph shard descriptor drift');
        }
        ids.add(id);
        paths.add(path);
        kindById.set(id, kind);
        descriptors.push(descriptor);
      }
    }
    const coreGraph = core as unknown as {
      episodes?: Array<{ id?: unknown; detail_shard_ids?: unknown }>;
      edges?: Array<{ source?: unknown; target?: unknown }>;
    };
    if (!Array.isArray(coreGraph.episodes) || !Array.isArray(coreGraph.edges)) throw new Error('graph core topology missing');
    const episodeIds = new Set(coreGraph.episodes.map((episode) => String(episode.id || '')));
    if (episodeIds.has('') || episodeIds.size !== coreGraph.episodes.length) throw new Error('graph episode identity drift');
    for (const episode of coreGraph.episodes) {
      const detailIds = episode.detail_shard_ids;
      if (!Array.isArray(detailIds) || detailIds.length === 0 || new Set(detailIds).size !== detailIds.length
        || detailIds.some((id) => kindById.get(String(id)) !== 'episode_detail')) {
        throw new Error('graph episode shard reference drift');
      }
    }
    if (coreGraph.edges.some((edge) => !episodeIds.has(String(edge.source)) || !episodeIds.has(String(edge.target)))) {
      throw new Error('graph edge endpoint drift');
    }
    return {
      ready: true,
      transportProfile: GRAPH_SHARD_TRANSPORT,
      buildRevision: core.build_revision,
      shardCount: descriptors.length,
      shardBytes: descriptors.reduce((sum, descriptor) => sum + Number(descriptor.bytes), 0),
      descriptorSetSha256: await sha256Hex(new TextEncoder().encode(stableJson(descriptors)).buffer),
    };
  } catch {
    return { ready: false, transportProfile: null, buildRevision: null, shardCount: 0, shardBytes: 0, descriptorSetSha256: null };
  }
}

function parseCoreTableCounts(value: unknown): CoreTableCounts | null {
  let parsed: unknown = value;
  try {
    if (typeof value === 'string') parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== CORE_TABLE_COUNT_KEYS.length
      || CORE_TABLE_COUNT_KEYS.some((key) => !Object.hasOwn(record, key))) return null;
  const counts = {} as CoreTableCounts;
  for (const key of CORE_TABLE_COUNT_KEYS) {
    const count = record[key];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;
    if (LEGACY_ZERO_CORE_TABLES.has(key) && count !== 0) return null;
    counts[key] = count;
  }
  return counts;
}

function coreTableCountsEqual(left: CoreTableCounts, right: CoreTableCounts): boolean {
  return CORE_TABLE_COUNT_KEYS.every((key) => left[key] === right[key]);
}

function corpusReleaseReady(corpus: CorpusReleaseStatus | null): boolean {
  if (!corpus || corpus.state !== 'ready') return false;
  const expectedCore = parseCoreTableCounts(corpus.expected_core_counts_json);
  const actualCore = parseCoreTableCounts(corpus.actual_core_counts_json);
  const liveCore = parseCoreTableCounts(corpus.live_core_counts_json);
  if (!expectedCore || !actualCore || !liveCore
      || !coreTableCountsEqual(expectedCore, actualCore)
      || !coreTableCountsEqual(expectedCore, liveCore)) return false;
  return Number(corpus.actual_documents) === Number(corpus.expected_documents)
    && Number(corpus.actual_paragraphs) === Number(corpus.expected_paragraphs)
    && Number(corpus.actual_fts_rows) === Number(corpus.expected_fts_rows)
    && Number(corpus.actual_page_gates) === Number(corpus.expected_page_gates)
    && Number(corpus.actual_displayed_paragraphs) === Number(corpus.expected_displayed_paragraphs)
    && Number(corpus.actual_chunks) === Number(corpus.expected_chunks)
    && Number(corpus.live_documents) === Number(corpus.expected_documents)
    && Number(corpus.live_paragraphs) === Number(corpus.expected_paragraphs)
    && Number(corpus.live_fts_rows) === Number(corpus.expected_fts_rows)
    && Number(corpus.live_page_gates) === Number(corpus.expected_page_gates)
    && Number(corpus.live_displayed_paragraphs) === Number(corpus.expected_displayed_paragraphs)
    && Number(corpus.live_accepted_ocr_documents) === Number(corpus.accepted_ocr_documents)
    && Number(corpus.live_chunks) === Number(corpus.expected_chunks);
}

async function currentCorpusRelease(env: Env): Promise<CorpusReleaseStatus | null> {
  try {
    return await env.DB.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM documents d WHERE d.corpus_release_id=r.release_id) AS live_documents,
      (SELECT COUNT(*) FROM paragraphs p WHERE p.corpus_release_id=r.release_id) AS live_paragraphs,
      (SELECT COUNT(*) FROM paragraph_fts) AS live_fts_rows,
      (SELECT COUNT(*) FROM page_publication_gates g WHERE g.corpus_release_id=r.release_id) AS live_page_gates,
      (SELECT COUNT(*) FROM paragraphs p WHERE p.corpus_release_id=r.release_id AND p.display_allowed=1) AS live_displayed_paragraphs,
      (SELECT COUNT(DISTINCT g.document_id) FROM page_publication_gates g
        WHERE g.corpus_release_id=r.release_id AND g.publication_basis='accepted_ocr_page_manifest') AS live_accepted_ocr_documents,
      (SELECT COUNT(*) FROM corpus_import_chunks c WHERE c.release_id=r.release_id) AS live_chunks,
      json_object(
        'subjects',(SELECT COUNT(*) FROM subjects),
        'periods',(SELECT COUNT(*) FROM periods),
        'document_relations',(SELECT COUNT(*) FROM document_relations),
        'chapters',(SELECT COUNT(*) FROM chapters),
        'document_classifications',(SELECT COUNT(*) FROM document_classifications dc JOIN documents d ON d.id=dc.document_id WHERE d.corpus_release_id=r.release_id),
        'document_sources',(SELECT COUNT(*) FROM document_sources ds JOIN documents d ON d.id=ds.document_id WHERE d.corpus_release_id=r.release_id),
        'primary_document_sources',(SELECT COUNT(*) FROM document_sources ds JOIN documents d ON d.id=ds.document_id WHERE d.corpus_release_id=r.release_id AND ds.is_primary=1),
        'subject_insights',(SELECT COUNT(*) FROM subject_insights),
        'terms',(SELECT COUNT(*) FROM terms),
        'term_relations',(SELECT COUNT(*) FROM term_relations),
        'version_diffs',(SELECT COUNT(*) FROM version_diffs),
        'online_verifications',(SELECT COUNT(*) FROM online_verifications ov WHERE ov.corpus_release_id=r.release_id),
        'online_evidence',(SELECT COUNT(*) FROM online_evidence oe JOIN online_verifications ov ON ov.id=oe.verification_id WHERE ov.corpus_release_id=r.release_id),
        'embedded_items',(SELECT COUNT(*) FROM embedded_items ei WHERE ei.corpus_release_id=r.release_id)
      ) AS live_core_counts_json
      FROM corpus_import_releases r
      JOIN site_meta release_meta ON release_meta.key='current_corpus_release_id' AND release_meta.value=r.release_id
      JOIN site_meta state_meta ON state_meta.key='corpus_import_state' AND state_meta.value=r.state
      JOIN site_meta manifest_meta ON manifest_meta.key='current_corpus_manifest_sha256' AND manifest_meta.value=r.manifest_sha256
      LIMIT 1`).first<CorpusReleaseStatus>();
  } catch {
    return null;
  }
}

async function requireCorpusReady(env: Env): Promise<void> {
  if (!corpusReleaseReady(await currentCorpusRelease(env))) {
    throw new HttpError(503, '资料库正在进行一致性更新，请稍后重试');
  }
}

async function health(env: Env): Promise<Response> {
  const metaRows = await env.DB.prepare(
    "SELECT key,value FROM site_meta WHERE key IN ('schema_version','document_classification_schema_version','page_publication_schema_version','compendium_embedded_item_schema_version')",
  ).all<{ key: string; value: string }>();
  const schemaMeta = new Map(metaRows.results.map((row) => [row.key, row.value]));
  const corpus = await currentCorpusRelease(env);
  const graphRelease = await graphReleaseHealth(env);
  let classifications: { documents: number; classified: number; academic_identity_documents: number; subject_documents: number; assessment_subject_documents: number; display_facets: number; course_documents: number; scope_documents: number; unclassified_documents: number } | null = null;
  try {
    classifications = await env.DB.prepare(`SELECT COUNT(d.id) AS documents, COUNT(dc.document_id) AS classified,
      SUM(CASE WHEN dc.taxonomy_entity_kind IN ('subject', 'assessment_subject') THEN 1 ELSE 0 END) AS academic_identity_documents,
      SUM(CASE WHEN dc.taxonomy_entity_kind = 'subject' THEN 1 ELSE 0 END) AS subject_documents,
      SUM(CASE WHEN dc.taxonomy_entity_kind = 'assessment_subject' THEN 1 ELSE 0 END) AS assessment_subject_documents,
      COUNT(DISTINCT CASE WHEN dc.taxonomy_entity_kind = 'subject' THEN dc.display_facet END) AS display_facets,
      SUM(CASE WHEN dc.taxonomy_entity_kind = 'curriculum_course' THEN 1 ELSE 0 END) AS course_documents,
      SUM(CASE WHEN dc.entity_kind = 'scope' AND dc.taxonomy_entity_kind != 'curriculum_course' THEN 1 ELSE 0 END) AS scope_documents,
      SUM(CASE WHEN dc.taxonomy_entity_kind = 'unclassified' THEN 1 ELSE 0 END) AS unclassified_documents
      FROM documents d LEFT JOIN document_classifications dc ON dc.document_id = d.id
      WHERE d.corpus_release_id = ?`).bind(corpus?.release_id || '')
      .first<{ documents: number; classified: number; academic_identity_documents: number; subject_documents: number; assessment_subject_documents: number; display_facets: number; course_documents: number; scope_documents: number; unclassified_documents: number }>();
  } catch {
    classifications = null;
  }
  const schemaReady = schemaMeta.get('schema_version') === '3'
    && schemaMeta.get('document_classification_schema_version') === '2'
    && schemaMeta.get('page_publication_schema_version') === '1'
    && schemaMeta.get('compendium_embedded_item_schema_version') === '1';
  const classificationCounts = {
    documents: Number(classifications?.documents || 0),
    classified: Number(classifications?.classified || 0),
    academicIdentities: Number(classifications?.academic_identity_documents || 0),
    subjects: Number(classifications?.subject_documents || 0),
    assessmentSubjects: Number(classifications?.assessment_subject_documents || 0),
    displayFacets: Number(classifications?.display_facets || 0),
    courses: Number(classifications?.course_documents || 0),
    scopes: Number(classifications?.scope_documents || 0),
    unclassified: Number(classifications?.unclassified_documents || 0),
  };
  const classificationReady = classifications !== null
    && classificationCounts.documents === REQUIRED_CLASSIFICATION_COUNTS.documents
    && classificationCounts.classified === REQUIRED_CLASSIFICATION_COUNTS.documents
    && classificationCounts.academicIdentities === REQUIRED_CLASSIFICATION_COUNTS.academicIdentities
    && classificationCounts.subjects === REQUIRED_CLASSIFICATION_COUNTS.subjects
    && classificationCounts.assessmentSubjects === REQUIRED_CLASSIFICATION_COUNTS.assessmentSubjects
    && classificationCounts.displayFacets === REQUIRED_CLASSIFICATION_COUNTS.displayFacets
    && classificationCounts.courses === REQUIRED_CLASSIFICATION_COUNTS.courses
    && classificationCounts.scopes === REQUIRED_CLASSIFICATION_COUNTS.scopes
    && classificationCounts.unclassified === REQUIRED_CLASSIFICATION_COUNTS.unclassified;
  const corpusReady = corpusReleaseReady(corpus);
  const expectedCoreCounts = parseCoreTableCounts(corpus?.expected_core_counts_json);
  const actualCoreCounts = parseCoreTableCounts(corpus?.actual_core_counts_json);
  const liveCoreCounts = parseCoreTableCounts(corpus?.live_core_counts_json);
  const releaseSourceReady = /^[a-f0-9]{40}$/.test(env.RELEASE_GIT_COMMIT || '');
  return json({
    ok: schemaReady && classificationReady && corpusReady && releaseSourceReady && graphRelease.ready,
    service: 'bdfz-curriculum-atlas',
    version: VERSION,
    environment: env.ENVIRONMENT,
    release: {
      gitCommit: releaseSourceReady ? env.RELEASE_GIT_COMMIT : null,
      r2Reader: 'versioned_manifest_v1',
    },
    schemaVersion: schemaMeta.get('schema_version') || null,
    classificationSchemaVersion: schemaMeta.get('document_classification_schema_version') || null,
    pagePublicationSchemaVersion: schemaMeta.get('page_publication_schema_version') || null,
    compendiumEmbeddedItemSchemaVersion: schemaMeta.get('compendium_embedded_item_schema_version') || null,
    graphRelease,
    corpus: {
      ready: corpusReady,
      releaseId: corpus?.release_id || null,
      releaseFingerprintSha256: corpus?.release_fingerprint_sha256 || null,
      state: corpus?.state || null,
      manifestSha256: corpus?.manifest_sha256 || null,
      expected: corpus ? {
        documents: Number(corpus.expected_documents),
        paragraphs: Number(corpus.expected_paragraphs),
        ftsRows: Number(corpus.expected_fts_rows),
        pageGates: Number(corpus.expected_page_gates),
        displayedParagraphs: Number(corpus.expected_displayed_paragraphs),
        acceptedOcrDocuments: Number(corpus.accepted_ocr_documents),
        chunks: Number(corpus.expected_chunks),
        coreTables: expectedCoreCounts,
      } : null,
      actual: corpus ? {
        documents: Number(corpus.actual_documents),
        paragraphs: Number(corpus.actual_paragraphs),
        ftsRows: Number(corpus.actual_fts_rows),
        pageGates: Number(corpus.actual_page_gates),
        displayedParagraphs: Number(corpus.actual_displayed_paragraphs),
        chunks: Number(corpus.actual_chunks),
        coreTables: actualCoreCounts,
      } : null,
      live: corpus ? {
        documents: Number(corpus.live_documents),
        paragraphs: Number(corpus.live_paragraphs),
        ftsRows: Number(corpus.live_fts_rows),
        pageGates: Number(corpus.live_page_gates),
        displayedParagraphs: Number(corpus.live_displayed_paragraphs),
        acceptedOcrDocuments: Number(corpus.live_accepted_ocr_documents),
        chunks: Number(corpus.live_chunks),
        coreTables: liveCoreCounts,
      } : null,
    },
    classification: {
      complete: classificationReady,
      documents: classificationCounts.documents,
      classified: classificationCounts.classified,
      academicIdentityDocuments: classificationCounts.academicIdentities,
      subjectDocuments: classificationCounts.subjects,
      assessmentSubjectDocuments: classificationCounts.assessmentSubjects,
      displayFacets: classificationCounts.displayFacets,
      courseDocuments: classificationCounts.courses,
      scopeDocuments: classificationCounts.scopes,
      unclassifiedDocuments: classificationCounts.unclassified,
    },
    bindings: {
      d1: Boolean(env.DB),
      r2: Boolean(env.SOURCES),
      apis: Boolean(env.APIS),
      userCenter: Boolean(env.USER_CENTER),
      assets: Boolean(env.ASSETS),
    },
  }, schemaReady && classificationReady && corpusReady && releaseSourceReady && graphRelease.ready ? 200 : 503);
}

async function requireExactQueryIdentity(env: Env, identity: string): Promise<void> {
  if (!identity) return;
  const match = await env.DB.prepare(`SELECT dc.canonical_subject FROM document_classifications dc
    JOIN documents d ON d.id=dc.document_id
    WHERE dc.taxonomy_entity_kind = 'subject' AND dc.canonical_subject = ?
      AND d.corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id') LIMIT 1`)
    .bind(identity).first();
  if (!match) throw new HttpError(400, '精确分类身份不存在或不可检索');
}

async function meta(env: Env): Promise<Response> {
  const [documents, embeddedItems, paragraphs, comments, citationReadyDocuments, citationReadyItems, onlineVerified, subjects, queryIdentities, assessmentIdentities, courses, periods] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM documents WHERE corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM embedded_items WHERE corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM paragraphs WHERE corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM comments WHERE status = 'approved'").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM documents WHERE citation_allowed=1 AND corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM embedded_items WHERE citation_allowed=1 AND corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM online_verifications WHERE corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id') AND verification_status IN ('verified_exact','verified_stable_fact_only')").first<{ count: number }>(),
    env.DB.prepare(`SELECT dc.display_facet AS name, COUNT(*) AS documentCount,
      MIN(d.sort_year) AS firstYear, MAX(d.sort_year) AS lastYear
      FROM documents d JOIN document_classifications dc ON dc.document_id = d.id
      WHERE dc.taxonomy_entity_kind = 'subject' AND dc.display_facet IS NOT NULL
        AND d.corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')
      GROUP BY dc.display_facet ORDER BY CASE dc.display_facet
        WHEN '语文' THEN 1 WHEN '数学' THEN 2 WHEN '外语' THEN 3 WHEN '思想政治与道德法治' THEN 4
        WHEN '历史' THEN 5 WHEN '历史与社会' THEN 6 WHEN '地理' THEN 7 WHEN '科学类' THEN 8
        WHEN '技术' THEN 9 WHEN '劳动' THEN 10 WHEN '艺术' THEN 11 WHEN '体育与健康' THEN 12 ELSE 99 END`).all(),
    env.DB.prepare(`SELECT dc.canonical_subject AS name, dc.taxonomy_entity_kind AS taxonomyEntityKind,
      dc.display_facet AS displayFacet, COUNT(*) AS documentCount,
      MIN(d.sort_year) AS firstYear, MAX(d.sort_year) AS lastYear
      FROM documents d JOIN document_classifications dc ON dc.document_id = d.id
      WHERE dc.taxonomy_entity_kind = 'subject' AND dc.canonical_subject IS NOT NULL
        AND d.corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')
      GROUP BY dc.canonical_subject, dc.taxonomy_entity_kind, dc.display_facet
      ORDER BY dc.display_facet, dc.taxonomy_entity_kind, dc.canonical_subject`).all(),
    env.DB.prepare(`SELECT dc.canonical_subject AS name, dc.taxonomy_entity_kind AS taxonomyEntityKind,
      dc.display_facet AS relatedDisplayFacet, COUNT(*) AS documentCount,
      MIN(d.sort_year) AS firstYear, MAX(d.sort_year) AS lastYear
      FROM documents d JOIN document_classifications dc ON dc.document_id = d.id
      WHERE dc.taxonomy_entity_kind = 'assessment_subject' AND dc.canonical_subject IS NOT NULL
        AND d.corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')
      GROUP BY dc.canonical_subject, dc.taxonomy_entity_kind, dc.display_facet
      ORDER BY dc.display_facet, dc.canonical_subject`).all(),
    env.DB.prepare(`SELECT dc.scope_label AS name, COUNT(*) AS documentCount,
      MIN(d.sort_year) AS firstYear, MAX(d.sort_year) AS lastYear
      FROM documents d JOIN document_classifications dc ON dc.document_id = d.id
      WHERE dc.taxonomy_entity_kind = 'curriculum_course' AND dc.scope_label IS NOT NULL
        AND d.corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')
      GROUP BY dc.scope_label ORDER BY documentCount DESC, dc.scope_label`).all(),
    env.DB.prepare('SELECT * FROM periods ORDER BY sort_order').all(),
  ]);
  return cacheJson({
    siteKey: 'curriculum',
    title: '中国历年课程标准与考试评价演变',
    version: VERSION,
    dataClass: 'teacher_owned',
    currentVersionNote: '现行标签依据已核验的教育部公开目录；处于修订过程的版本标注 revision watch。',
    counts: {
      documents: documents?.count || 0,
      embeddedItems: embeddedItems?.count || 0,
      paragraphs: paragraphs?.count || 0,
      comments: comments?.count || 0,
      citationReadyDocuments: (citationReadyDocuments?.count || 0) + (citationReadyItems?.count || 0),
      onlineVerifications: onlineVerified?.count || 0,
    },
    subjects: subjects.results,
    queryIdentities: queryIdentities.results,
    assessmentIdentities: assessmentIdentities.results,
    courses: courses.results,
    periods: periods.results,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
  }, 300);
}

async function listDocuments(url: URL, env: Env): Promise<Response> {
  const subject = textParam(url.searchParams.get('subject'), 40);
  const stage = textParam(url.searchParams.get('stage'), 40);
  const status = textParam(url.searchParams.get('status'), 40);
  const type = textParam(url.searchParams.get('type'), 40);
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 200);
  await requireExactQueryIdentity(env, subject);
  const result = await env.DB.prepare(
    `WITH identities AS (
       SELECT d.id,d.title,d.subject,d.stage,d.document_type,d.version_label,d.issued_by,d.issued_date,d.published_date,d.current_status,
              d.source_tier,d.access_status,d.source_page_url,d.source_url,d.file_format,d.redistribution,d.checksum_sha256,d.note,d.period_id,d.sort_year,
              d.text_quality_status,d.ocr_engine,d.ocr_audit_ref,d.citation_allowed,d.page_count,
              dc.entity_kind,dc.taxonomy_entity_kind,dc.canonical_subject,dc.display_facet,dc.subject_family,dc.scope_kind,dc.scope_label,dc.source_subject_label,
              COALESCE(dc.canonical_subject,dc.scope_label,dc.source_subject_label) AS entity_label,
              'document' AS identity_kind, NULL AS parent_document_id
       FROM documents d JOIN document_classifications dc ON dc.document_id = d.id
       WHERE d.corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')
         AND NOT EXISTS(
           SELECT 1 FROM embedded_items child
           WHERE child.parent_document_id=d.id AND child.corpus_release_id=d.corpus_release_id
         )
       UNION ALL
       SELECT ei.id,ei.title,d.subject,ei.stage,ei.item_kind,CAST(ei.display_year AS TEXT),ei.issuing_body,NULL,CAST(ei.display_year AS TEXT),'historical_reference',
              d.source_tier,d.access_status,d.source_page_url,d.source_url,d.file_format,d.redistribution,d.checksum_sha256,ei.uncertainty_note,d.period_id,ei.display_year,
              d.text_quality_status,d.ocr_engine,d.ocr_audit_ref,ei.citation_allowed,(ei.physical_page_end-ei.physical_page_start+1),
              dc.entity_kind,dc.taxonomy_entity_kind,dc.canonical_subject,dc.display_facet,dc.subject_family,dc.scope_kind,dc.scope_label,dc.source_subject_label,
              COALESCE(dc.canonical_subject,dc.scope_label,dc.source_subject_label),
              'embedded_item',ei.parent_document_id
       FROM embedded_items ei
       JOIN documents d ON d.id=ei.parent_document_id AND d.corpus_release_id=ei.corpus_release_id
       JOIN document_classifications dc ON dc.document_id=d.id
       WHERE ei.corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')
     )
     SELECT * FROM identities
     WHERE (? = '' OR (taxonomy_entity_kind = 'subject' AND canonical_subject = ?))
       AND (? = '' OR stage = ?) AND (? = '' OR current_status = ?) AND (? = '' OR document_type = ?)
     ORDER BY COALESCE(sort_year, 0) DESC, entity_label, title LIMIT ?`,
  ).bind(subject, subject, stage, stage, status, status, type, type, limit).all();
  return cacheJson({ documents: result.results }, 600);
}

function verificationRecords(rows: Array<Record<string, unknown>>): Array<Record<string, unknown> & { evidence: unknown[] }> {
  const verifications = new Map<string, Record<string, unknown> & { evidence: unknown[] }>();
  for (const row of rows) {
    const verificationId = String(row.id);
    if (!verifications.has(verificationId)) {
      const verification: Record<string, unknown> & { evidence: unknown[] } = { ...row, evidence: [] };
      for (const key of Object.keys(verification)) if (key.startsWith('evidence_')) delete verification[key];
      verifications.set(verificationId, verification);
    }
    if (row.evidence_id) {
      verifications.get(verificationId)?.evidence.push({
        id: row.evidence_id,
        role: row.evidence_role,
        publisher: row.evidence_publisher,
        sourceType: row.evidence_source_type,
        sourceTitle: row.evidence_source_title,
        sourceUrl: row.evidence_source_url,
        publishedAt: row.evidence_published_at,
        retrievedAt: row.evidence_retrieved_at,
        versionMatch: row.evidence_version_match,
        factSummary: row.evidence_fact_summary,
      });
    }
  }
  return [...verifications.values()];
}

async function documentDetail(id: string, url: URL, env: Env): Promise<Response> {
  const document = await env.DB.prepare(`SELECT d.*, dc.entity_kind,dc.taxonomy_entity_kind,dc.canonical_subject,dc.display_facet,dc.subject_family,
    dc.scope_kind,dc.scope_label,dc.source_subject_label,
    COALESCE(dc.canonical_subject,dc.scope_label,dc.source_subject_label) AS entity_label
    FROM documents d JOIN document_classifications dc ON dc.document_id = d.id
    WHERE d.id=? AND d.corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')`).bind(id).first();
  if (!document) throw new HttpError(404, '未找到该资料');
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100_000);
  const limit = clampInt(url.searchParams.get('limit'), 80, 1, 200);
  const [paragraphs, related, insights, verificationRows] = await Promise.all([
    env.DB.prepare(`SELECT p.id,p.ordinal,p.page_number,p.heading,p.body,p.source_locator,p.body_sha256,p.text_quality_status,p.ocr_quality_score,p.citation_allowed,
      p.display_allowed,p.source_artifact_sha256,p.source_page_sha256,p.page_final_text_sha256,p.evidence_bundle_sha256,p.provenance_locator,
      p.online_verification_status,p.evidence_triad_status,p.uncertainty_note,p.embedded_item_id,
      ei.title AS embedded_item_title,ei.display_year AS embedded_item_year,ei.issuing_body AS embedded_item_issuing_body
      FROM paragraphs p LEFT JOIN embedded_items ei ON ei.id=p.embedded_item_id
      WHERE p.document_id = ? AND p.display_allowed = 1 ORDER BY p.ordinal LIMIT ? OFFSET ?`).bind(id, limit, offset).all(),
    env.DB.prepare(`SELECT dr.relation_type, dr.note, d.id, d.title, d.subject, d.version_label,
      dc.entity_kind,dc.taxonomy_entity_kind,dc.canonical_subject,dc.display_facet,dc.scope_kind,dc.scope_label,
      COALESCE(dc.canonical_subject,dc.scope_label,dc.source_subject_label) AS entity_label
      FROM document_relations dr JOIN documents d ON d.id = dr.target_document_id
      JOIN document_classifications dc ON dc.document_id = d.id WHERE dr.source_document_id = ?
        AND d.corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')`).bind(id).all(),
    env.DB.prepare(`SELECT * FROM subject_insights WHERE evidence_document_ids LIKE ? ORDER BY sort_order`).bind(`%"${id}"%`).all(),
    env.DB.prepare(`SELECT v.*, e.id AS evidence_id, e.role AS evidence_role, e.publisher AS evidence_publisher,
        e.source_type AS evidence_source_type, e.source_title AS evidence_source_title, e.source_url AS evidence_source_url,
        e.published_at AS evidence_published_at, e.retrieved_at AS evidence_retrieved_at,
        e.version_match AS evidence_version_match, e.fact_summary AS evidence_fact_summary
      FROM online_verifications v LEFT JOIN online_evidence e ON e.verification_id = v.id
      WHERE v.document_id = ? AND v.corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')
      ORDER BY v.physical_page, v.id, e.id`).bind(id).all(),
  ]);
  return json({
    document,
    paragraphs: paragraphs.results,
    related: related.results,
    insights: insights.results,
    verifications: verificationRecords(verificationRows.results as Array<Record<string, unknown>>),
    offset,
    limit,
  }, 200, { 'cache-control': 'private, no-store' });
}

async function embeddedItemDetail(id: string, url: URL, env: Env): Promise<Response> {
  const item = await env.DB.prepare(`SELECT ei.*,
      d.title AS parent_title,d.source_url,d.source_page_url,d.source_tier,d.access_status,d.file_format,d.redistribution,d.checksum_sha256,
      ei.item_kind AS document_type,CAST(ei.display_year AS TEXT) AS version_label,
      ei.issuing_body AS issued_by,'historical_reference' AS current_status,
      d.text_quality_status,d.ocr_engine,d.ocr_audit_ref,
      (ei.physical_page_end-ei.physical_page_start+1) AS page_count,
      dc.entity_kind,dc.taxonomy_entity_kind,dc.canonical_subject,dc.display_facet,dc.subject_family,dc.scope_kind,dc.scope_label,
      COALESCE(dc.canonical_subject,dc.scope_label,dc.source_subject_label) AS entity_label
    FROM embedded_items ei
    JOIN documents d ON d.id=ei.parent_document_id AND d.corpus_release_id=ei.corpus_release_id
    JOIN document_classifications dc ON dc.document_id=d.id
    WHERE ei.id=? AND ei.corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')`).bind(id).first();
  if (!item) throw new HttpError(404, '未找到该彙編內篇目');
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100_000);
  const limit = clampInt(url.searchParams.get('limit'), 80, 1, 200);
  const [paragraphs, verificationRows] = await Promise.all([
    env.DB.prepare(`SELECT id,ordinal,page_number,heading,body,source_locator,body_sha256,
        text_quality_status,ocr_quality_score,citation_allowed,display_allowed,source_artifact_sha256,source_page_sha256,
        page_final_text_sha256,evidence_bundle_sha256,provenance_locator,online_verification_status,evidence_triad_status,
        uncertainty_note,embedded_item_id
      FROM paragraphs
      WHERE embedded_item_id=? AND display_allowed=1
      ORDER BY ordinal LIMIT ? OFFSET ?`).bind(id, limit, offset).all(),
    env.DB.prepare(`SELECT v.*, e.id AS evidence_id, e.role AS evidence_role, e.publisher AS evidence_publisher,
        e.source_type AS evidence_source_type, e.source_title AS evidence_source_title, e.source_url AS evidence_source_url,
        e.published_at AS evidence_published_at, e.retrieved_at AS evidence_retrieved_at,
        e.version_match AS evidence_version_match, e.fact_summary AS evidence_fact_summary
      FROM online_verifications v LEFT JOIN online_evidence e ON e.verification_id=v.id
      WHERE v.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        AND v.document_id=?
        AND v.corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')
      ORDER BY v.physical_page,v.id,e.id`).bind(
      String((item as { online_source_ids_json: string }).online_source_ids_json),
      String((item as { parent_document_id: string }).parent_document_id),
    ).all(),
  ]);
  return json({
    item,
    paragraphs: paragraphs.results,
    verifications: verificationRecords(verificationRows.results as Array<Record<string, unknown>>),
    discussionDocumentId: String((item as { parent_document_id: string }).parent_document_id),
    offset,
    limit,
  }, 200, { 'cache-control': 'private, no-store' });
}

async function search(url: URL, env: Env): Promise<Response> {
  const query = textParam(url.searchParams.get('q'), 240);
  if (query.length < 2) throw new HttpError(400, '请输入至少两个字符');
  const subject = textParam(url.searchParams.get('subject'), 40);
  await requireExactQueryIdentity(env, subject);
  const passages = await retrieve(env, {
    query,
    subject,
    stage: textParam(url.searchParams.get('stage'), 40),
    limit: clampInt(url.searchParams.get('limit'), 12, 1, 20),
  });
  return json({ query, passages });
}

async function insights(url: URL, env: Env): Promise<Response> {
  const subject = textParam(url.searchParams.get('subject'), 40);
  await requireExactQueryIdentity(env, subject);
  const result = await env.DB.prepare(`SELECT * FROM subject_insights WHERE (? = '' OR subject IN (?, '综合')) ORDER BY sort_order`)
    .bind(subject, subject).all();
  return cacheJson({ insights: result.results }, 600);
}

async function terminology(env: Env): Promise<Response> {
  const [terms, relations] = await Promise.all([
    env.DB.prepare('SELECT * FROM terms ORDER BY COALESCE(first_seen_year, 9999), label').all(),
    env.DB.prepare(`SELECT tr.*, s.label AS source_label, t.label AS target_label
      FROM term_relations tr JOIN terms s ON s.id = tr.source_term_id JOIN terms t ON t.id = tr.target_term_id
      ORDER BY tr.weight DESC`).all(),
  ]);
  return cacheJson({ terms: terms.results, relations: relations.results }, 900);
}

async function compare(url: URL, env: Env): Promise<Response> {
  const subject = textParam(url.searchParams.get('subject'), 40);
  if (!subject) throw new HttpError(400, '请选择学科');
  await requireExactQueryIdentity(env, subject);
  const [documents, insights] = await Promise.all([
    env.DB.prepare(`WITH identities AS (
      SELECT d.id,d.title,d.version_label,d.stage,d.sort_year,d.current_status,d.source_url,
        dc.entity_kind,dc.taxonomy_entity_kind,dc.canonical_subject,dc.display_facet,dc.subject_family,
        'document' AS identity_kind,NULL AS parent_document_id,NULL AS issuing_body
      FROM documents d JOIN document_classifications dc ON dc.document_id = d.id
      WHERE d.corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')
        AND NOT EXISTS(
          SELECT 1 FROM embedded_items child
          WHERE child.parent_document_id=d.id AND child.corpus_release_id=d.corpus_release_id
        )
      UNION ALL
      SELECT ei.id,ei.title,CAST(ei.display_year AS TEXT),ei.stage,ei.display_year,'historical_reference',d.source_url,
        dc.entity_kind,dc.taxonomy_entity_kind,dc.canonical_subject,dc.display_facet,dc.subject_family,
        'embedded_item',ei.parent_document_id,ei.issuing_body
      FROM embedded_items ei
      JOIN documents d ON d.id=ei.parent_document_id AND d.corpus_release_id=ei.corpus_release_id
      JOIN document_classifications dc ON dc.document_id=d.id
      WHERE ei.corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')
    )
    SELECT * FROM identities
    WHERE taxonomy_entity_kind='subject' AND canonical_subject=?
    ORDER BY sort_year`).bind(subject).all(),
    env.DB.prepare(`SELECT * FROM subject_insights WHERE subject IN (?, '综合') ORDER BY sort_order`).bind(subject).all(),
  ]);
  return cacheJson({ subject, documents: documents.results, insights: insights.results }, 600);
}

async function me(request: Request, env: Env): Promise<Response> {
  return json(await getSession(request, env));
}

async function listComments(url: URL, env: Env, session: Session): Promise<Response> {
  const documentId = textParam(url.searchParams.get('documentId'), 80);
  const paragraphId = clampInt(url.searchParams.get('paragraphId'), 0, 0, 1_000_000_000);
  const includePending = session.admin && url.searchParams.get('moderation') === '1';
  const result = await env.DB.prepare(
    `SELECT id,parent_id,document_id,paragraph_id,author_name,author_kind,body,status,created_at,updated_at
     FROM comments
     WHERE (? = '' OR document_id = ?)
       AND (? = 0 OR paragraph_id = ?)
       AND (${includePending ? "status IN ('pending','approved')" : "status = 'approved'"})
     ORDER BY created_at DESC LIMIT 100`,
  ).bind(documentId, documentId, paragraphId, paragraphId).all();
  return json({ comments: result.results });
}

async function createComment(request: Request, env: Env, session: Session): Promise<Response> {
  requireSameOrigin(request, env);
  const input = await readJson<CommentInput>(request);
  const documentId = textParam(input.documentId || '', 80);
  const body = textParam(input.body || '', 2_000);
  const parentId = textParam(typeof input.parentId === 'string' ? input.parentId : '', 80);
  const paragraphId = optionalParagraphId(input.paragraphId);
  if (!documentId) throw new HttpError(400, '缺少资料编号');
  if (body.length < 8) throw new HttpError(400, '讨论内容至少 8 个字符');
  const document = await env.DB.prepare(`SELECT id FROM documents WHERE id=?
    AND corpus_release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')`).bind(documentId).first();
  if (!document) throw new HttpError(404, '讨论所引用的资料不存在');
  if (parentId) {
    const parent = await env.DB.prepare('SELECT id,document_id FROM comments WHERE id = ?').bind(parentId)
      .first<{ id: string; document_id: string | null }>();
    if (!parent) throw new HttpError(404, '回复所引用的上级讨论不存在');
    if (parent.document_id !== documentId) throw new HttpError(400, '上级讨论不属于当前资料');
  }
  if (paragraphId !== null) {
    const paragraph = await env.DB.prepare('SELECT id,document_id,display_allowed FROM paragraphs WHERE id = ?').bind(paragraphId)
      .first<{ id: number; document_id: string; display_allowed: number }>();
    if (!paragraph) throw new HttpError(404, '讨论所引用的段落不存在');
    if (paragraph.document_id !== documentId) throw new HttpError(400, '段落不属于当前资料');
    if (Number(paragraph.display_allowed) !== 1) throw new HttpError(409, '该段落尚未开放讨论');
  }
  let authorSlug: string | null = null;
  let authorName: string;
  let authorKind: 'authenticated' | 'anonymous';
  let status: 'approved' | 'pending';
  if (session.authenticated && session.user) {
    authorSlug = session.user.slug;
    authorName = session.user.display_name || session.user.name || session.user.slug;
    authorKind = 'authenticated';
    status = 'approved';
    await enforceRateLimit(env, 'comment-auth', authorSlug, 12, 600);
  } else {
    authorName = textParam(input.authorName || '匿名教师', 40) || '匿名教师';
    authorKind = 'anonymous';
    status = 'pending';
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    await enforceRateLimit(env, 'comment-anon', ip, 3, 3600);
    await verifyTurnstile(request, env, textParam(input.turnstileToken || '', 2048));
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO comments(id,parent_id,document_id,paragraph_id,author_slug,author_name,author_kind,body,status)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).bind(id, parentId || null, documentId, paragraphId, authorSlug, authorName, authorKind, body, status).run();
  console.log(JSON.stringify({ event: 'comment_created', id, authorKind, status, documentId }));
  return json({ ok: true, id, status, message: status === 'pending' ? '已提交，审核后公开' : '讨论已发布' }, 201);
}

async function reportComment(request: Request, env: Env, session: Session, id: string): Promise<Response> {
  requireSameOrigin(request, env);
  const input = await readJson<{ reason?: string }>(request);
  const reason = textParam(input.reason || '', 240);
  if (reason.length < 4) throw new HttpError(400, '请说明举报原因');
  const actor = session.user?.slug || request.headers.get('cf-connecting-ip') || 'unknown';
  await enforceRateLimit(env, 'comment-report', actor, 5, 3600);
  const exists = await env.DB.prepare("SELECT id FROM comments WHERE id = ? AND status = 'approved'").bind(id).first();
  if (!exists) throw new HttpError(404, '讨论不存在');
  await env.DB.prepare('INSERT INTO comment_reports(id,comment_id,reporter_slug,reason) VALUES(?,?,?,?)')
    .bind(crypto.randomUUID(), id, session.user?.slug || null, reason).run();
  return json({ ok: true });
}

async function moderateComment(request: Request, env: Env, session: Session, id: string): Promise<Response> {
  requireSameOrigin(request, env);
  const admin = requireAdmin(session);
  const input = await readJson<{ status?: string; note?: string }>(request);
  if (!['approved', 'rejected', 'deleted'].includes(input.status || '')) throw new HttpError(400, '审核状态无效');
  const before = await env.DB.prepare('SELECT status,moderation_note FROM comments WHERE id = ?').bind(id).first();
  if (!before) throw new HttpError(404, '讨论不存在');
  await env.DB.batch([
    env.DB.prepare('UPDATE comments SET status = ?, moderation_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(input.status, textParam(input.note || '', 240) || null, id),
    env.DB.prepare(`INSERT INTO content_audit_log(id,actor_slug,action,entity_type,entity_id,before_json,after_json)
      VALUES(?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), admin.slug, 'moderate', 'comment', id, JSON.stringify(before), JSON.stringify(input)),
  ]);
  return json({ ok: true });
}

async function adminSummary(env: Env, session: Session): Promise<Response> {
  requireAdmin(session);
  const [pending, reports, aiFailures, audits] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM comments WHERE status = 'pending'").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM comment_reports WHERE status = 'open'").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM ai_citation_logs WHERE status != 'ok' AND created_at >= datetime('now','-7 days')").first(),
    env.DB.prepare('SELECT * FROM content_audit_log ORDER BY created_at DESC LIMIT 50').all(),
  ]);
  return json({ pending, reports, aiFailures, audits: audits.results });
}

async function aiChat(request: Request, env: Env, session: Session): Promise<Response> {
  requireSameOrigin(request, env);
  const user = requireAuthenticated(session);
  await enforceRateLimit(env, 'ai-chat', user.slug, 12, 600);
  const input = await readJson<AiInput>(request, 12_000);
  const query = textParam(input.query || '', 1_200);
  const subject = textParam(input.subject || '', 40);
  if (query.length < 8) throw new HttpError(400, '问题至少需要 8 个字符');
  await requireExactQueryIdentity(env, subject);
  return json(await answerWithEvidence(env, session, query, subject));
}

function sourceManifestFailure(): never {
  throw new HttpError(503, '来源校验清单发布状态异常');
}

function parseReleaseJson(bytes: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return sourceManifestFailure();
  }
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function parseReleasePointer(bytes: ArrayBuffer): R2ReleasePointer {
  const value = parseReleaseJson(bytes) as Partial<R2ReleasePointer> | null;
  if (!value || typeof value !== 'object'
    || value.schema_version !== 1
    || typeof value.release_id !== 'string'
    || !R2_RELEASE_ID_PATTERN.test(value.release_id)
    || typeof value.release_manifest_key !== 'string'
    || value.release_manifest_key !== `${R2_RELEASE_PREFIX}/${value.release_id}/manifest.json`
    || typeof value.release_manifest_sha256 !== 'string'
    || !SHA256_PATTERN.test(value.release_manifest_sha256)
    || !positiveSafeInteger(value.release_manifest_bytes)
    || !positiveSafeInteger(value.managed_object_count)) {
    return sourceManifestFailure();
  }
  return value as R2ReleasePointer;
}

async function r2Bytes(object: R2ObjectBody, expectedBytes: number | null, maximumBytes: number): Promise<ArrayBuffer> {
  if (object.size > maximumBytes || (expectedBytes !== null && object.size !== expectedBytes)) {
    return sourceManifestFailure();
  }
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength > maximumBytes || bytes.byteLength !== object.size
    || (expectedBytes !== null && bytes.byteLength !== expectedBytes)) {
    return sourceManifestFailure();
  }
  return bytes;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function requireSha256(bytes: ArrayBuffer, expected: string): Promise<void> {
  if (!SHA256_PATTERN.test(expected) || await sha256Hex(bytes) !== expected) sourceManifestFailure();
}

function sourceManifestResponse(
  object: R2ObjectBody,
  bytes: ArrayBuffer,
  graphRelease: GraphReleaseHealth,
  contentType?: string,
): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  if (!headers.has('content-type') && contentType) headers.set('content-type', contentType);
  headers.set('x-curriculum-graph-build-revision', graphRelease.buildRevision || '');
  headers.set('x-curriculum-graph-shard-count', String(graphRelease.shardCount));
  headers.set('x-curriculum-graph-descriptor-sha256', graphRelease.descriptorSetSha256 || '');
  headers.set('cache-control', 'public, max-age=3600');
  return new Response(bytes, { headers });
}

async function sourceManifest(env: Env): Promise<Response> {
  const graphRelease = await graphReleaseHealth(env);
  if (!graphRelease.ready) return sourceManifestFailure();
  const pointerObject = await env.SOURCES.get(R2_CURRENT_POINTER_KEY);
  if (!pointerObject) {
    const legacyObject = await env.SOURCES.get(R2_INGEST_MANIFEST_KEY);
    if (!legacyObject) throw new HttpError(404, '来源校验清单尚未发布');
    const legacyBytes = await r2Bytes(legacyObject, null, MAX_INGEST_MANIFEST_BYTES);
    return sourceManifestResponse(legacyObject, legacyBytes, graphRelease, 'application/json');
  }

  const pointerBytes = await r2Bytes(pointerObject, null, MAX_RELEASE_MANIFEST_BYTES);
  const pointer = parseReleasePointer(pointerBytes);
  const releaseManifestObject = await env.SOURCES.get(pointer.release_manifest_key);
  if (!releaseManifestObject) return sourceManifestFailure();
  const releaseManifestBytes = await r2Bytes(
    releaseManifestObject,
    pointer.release_manifest_bytes,
    MAX_RELEASE_MANIFEST_BYTES,
  );
  await requireSha256(releaseManifestBytes, pointer.release_manifest_sha256);
  const releaseManifest = parseReleaseJson(releaseManifestBytes) as {
    schema_version?: unknown;
    release_id?: unknown;
    r2?: { release_prefix?: unknown; release_manifest_key?: unknown; objects?: unknown };
  };
  if (releaseManifest.schema_version !== 1
    || releaseManifest.release_id !== pointer.release_id
    || releaseManifest.r2?.release_prefix !== R2_RELEASE_PREFIX
    || releaseManifest.r2?.release_manifest_key !== pointer.release_manifest_key
    || !Array.isArray(releaseManifest.r2?.objects)
    || releaseManifest.r2.objects.length !== pointer.managed_object_count) {
    return sourceManifestFailure();
  }
  const matches = releaseManifest.r2.objects.filter((candidate): candidate is R2ReleaseAsset => {
    if (!candidate || typeof candidate !== 'object') return false;
    return (candidate as Partial<R2ReleaseAsset>).key === R2_INGEST_MANIFEST_KEY;
  });
  if (matches.length !== 1) return sourceManifestFailure();
  const asset = matches[0];
  const expectedReleaseKey = `${R2_RELEASE_PREFIX}/${pointer.release_id}/${R2_INGEST_MANIFEST_KEY}`;
  if (asset.release_key !== expectedReleaseKey
    || !SHA256_PATTERN.test(asset.sha256)
    || !positiveSafeInteger(asset.bytes)
    || (asset.content_type !== undefined && typeof asset.content_type !== 'string')) {
    return sourceManifestFailure();
  }
  const object = await env.SOURCES.get(asset.release_key);
  if (!object) return sourceManifestFailure();
  const bytes = await r2Bytes(object, asset.bytes, MAX_INGEST_MANIFEST_BYTES);
  await requireSha256(bytes, asset.sha256);
  return sourceManifestResponse(object, bytes, graphRelease, asset.content_type || 'application/json');
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = request.method;
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow: 'GET, POST, PATCH, OPTIONS' } });
  if (pathname === '/api/health' && method === 'GET') return health(env);
  if (pathname === '/api/me' && method === 'GET') return me(request, env);
  await requireCorpusReady(env);
  if (pathname === '/api/meta' && method === 'GET') return meta(env);
  if (pathname === '/api/documents' && method === 'GET') return listDocuments(url, env);
  const detailMatch = pathname.match(/^\/api\/documents\/([a-z0-9-]+)$/);
  if (detailMatch && method === 'GET') return documentDetail(detailMatch[1], url, env);
  if (pathname.startsWith('/api/items/') && method === 'GET') {
    let itemId = '';
    try {
      itemId = textParam(decodeURIComponent(pathname.slice('/api/items/'.length)), 160);
    } catch {
      throw new HttpError(400, '篇目编号无效');
    }
    if (!itemId || /[/\\\0]/.test(itemId)) throw new HttpError(400, '篇目编号无效');
    return embeddedItemDetail(itemId, url, env);
  }
  if (pathname === '/api/search' && method === 'GET') return search(url, env);
  if (pathname === '/api/insights' && method === 'GET') return insights(url, env);
  if (pathname === '/api/terms' && method === 'GET') return terminology(env);
  if (pathname === '/api/compare' && method === 'GET') return compare(url, env);
  if (pathname === '/api/source-manifest' && method === 'GET') return sourceManifest(env);
  const needsSession = pathname.startsWith('/api/comments') || pathname.startsWith('/api/ai') || pathname.startsWith('/api/admin');
  const session = needsSession ? await getSession(request, env) : { authenticated: false, user: null, admin: false };
  if (pathname === '/api/comments' && method === 'GET') return listComments(url, env, session);
  if (pathname === '/api/comments' && method === 'POST') return createComment(request, env, session);
  const reportMatch = pathname.match(/^\/api\/comments\/([a-f0-9-]+)\/report$/);
  if (reportMatch && method === 'POST') return reportComment(request, env, session, reportMatch[1]);
  const moderateMatch = pathname.match(/^\/api\/admin\/comments\/([a-f0-9-]+)$/);
  if (moderateMatch && method === 'PATCH') return moderateComment(request, env, session, moderateMatch[1]);
  if (pathname === '/api/admin/summary' && method === 'GET') return adminSummary(env, session);
  if (pathname === '/api/ai/chat' && method === 'POST') return aiChat(request, env, session);
  throw new HttpError(404, 'API 路径不存在');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    try {
      const response = url.pathname.startsWith('/api/')
        ? await api(request, env, url)
        : await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set('x-request-id', requestId);
      return secureHeaders(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
    } catch (error) {
      if (error instanceof HttpError) return secureHeaders(json({ error: error.message, requestId }, error.status));
      console.error(JSON.stringify({ event: 'request_error', requestId, path: url.pathname, error: String(error) }));
      return secureHeaders(json({ error: '服务暂时不可用', requestId }, 500));
    }
  },
} satisfies ExportedHandler<Env>;
