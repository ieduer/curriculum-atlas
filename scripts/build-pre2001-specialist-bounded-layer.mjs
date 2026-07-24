#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_PATH = path.join(ROOT, 'data/pre2001-specialist-bounded-source.json');
const FAMILY_PATH = path.join(ROOT, 'data/concept-evolution-families.json');
const COMPENDIA_PATH = path.join(ROOT, 'data/local-compendia.json');
const ITEMS_PATH = path.join(ROOT, 'data/pre2001-specialist-bounded-items.json');
const IDENTITY_RECEIPT_PATH = path.join(ROOT, 'data/pre2001-bounded-identity-verification.json');
const OUTPUT_PATH = path.join(ROOT, 'public/data/pre2001-subject-detail-observation-layer.json');
const PROFILE_ROOTS = {
  frozen_readback_20260718_b3_final: path.join(
    ROOT,
    '.cache/remote-ocr-offload/20260718-b3-final/readback/production-p1-mb16-shard-b-r3/documents',
  ),
  local_production_snapshot: path.join(ROOT, '.cache/ocr-production'),
  targeted_tesseract_20260723: path.join(ROOT, '.cache/pre2001-targeted-ocr'),
  candidate_hybrid_20260723: path.join(ROOT, '.cache/pre2001-candidate-hybrid-v15'),
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  if (argv.length === 0) return { check: false };
  if (argv.length === 1 && argv[0] === '--check') return { check: true };
  throw new Error(`unknown arguments: ${argv.join(' ')}`);
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, '');
}

function normalizeTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([）》」】])/g, '$1')
    .replace(/([《（“【])\s+/g, '$1')
    .trim();
}

function snippetFor(content, surface) {
  const compact = String(content).replace(/\s+/g, ' ').trim();
  const normalizedSurface = normalizeText(surface);
  const normalized = normalizeText(content);
  const normalizedOffset = normalized.indexOf(normalizedSurface);
  if (normalizedOffset < 0) return compact.slice(0, 180);
  let rawOffset = 0;
  let seen = 0;
  while (rawOffset < content.length && seen < normalizedOffset) {
    if (!/\s/.test(content[rawOffset])) seen += 1;
    rawOffset += 1;
  }
  return content.slice(Math.max(0, rawOffset - 68), Math.min(content.length, rawOffset + surface.length + 118))
    .replace(/\s+/g, ' ')
    .trim();
}

function exactCount(content, surface) {
  const text = normalizeText(content);
  const needle = normalizeText(surface);
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function deriveStage(title) {
  const primary = /(蒙学堂|小学堂|小学校|小学|国民学校)/.test(title);
  const secondary = /(中学堂|中学校|中等学校|中学|高中|初中)/.test(title);
  if (primary && secondary) return '小学—中学';
  if (primary) return '小学';
  if (secondary) return '中学';
  return '跨学段';
}

function deriveDocumentType(title) {
  for (const [needle, type] of [
    ['教学大纲', '教学大纲'],
    ['课程标准', '课程标准'],
    ['课程纲要', '课程纲要'],
    ['课程计划', '课程计划'],
    ['教学计划', '教学计划'],
    ['课程表', '课程表'],
    ['章程', '学制章程'],
    ['规则', '学校规则'],
    ['通知', '通知'],
  ]) {
    if (title.includes(needle)) return type;
  }
  return '历史课程文件';
}

function itemId(documentId, year, physicalPageStart, title, facets) {
  return `pre2001-item:${documentId}:${sha256(
    `${year}|${physicalPageStart}|${title}|${facets.join('|')}`,
  ).slice(0, 18)}`;
}

function subjectEntity(facet) {
  return {
    canonical: facet,
    entity_kind: 'subject',
    classification: 'historical_specialist_bounded_candidate',
    facet_eligible: true,
    source_label: facet,
    facet,
    family: facet,
    course_family: null,
    related_subjects: [],
    stable_subject_id: `subject-pre2001:${sha256(facet).slice(0, 16)}`,
    stable_course_id: null,
    official_code: null,
    authority: 'source_hash_bound_bounded_ocr_candidate',
    course_variant: null,
    lineage_family: facet,
  };
}

async function loadState(document, profile) {
  const profileRoot = PROFILE_ROOTS[profile];
  requireValue(profileRoot, `unknown OCR profile: ${profile}`);
  const documentRoot = path.join(profileRoot, document.id);
  const stateBytes = await readFile(path.join(documentRoot, 'state.json'));
  const state = JSON.parse(stateBytes);
  requireValue(state.document_id === document.id, `OCR state id mismatch: ${document.id}`);
  requireValue(state.source_sha256 === document.checksum_sha256, `OCR source hash mismatch: ${document.id}`);
  requireValue(Number(state.page_count) === Number(document.page_count), `OCR page count mismatch: ${document.id}`);
  const completed = new Set((state.completed_pages || []).map(Number));
  const failed = new Set(Object.keys(state.failed_pages || {}).map(Number));
  const pageCache = new Map();
  async function page(number) {
    if (pageCache.has(number)) return pageCache.get(number);
    requireValue(completed.has(number) && !failed.has(number),
      `requested OCR page is not complete: ${document.id} p.${number}`);
    const pageState = state.pages?.[String(number)];
    let bytes;
    let expected;
    if (state.profile === 'candidate_hybrid_20260723'
      && pageState?.origin === 'candidate_ocr_single_witness_v1') {
      const sidecarPath = path.join(
        ROOT,
        state.roots.candidate_ocr_single_witness_v1,
        `page-${String(number).padStart(4, '0')}.json`,
      );
      const sidecarBytes = await readFile(sidecarPath);
      requireValue(sha256(sidecarBytes) === pageState.sidecar_sha256,
        `candidate OCR sidecar hash mismatch: ${document.id} p.${number}`);
      const sidecar = JSON.parse(sidecarBytes);
      requireValue(sidecar.document_id === document.id
        && Number(sidecar.physical_pdf_page) === number
        && sidecar.source_pdf_sha256 === document.checksum_sha256
        && sidecar.citation_allowed === false,
      `candidate OCR sidecar identity mismatch: ${document.id} p.${number}`);
      bytes = Buffer.from(`${sidecar.lines.map((line) => line.text).join('\n')}\n`);
      expected = sha256(bytes);
    } else {
      const contentRoot = state.profile === 'candidate_hybrid_20260723'
        ? path.join(ROOT, state.roots.local_production_snapshot)
        : documentRoot;
      const contentPath = path.join(contentRoot, 'pages', String(number).padStart(4, '0'), 'content.md');
      bytes = await readFile(contentPath);
      expected = state.profile === 'candidate_hybrid_20260723'
        ? pageState?.content_sha256
        : pageState?.content_markdown_sha256;
    }
    requireValue(!expected || sha256(bytes) === expected, `OCR content hash mismatch: ${document.id} p.${number}`);
    const result = {
      page: number,
      content: bytes.toString('utf8'),
      content_sha256: sha256(bytes),
    };
    pageCache.set(number, result);
    return result;
  }
  return {
    document,
    profile,
    documentRoot,
    state,
    state_sha256: sha256(stateBytes),
    completed,
    failed,
    page,
  };
}

function rangeComplete(source, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return false;
  for (let page = start; page <= end; page += 1) {
    if (!source.completed.has(page) || source.failed.has(page)) return false;
  }
  return true;
}

async function closeItem(source, raw) {
  const pages = [];
  for (let page = raw.physical_page_start; page <= raw.physical_page_end; page += 1) {
    pages.push(await source.page(page));
  }
  const rangeHash = sha256(pages.map((page) => `${page.page}:${page.content_sha256}`).join('\n'));
  return {
    id: itemId(source.document.id, raw.year, raw.physical_page_start, raw.title, raw.visibility_facets),
    parent_document_id: source.document.id,
    parent_title: source.document.title,
    title: raw.title,
    year: raw.year,
    stage: raw.stage || deriveStage(raw.title),
    document_type: raw.document_type || deriveDocumentType(raw.title),
    visibility_facets: raw.visibility_facets,
    physical_page_start: raw.physical_page_start,
    physical_page_end: raw.physical_page_end,
    printed_page_start: raw.printed_page_start ?? null,
    printed_page_end: raw.printed_page_end ?? null,
    boundary_basis: raw.boundary_basis,
    source_item_id: raw.source_item_id || null,
    source_sha256: source.document.checksum_sha256,
    range_content_sha256: rangeHash,
    ocr_profile: source.profile,
    ocr_status: 'ocr_complete_pending_item_audit',
    citation_allowed: false,
    semantic_claim_allowed: false,
    public_locator: `/archive?q=${encodeURIComponent(raw.title)}`,
    pages,
  };
}

async function embeddedItems(config, source, manifest) {
  const allowed = config.item_ids ? new Set(config.item_ids) : null;
  const items = manifest.items.filter((item) =>
    item.parent_document_id === config.document_id
    && (!allowed || allowed.has(item.id)));
  const output = [];
  for (const item of items) {
    const start = Math.min(...item.segments.map((segment) => segment.physical_page_start));
    const end = Math.max(...item.segments.map((segment) => segment.physical_page_end));
    if (!rangeComplete(source, start, end)) continue;
    output.push(await closeItem(source, {
      title: item.title,
      year: Number(item.year),
      stage: item.stage,
      document_type: item.document_type,
      visibility_facets: config.visibility_facets,
      physical_page_start: start,
      physical_page_end: end,
      printed_page_start: Math.min(...item.segments.map((segment) => segment.printed_page_start)),
      printed_page_end: Math.max(...item.segments.map((segment) => segment.printed_page_end)),
      boundary_basis: 'existing_toc_bound_embedded_item_manifest',
      source_item_id: item.id,
    }));
  }
  return output;
}

async function tocItems(config, source) {
  const entries = [];
  let stage = '跨学段';
  for (const pageNumber of config.toc_pages) {
    const content = (await source.page(pageNumber)).content;
    for (const rawLine of content.split(/\r?\n/)) {
      const line = normalizeTitle(rawLine.replace(/<[^>]+>/g, ' '));
      if (/小学部分/.test(line)) stage = '小学';
      if (/中学部分/.test(line)) stage = '中学';
      const match = line.match(/^((?:19|20)\d{2})\s*年?\s+(.+?)(?:\s*[.．…·]{2,}\s*|\s+)(\d+)\s*$/);
      if (!match) continue;
      const year = Number(match[1]);
      if (year > 2000) continue;
      const title = normalizeTitle(match[2]);
      const printed = Number(match[3]);
      entries.push({
        year,
        title,
        stage: stage === '跨学段' ? deriveStage(title) : stage,
        printed_page_start: printed,
        physical_page_start: printed + Number(config.printed_to_physical_offset),
      });
    }
  }
  entries.sort((left, right) =>
    left.physical_page_start - right.physical_page_start
    || left.year - right.year
    || left.title.localeCompare(right.title, 'zh-CN'));
  const deduped = entries.filter((entry, index) =>
    index === 0
    || entry.physical_page_start !== entries[index - 1].physical_page_start
    || entry.title !== entries[index - 1].title);
  const output = [];
  for (let index = 0; index < deduped.length; index += 1) {
    const entry = deduped[index];
    const next = deduped[index + 1];
    const end = Math.min(
      source.document.page_count,
      next ? next.physical_page_start - 1 : source.document.page_count,
    );
    if (!rangeComplete(source, entry.physical_page_start, end)) continue;
    output.push(await closeItem(source, {
      ...entry,
      visibility_facets: config.visibility_facets,
      physical_page_end: end,
      printed_page_end: end - Number(config.printed_to_physical_offset),
      boundary_basis: 'compendium_toc_adjacent_printed_page_range',
    }));
  }
  return output;
}

async function headingItems(config, source) {
  const output = [];
  for (let index = 0; index < config.starts.length; index += 1) {
    const start = config.starts[index];
    const next = config.starts[index + 1];
    if (start.include === false || !next) continue;
    const physicalStart = Number(start.page);
    const physicalEnd = Number(next.page) - 1;
    if (!rangeComplete(source, physicalStart, physicalEnd)) continue;
    const firstPage = await source.page(physicalStart);
    requireValue(normalizeText(firstPage.content).includes(normalizeText(start.title_contains)),
      `heading mismatch: ${source.document.id} p.${physicalStart} expected ${start.title_contains}`);
    const titleLine = firstPage.content.split(/\r?\n/)
      .map((line) => normalizeTitle(line.replace(/^#+\s*/, '')))
      .find((line) => normalizeText(line).includes(normalizeText(start.title_contains)));
    output.push(await closeItem(source, {
      title: titleLine || start.title_contains,
      year: Number(start.year),
      visibility_facets: start.visibility_facets || config.visibility_facets,
      physical_page_start: physicalStart,
      physical_page_end: physicalEnd,
      boundary_basis: config.boundary_basis,
    }));
  }
  return output;
}

async function build() {
  const embeddedManifestPath = path.join(ROOT, 'data/embedded-items-century-v1.json');
  const [configBytes, familyBytes, compendiaBytes, embeddedManifestBytes] = await Promise.all([
    readFile(SOURCE_PATH),
    readFile(FAMILY_PATH),
    readFile(COMPENDIA_PATH),
    readFile(embeddedManifestPath),
  ]);
  const config = JSON.parse(configBytes);
  const familyConfig = JSON.parse(familyBytes);
  const compendia = JSON.parse(compendiaBytes);
  const embeddedManifest = JSON.parse(embeddedManifestBytes);
  requireValue(config.schema_version === 1
    && config.artifact_profile === 'curriculum-pre2001-specialist-bounded-source-v1',
  'pre-2001 specialist source config failed structural validation');
  const documentsById = new Map(compendia.documents.map((document) => [document.id, document]));
  const stateCache = new Map();
  async function stateFor(documentId, profile) {
    const key = `${documentId}|${profile}`;
    if (!stateCache.has(key)) {
      const document = documentsById.get(documentId);
      requireValue(document, `unknown compendium document: ${documentId}`);
      stateCache.set(key, await loadState(document, profile));
    }
    return stateCache.get(key);
  }

  const items = [];
  for (const sourceConfig of config.embedded_sources) {
    const source = await stateFor(sourceConfig.document_id, sourceConfig.ocr_profile);
    items.push(...await embeddedItems(sourceConfig, source, embeddedManifest));
  }
  for (const sourceConfig of config.toc_sources) {
    const source = await stateFor(sourceConfig.document_id, sourceConfig.ocr_profile);
    items.push(...await tocItems(sourceConfig, source));
  }
  for (const sourceConfig of config.heading_sources) {
    const source = await stateFor(sourceConfig.document_id, sourceConfig.ocr_profile);
    items.push(...await headingItems(sourceConfig, source));
  }
  items.sort((left, right) =>
    left.year - right.year
    || left.visibility_facets.join('|').localeCompare(right.visibility_facets.join('|'), 'zh-CN')
    || left.parent_document_id.localeCompare(right.parent_document_id, 'en')
    || left.physical_page_start - right.physical_page_start);

  const captureIds = new Set([
    ...familyConfig.detailed_concepts
      .filter((concept) => concept.id.startsWith('detail-pre2001-'))
      .map((concept) => concept.id),
    ...(config.additional_capture_concept_ids || []),
  ]);
  const concepts = familyConfig.detailed_concepts.filter((concept) => captureIds.has(concept.id));
  const episodes = [];
  const evidence = [];
  for (const concept of concepts) {
    requireValue(concept.visibility_facets.length === 1, `pre-2001 concept must have one facet: ${concept.id}`);
    const facet = concept.visibility_facets[0];
    const surfaces = [...new Set([concept.label, ...(concept.aliases || [])])].filter(Boolean);
    for (const item of items.filter((candidate) => candidate.visibility_facets.includes(facet))) {
      const pageHits = item.pages.flatMap((page) => {
        const counts = surfaces.map((surface) => ({ surface, count: exactCount(page.content, surface) }))
          .filter((entry) => entry.count > 0)
          .sort((left, right) => right.count - left.count || left.surface.localeCompare(right.surface, 'zh-CN'));
        if (!counts.length) return [];
        return [{
          page: page.page,
          matched_surface: counts[0].surface,
          mention_count: counts.reduce((sum, entry) => sum + entry.count, 0),
          snippet: snippetFor(page.content, counts[0].surface),
          content_sha256: page.content_sha256,
        }];
      });
      if (!pageHits.length) continue;
      const selectedHits = pageHits
        .sort((left, right) => right.mention_count - left.mention_count || left.page - right.page)
        .slice(0, config.projection_policy.maximum_evidence_pages_per_observation);
      const id = `pre2001-detail:${sha256(`${item.id}|${concept.id}`).slice(0, 20)}`;
      const subject = subjectEntity(facet);
      const evidenceIds = selectedHits.map((hit) =>
        `pre2001-evidence:${sha256(`${id}|${hit.page}`).slice(0, 20)}`);
      const meaningfulCharacters = item.pages.reduce(
        (sum, page) => sum + normalizeText(page.content).length,
        0,
      );
      const mentionCount = pageHits.reduce((sum, hit) => sum + hit.mention_count, 0);
      episodes.push({
        id,
        concept_id: concept.id,
        concept_sense_id: `sense:${concept.id}:undifferentiated`,
        label: concept.label,
        aliases: concept.aliases || [],
        category: concept.category,
        ontology_node_id: null,
        subject,
        scope_entity: { ...subject },
        course_entity: null,
        visibility_facets: [facet],
        visibility_policy: 'controlled_pre2001_specialist_facet',
        curriculum_line: {
          id: `line:pre2001-detail:${facet}`,
          subject: facet,
          course: null,
          scope_entity_label: facet,
          subject_entity_kind: 'subject',
          subject_classification: 'historical_specialist_bounded_candidate',
          stage: item.stage,
          source_stage: item.stage,
          school_type: 'general_education',
          school_subtype: null,
          document_type: item.document_type,
          jurisdiction: '中国',
          issuing_body: null,
        },
        work_id: `work:${item.parent_document_id}`,
        edition_id: `edition:${item.id}`,
        embedded_item_id: item.id,
        public_locator: item.public_locator,
        time: { year: item.year, precision: 'year', basis: 'bounded_item_source_year' },
        edition: {
          identity_id: `edition:${item.id}`,
          version_label: `${item.year}年物理页边界候选`,
          preferred_document_id: item.parent_document_id,
          alternate_document_ids: [],
          base_edition_year: item.year,
          revision_year: null,
          identity_status: 'source_hash_bound_bounded_candidate',
        },
        observation: {
          status: 'ocr_complete_pending_item_audit',
          observation_class: 'pre2001_specialist_bounded_ocr_candidate_nonsemantic',
          semantic: false,
          match_type: 'exact_surface_ignoring_whitespace',
          roles: ['unknown'],
          mention_count: mentionCount,
          local_unique_mention_count: mentionCount,
          unique_section_count: null,
          normalized_per_10k: meaningfulCharacters
            ? Number((mentionCount * 10_000 / meaningfulCharacters).toFixed(4))
            : 0,
          heading_hit: null,
          definition_hit: null,
          common_boilerplate_only: false,
          frequency: {
            numerator: mentionCount,
            numerator_unit: 'exact_surface_occurrences_in_bounded_item_ocr',
            denominator: meaningfulCharacters,
            denominator_unit: 'non_whitespace_ocr_characters',
            exclusions: [],
            comparability: 'within_bounded_item_descriptive_only',
            interpretation: null,
          },
          visual_strength: Number(Math.min(0.82, 0.38 + Math.log2(mentionCount + 1) * 0.1).toFixed(4)),
          visual_strength_basis: 'within_candidate_display_scaling_not_historical_magnitude',
        },
        evidence_ids: evidenceIds,
        coverage: {
          coverage_cell_id: `pre2001-coverage:${item.id}`,
          usable_pages: item.pages.length,
          total_pages: item.pages.length,
          complete: true,
          coverage_kind: 'source_hash_bound_bounded_item_ocr',
          negative_claim_eligible: false,
        },
        claim_policy: {
          display_level: 'uniform_star',
          quotation_allowed: false,
          semantic_relation_allowed: false,
          historical_superlative_allowed: false,
          first_appearance_allowed: false,
          disappearance_allowed: false,
        },
      });
      selectedHits.forEach((hit, index) => evidence.push({
        id: evidenceIds[index],
        document_id: item.parent_document_id,
        document_title: item.title,
        page_number: hit.page,
        source_locator: `${item.parent_title} · PDF physical p.${hit.page} · OCR待核`,
        matched_surface: hit.matched_surface,
        snippet: hit.snippet,
        content_sha256: hit.content_sha256,
        public_locator: `${item.public_locator}#page-${hit.page}`,
        citation_allowed: false,
        semantic_claim_allowed: false,
        observation_class: 'pre2001_specialist_bounded_ocr_candidate_nonsemantic',
      }));
    }
  }
  episodes.sort((left, right) =>
    left.time.year - right.time.year
    || left.visibility_facets[0].localeCompare(right.visibility_facets[0], 'zh-CN')
    || left.concept_id.localeCompare(right.concept_id, 'en')
    || left.id.localeCompare(right.id, 'en'));
  evidence.sort((left, right) =>
    left.document_id.localeCompare(right.document_id, 'en')
    || left.page_number - right.page_number
    || left.id.localeCompare(right.id, 'en'));

  const observedConcepts = new Set(episodes.map((episode) => episode.concept_id));
  const missing = concepts.filter((concept) => !observedConcepts.has(concept.id)).map((concept) => concept.id);
  requireValue(missing.length === 0, `pre-2001 concepts have no bounded observation: ${missing.join(', ')}`);
  const facets = [...new Set(episodes.flatMap((episode) => episode.visibility_facets))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  requireValue(facets.length === 12, `expected 12 pre-2001 facets, received ${facets.length}`);

  const itemArtifact = {
    schema_version: 1,
    artifact_profile: 'curriculum-pre2001-specialist-bounded-items-v1',
    snapshot_id: config.snapshot_id,
    assertion_boundary: config.assertion_boundary,
    items: items.map(({ pages, ...item }) => ({
      ...item,
      page_count: pages.length,
    })),
    counts: {
      items: items.length,
      source_documents: new Set(items.map((item) => item.parent_document_id)).size,
      subject_facets: new Set(items.flatMap((item) => item.visibility_facets)).size,
      first_year: Math.min(...items.map((item) => item.year)),
      last_year: Math.max(...items.map((item) => item.year)),
    },
  };
  const embeddedItemsById = new Map(embeddedManifest.items.map((item) => [item.id, item]));
  const itemIds = new Set();
  const identityKeys = new Set();
  const physicalRanges = new Map();
  const identityReceipts = items.map((item) => {
    requireValue(item.title.trim().length > 0, `bounded item title is empty: ${item.id}`);
    requireValue(Number.isInteger(item.year) && item.year >= 1902 && item.year <= 2000,
      `bounded item year is outside 1902-2000: ${item.id}`);
    requireValue(item.visibility_facets.length >= 1 && new Set(item.visibility_facets).size === item.visibility_facets.length,
      `bounded item must have one or more unique visibility facets: ${item.id}`);
    requireValue(!itemIds.has(item.id), `duplicate bounded item id: ${item.id}`);
    itemIds.add(item.id);
    requireValue(
      item.id === itemId(
        item.parent_document_id,
        item.year,
        item.physical_page_start,
        item.title,
        item.visibility_facets,
      ),
      `bounded item stable id is not reproducible: ${item.id}`,
    );
    const source = stateCache.get(`${item.parent_document_id}|${item.ocr_profile}`);
    requireValue(source, `bounded item OCR state is unavailable: ${item.id}`);
    requireValue(item.source_sha256 === source.document.checksum_sha256,
      `bounded item source hash mismatch: ${item.id}`);
    requireValue(
      item.physical_page_start >= 1
      && item.physical_page_end >= item.physical_page_start
      && item.physical_page_end <= source.document.page_count,
      `bounded item physical page range is invalid: ${item.id}`,
    );
    requireValue(
      item.pages.length === item.physical_page_end - item.physical_page_start + 1,
      `bounded item page count does not match its range: ${item.id}`,
    );
    item.pages.forEach((page, index) => {
      requireValue(
        page.page === item.physical_page_start + index,
        `bounded item pages are not contiguous: ${item.id}`,
      );
      requireValue(sha256(Buffer.from(page.content)) === page.content_sha256,
        `bounded item page content hash mismatch: ${item.id} p.${page.page}`);
    });
    const recomputedRangeHash = sha256(
      item.pages.map((page) => `${page.page}:${page.content_sha256}`).join('\n'),
    );
    requireValue(recomputedRangeHash === item.range_content_sha256,
      `bounded item range content hash mismatch: ${item.id}`);
    let sourceItem = null;
    if (item.source_item_id) {
      sourceItem = embeddedItemsById.get(item.source_item_id);
      requireValue(sourceItem, `bounded item source item does not resolve: ${item.id}`);
      requireValue(sourceItem.parent_document_id === item.parent_document_id,
        `bounded item source item belongs to another document: ${item.id}`);
      const sourceStart = Math.min(...sourceItem.segments.map((segment) => segment.physical_page_start));
      const sourceEnd = Math.max(...sourceItem.segments.map((segment) => segment.physical_page_end));
      requireValue(sourceStart === item.physical_page_start && sourceEnd === item.physical_page_end,
        `bounded item source item page range mismatch: ${item.id}`);
    }
    const identityPayload = {
      parent_document_id: item.parent_document_id,
      source_sha256: item.source_sha256,
      year: item.year,
      title: item.title,
      visibility_facets: item.visibility_facets,
      physical_page_start: item.physical_page_start,
      physical_page_end: item.physical_page_end,
      range_content_sha256: recomputedRangeHash,
      source_item_id: item.source_item_id,
      boundary_basis: item.boundary_basis,
    };
    const identitySha256 = sha256(JSON.stringify(identityPayload));
    requireValue(!identityKeys.has(identitySha256),
      `duplicate bounded item identity: ${item.id}`);
    identityKeys.add(identitySha256);
    const physicalRangeKey = [
      item.parent_document_id,
      item.physical_page_start,
      item.physical_page_end,
    ].join('|');
    if (!physicalRanges.has(physicalRangeKey)) physicalRanges.set(physicalRangeKey, []);
    physicalRanges.get(physicalRangeKey).push(item);
    return {
      receipt_id: `pre2001-identity-receipt:${sha256(item.id).slice(0, 20)}`,
      item_id: item.id,
      identity_sha256: identitySha256,
      parent_document_id: item.parent_document_id,
      source_sha256: item.source_sha256,
      ocr_profile: item.ocr_profile,
      ocr_state_sha256: source.state_sha256,
      year: item.year,
      title: item.title,
      visibility_facets: item.visibility_facets,
      physical_page_start: item.physical_page_start,
      physical_page_end: item.physical_page_end,
      page_count: item.pages.length,
      range_content_sha256: recomputedRangeHash,
      source_item_id: item.source_item_id,
      source_item_resolved: !item.source_item_id || Boolean(sourceItem),
      boundary_basis: item.boundary_basis,
      checks: {
        stable_item_id: true,
        source_document_bound: true,
        source_pdf_hash_bound: true,
        ocr_state_hash_bound: true,
        contiguous_page_range: true,
        page_content_hashes_recomputed: true,
        range_content_hash_recomputed: true,
        year_in_policy_range: true,
        visibility_facets_are_nonempty_and_unique: true,
        source_item_resolved: !item.source_item_id || Boolean(sourceItem),
      },
    };
  });
  const sharedPhysicalRanges = [...physicalRanges.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([rangeKey, entries]) => ({
      range_key: rangeKey,
      item_ids: entries.map((item) => item.id).sort((left, right) => left.localeCompare(right, 'en')),
      visibility_facets: entries
        .map((item) => item.visibility_facets[0])
        .sort((left, right) => left.localeCompare(right, 'zh-CN')),
      disposition: 'intentional_distinct_facet_identities_on_shared_source_range',
    }))
    .sort((left, right) => left.range_key.localeCompare(right.range_key, 'en'));
  requireValue(sharedPhysicalRanges.length === 1,
    `expected one intentional shared physical range, received ${sharedPhysicalRanges.length}`);
  requireValue(
    sharedPhysicalRanges[0].range_key === 'legacy-compendium-plans|122|125'
    && sharedPhysicalRanges[0].visibility_facets.join('|') === '历史与社会|体育与健康',
    'intentional shared physical range disposition drifted',
  );
  const sourceItemLinks = identityReceipts.filter((receipt) => receipt.source_item_id);
  requireValue(sourceItemLinks.length === 135, `expected 135 source-item links, received ${sourceItemLinks.length}`);
  requireValue(
    new Set(sourceItemLinks.map((receipt) => receipt.source_item_id)).size === embeddedManifest.items.length,
    'not every embedded source item resolves into the bounded layer',
  );
  const identityReceipt = {
    schema_version: 1,
    artifact_profile: 'curriculum-pre2001-bounded-identity-verification-v1',
    snapshot_id: config.snapshot_id,
    generated_at: '2026-07-24T00:00:00.000Z',
    verification_policy: {
      execution: 'fully_machine_reproducible_fail_closed',
      identity_unit: 'source_pdf_hash_plus_bounded_range_plus_year_title_and_visibility_facets',
      shared_physical_range_policy: 'allowed_only_when_distinct_visibility_facets_produce_distinct_identities',
      citation_allowed: false,
      semantic_claim_allowed: false,
      deployment_requires_zero_failed_receipts: true,
    },
    source_bindings: {
      bounded_source: {
        path: path.relative(ROOT, SOURCE_PATH),
        sha256: sha256(configBytes),
      },
      embedded_items: {
        path: path.relative(ROOT, embeddedManifestPath),
        sha256: sha256(embeddedManifestBytes),
      },
      local_compendia: {
        path: path.relative(ROOT, COMPENDIA_PATH),
        sha256: sha256(compendiaBytes),
      },
      concept_families: {
        path: path.relative(ROOT, FAMILY_PATH),
        sha256: sha256(familyBytes),
      },
    },
    counts: {
      items: identityReceipts.length,
      unique_item_ids: itemIds.size,
      unique_identity_keys: identityKeys.size,
      unique_physical_ranges: physicalRanges.size,
      intentional_shared_physical_ranges: sharedPhysicalRanges.length,
      source_item_links: sourceItemLinks.length,
      distinct_source_items_resolved: new Set(
        sourceItemLinks.map((receipt) => receipt.source_item_id),
      ).size,
      failed_receipts: identityReceipts.filter((receipt) =>
        Object.values(receipt.checks).some((passed) => !passed)).length,
    },
    shared_physical_ranges: sharedPhysicalRanges,
    receipts: identityReceipts.sort((left, right) => left.item_id.localeCompare(right.item_id, 'en')),
    release_gate: {
      deployment_allowed: true,
      candidate_display_allowed: true,
      citation_allowed: false,
      semantic_claim_allowed: false,
      reason: 'all_462_bounded_item_identities_are_reproducible_and_source_hash_bound',
    },
  };
  const layer = {
    schema_version: 1,
    artifact_profile: 'curriculum-pre2001-subject-detail-observation-layer-v1',
    snapshot_id: config.snapshot_id,
    publication_status: 'candidate_fail_closed',
    assertion_boundary: config.assertion_boundary,
    projection_policy: config.projection_policy,
    node_semantics: 'pre2001_subject_detail_concept_observation_episode_not_document',
    time_semantics: 'year_is_single_spatial_coordinate_not_a_second_timeline',
    sources: [...stateCache.values()].map((source) => ({
      document_id: source.document.id,
      document_title: source.document.title,
      ocr_profile: source.profile,
      source_sha256: source.document.checksum_sha256,
      state_sha256: source.state_sha256,
      completed_pages: source.completed.size,
      failed_pages: source.failed.size,
      citation_allowed: false,
    })).sort((left, right) =>
      left.document_id.localeCompare(right.document_id, 'en')
      || left.ocr_profile.localeCompare(right.ocr_profile, 'en')),
    items: itemArtifact.items,
    concepts: concepts.map((concept) => ({
      id: concept.id,
      label: concept.label,
      category: concept.category,
      visibility_facets: concept.visibility_facets,
      observed_years: [...new Set(episodes
        .filter((episode) => episode.concept_id === concept.id)
        .map((episode) => episode.time.year))].sort((left, right) => left - right),
    })),
    episodes,
    evidence,
    edges: [],
    discipline_relations: config.discipline_relation_assertions,
    counts: {
      subject_facets: facets.length,
      source_documents: new Set(items.map((item) => item.parent_document_id)).size,
      bounded_items: items.length,
      controlled_concepts: concepts.length,
      observed_concepts: observedConcepts.size,
      episodes: episodes.length,
      evidence: evidence.length,
      first_year: Math.min(...episodes.map((episode) => episode.time.year)),
      last_year: Math.max(...episodes.map((episode) => episode.time.year)),
    },
  };
  return { itemArtifact, identityReceipt, layer };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { itemArtifact, identityReceipt, layer } = await build();
  const expectedItems = stableJson(itemArtifact);
  const expectedIdentityReceipt = stableJson(identityReceipt);
  const expectedLayer = stableJson(layer);
  if (options.check) {
    const [actualItems, actualIdentityReceipt, actualLayer] = await Promise.all([
      readFile(ITEMS_PATH, 'utf8'),
      readFile(IDENTITY_RECEIPT_PATH, 'utf8'),
      readFile(OUTPUT_PATH, 'utf8'),
    ]);
    if (
      actualItems !== expectedItems
      || actualIdentityReceipt !== expectedIdentityReceipt
      || actualLayer !== expectedLayer
    ) {
      throw new Error('pre-2001 specialist artifacts are stale; run npm run pre2001:build');
    }
    process.stdout.write(
      `Pre-2001 specialist layer verified: ${layer.counts.bounded_items} items, `
      + `${identityReceipt.counts.unique_identity_keys} identities, `
      + `${layer.counts.observed_concepts} concepts, ${layer.counts.episodes} episodes.\n`,
    );
    return;
  }
  await Promise.all([
    writeFile(ITEMS_PATH, expectedItems),
    writeFile(IDENTITY_RECEIPT_PATH, expectedIdentityReceipt),
    writeFile(OUTPUT_PATH, expectedLayer),
  ]);
  process.stdout.write(
    `Pre-2001 specialist layer built: ${layer.counts.bounded_items} items, `
    + `${identityReceipt.counts.unique_identity_keys} identities, `
    + `${layer.counts.observed_concepts} concepts, ${layer.counts.episodes} episodes.\n`,
  );
}

await main();
