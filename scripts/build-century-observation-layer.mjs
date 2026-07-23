#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_PATH = path.join(ROOT, 'data/century-observation-source.json');
const MANIFEST_PATH = path.join(ROOT, 'data/embedded-items-century-v1.json');
const PUBLIC_PATH = path.join(ROOT, 'public/data/century-observation-layer.json');
const ARCHIVE_ROOT = 'production-p1-mb16-shard-b-r3';
const ASSERTION_BOUNDARY = '本层只陈述汇编目录中的条目身份、页段顺序及 OCR 词面共同出现。它不证明原文件颁行效力、版本替代、概念连续性、影响或因果；所有条目与关系均禁止作为引文或 AI 证据。';

const SOURCE_CONFIGS = [
  {
    document_id: 'legacy-compendium-chinese',
    subject: '语文',
    toc_pages: [11, 12, 13],
    expected_toc_entries: 59,
    expected_items: 57,
    page_count: 568,
    printed_to_physical_offset: 14,
  },
  {
    document_id: 'legacy-compendium-plans',
    subject: '课程方案',
    toc_pages: [11, 12, 13, 14],
    expected_toc_entries: 79,
    expected_items: 77,
    page_count: 423,
    printed_to_physical_offset: 14,
  },
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseArgs(argv) {
  const options = { check: false, captureArchive: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--capture-archive') {
      options.captureArchive = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.check && options.captureArchive) throw new Error('--check and --capture-archive cannot be combined');
  return options;
}

function normalizeTitle(value) {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s+([）》」])/g, '$1')
    .replace(/([《（“])\s+/g, '$1')
    .trim();
}

function parseTocSource(source) {
  const items = [];
  let chineseStage = '小学';
  for (const page of source.toc_pages) {
    for (const rawLine of page.content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (source.document_id === 'legacy-compendium-chinese') {
        if (/小学部分/.test(line)) chineseStage = '小学';
        if (/中学部分/.test(line)) chineseStage = '中学';
      }
      const match = line.match(/^((?:19|20)\d{2})\s*年?\s+(.+?)(?:\s*[.．…·]{2,}\s*|\s+)(\d+)\s*$/);
      if (!match) continue;
      const year = Number(match[1]);
      const title = normalizeTitle(match[2]);
      const printedPageStart = Number(match[3]);
      items.push({
        toc_index: items.length + 1,
        year,
        title,
        stage: source.document_id === 'legacy-compendium-chinese' ? chineseStage : deriveStage(title),
        printed_page_start: printedPageStart,
        physical_page_start: printedPageStart + source.printed_to_physical_offset,
      });
    }
  }
  if (items.length !== source.expected_toc_entries) {
    throw new Error(`${source.document_id} parsed ${items.length} TOC entries, expected ${source.expected_toc_entries}`);
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const next = items[index + 1];
    item.physical_page_end = next ? next.physical_page_start - 1 : source.page_count;
    item.printed_page_end = item.physical_page_end - source.printed_to_physical_offset;
    if (item.physical_page_start > item.physical_page_end || item.physical_page_end > source.page_count) {
      throw new Error(`${source.document_id} invalid page range at toc item ${item.toc_index}`);
    }
  }
  return items;
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
  const types = [
    ['教学大纲', '教学大纲'],
    ['课程标准', '课程标准'],
    ['课程纲要', '课程纲要'],
    ['课程计划', '课程计划'],
    ['教学计划', '教学计划'],
    ['授课时数表', '授课时数表'],
    ['课程表', '课程表'],
    ['章程', '学制章程'],
    ['条例', '学校条例'],
    ['规程', '学校规程'],
    ['校历', '校历'],
    ['通知', '通知'],
    ['命令', '命令'],
    ['意见', '意见'],
    ['规定', '规定'],
    ['说明', '说明'],
    ['令', '法令'],
  ];
  return types.find(([needle]) => title.includes(needle))?.[1] || '历史课程文件';
}

function deriveTitleStatus(title) {
  if (/(草案|初稿|初审稿)/.test(title)) return 'draft_named_in_title';
  if (/(试行|试用|试验)/.test(title)) return 'trial_named_in_title';
  if (/(修订|调整|修正)/.test(title)) return 'revision_named_in_title';
  return 'status_not_asserted_from_title';
}

function itemId(documentId, item) {
  return `embedded-century:${documentId}:${sha256(`${item.year}|${item.printed_page_start}|${item.title}`).slice(0, 16)}`;
}

function identityTitle(source, item) {
  if (source.document_id !== 'legacy-compendium-chinese') return item.title;
  return item.title.replaceAll('（摘录）', '').replaceAll('（试用）', '').trim();
}

function mergeTocItems(source, parsedItems) {
  const groups = new Map();
  let previousGroup = null;
  for (const item of parsedItems) {
    const supplementalContext = source.document_id === 'legacy-compendium-plans'
      && item.year === 1936
      && /课程标准变更之概况（摘录）/.test(item.title);
    if (supplementalContext) {
      if (!previousGroup) throw new Error(`${source.document_id} supplemental context has no parent`);
      previousGroup.title_variants.push(item.title);
      previousGroup.stages.push(item.stage);
      previousGroup.segments.push({
        toc_index: item.toc_index,
        stage: item.stage,
        role: 'editorial_context_excerpt',
        printed_page_start: item.printed_page_start,
        printed_page_end: item.printed_page_end,
        physical_page_start: item.physical_page_start,
        physical_page_end: item.physical_page_end,
      });
      continue;
    }
    const title = identityTitle(source, item);
    const key = `${item.year}|${title.replace(/\s+/g, '')}`;
    const group = groups.get(key) || {
      year: item.year,
      title,
      title_variants: [],
      stages: [],
      segments: [],
    };
    group.title_variants.push(item.title);
    group.stages.push(item.stage);
    group.segments.push({
      toc_index: item.toc_index,
      stage: item.stage,
      role: 'primary_item',
      printed_page_start: item.printed_page_start,
      printed_page_end: item.printed_page_end,
      physical_page_start: item.physical_page_start,
      physical_page_end: item.physical_page_end,
    });
    groups.set(key, group);
    previousGroup = group;
  }
  const merged = [...groups.values()].map((group) => ({
    ...group,
    printed_page_start: group.segments[0].printed_page_start,
    stage: [...new Set(group.stages)].length === 1 ? group.stages[0] : '小学—中学',
    title_variants: [...new Set(group.title_variants)],
  }));
  if (merged.length !== source.expected_items) {
    throw new Error(`${source.document_id} resolved ${merged.length} embedded items, expected ${source.expected_items}`);
  }
  return merged;
}

function pageFile(root, documentId, pageNumber) {
  return path.join(
    root,
    ARCHIVE_ROOT,
    'documents',
    documentId,
    'pages',
    String(pageNumber).padStart(4, '0'),
    'content.md',
  );
}

function sourceTextForMatch(content) {
  return content.replace(/!\[[^\]]*\]\([^)]+\)/g, ' ').replace(/\s+/g, ' ');
}

function countSurface(content, surface) {
  let count = 0;
  let offset = content.indexOf(surface);
  while (offset !== -1) {
    count += 1;
    offset = content.indexOf(surface, offset + surface.length);
  }
  return count;
}

async function captureConceptObservations(extractedRoot, source, items, lexicon) {
  const relevantConcepts = lexicon.concepts
    .filter((concept) => concept.subjects.includes('*')
      || (source.subject === '语文' && concept.subjects.some((subject) => ['语文', '生活语文', '汉语'].includes(subject))))
    .map((concept) => ({
      ...concept,
      surfaces: [...new Set([concept.label, ...(concept.aliases || [])])].sort((left, right) => right.length - left.length),
    }));
  const output = [];
  for (const item of items) {
    const contentHashes = [];
    const concepts = new Map();
    for (let physicalPage = item.physical_page_start; physicalPage <= item.physical_page_end; physicalPage += 1) {
      const buffer = await readFile(pageFile(extractedRoot, source.document_id, physicalPage));
      const pageHash = sha256(buffer);
      const content = sourceTextForMatch(buffer.toString('utf8'));
      contentHashes.push(`${physicalPage}:${pageHash}`);
      for (const concept of relevantConcepts) {
        let mentions = 0;
        const matchedSurfaces = [];
        for (const surface of concept.surfaces) {
          const count = countSurface(content, surface);
          if (count > 0) {
            mentions += count;
            matchedSurfaces.push(surface);
          }
        }
        if (!mentions) continue;
        const previous = concepts.get(concept.id) || {
          concept_id: concept.id,
          label: concept.label,
          category: concept.category,
          mention_count: 0,
          observed_physical_pages: [],
          observed_surfaces: [],
        };
        previous.mention_count += mentions;
        previous.observed_physical_pages.push(physicalPage);
        previous.observed_surfaces.push(...matchedSurfaces);
        concepts.set(concept.id, previous);
      }
    }
    output.push({
      toc_index: item.toc_index,
      range_content_sha256: sha256(contentHashes.join('\n')),
      scanned_pages: contentHashes.length,
      concept_candidates: [...concepts.values()]
        .map((concept) => ({
          ...concept,
          observed_physical_pages: [...new Set(concept.observed_physical_pages)],
          observed_surfaces: [...new Set(concept.observed_surfaces)].sort((left, right) => left.localeCompare(right, 'zh-CN')),
        }))
        .sort((left, right) => left.concept_id.localeCompare(right.concept_id, 'en')),
    });
  }
  return output;
}

async function captureSource(archivePath) {
  const [localCompendia, lexicon, inventory, checksums] = await Promise.all([
    readFile(path.join(ROOT, 'data/local-compendia.json'), 'utf8').then(JSON.parse),
    readFile(path.join(ROOT, 'data/concept-lexicon.json'), 'utf8').then(JSON.parse),
    readFile(path.join(path.dirname(archivePath), 'inventory.json'), 'utf8').then(JSON.parse),
    readFile(path.join(path.dirname(archivePath), 'SHA256SUMS'), 'utf8'),
  ]);
  const archiveSha = checksums.match(/^([a-f0-9]{64})\s+output\.tar\.zst$/m)?.[1];
  if (!archiveSha) throw new Error('output.tar.zst checksum missing from SHA256SUMS');
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'curriculum-century-'));
  try {
    const pagePaths = SOURCE_CONFIGS.flatMap((source) => Array.from(
      { length: source.page_count },
      (_, index) => `${ARCHIVE_ROOT}/documents/${source.document_id}/pages/${String(index + 1).padStart(4, '0')}/content.md`,
    ));
    const extraction = spawnSync('tar', [
      '--use-compress-program=unzstd',
      '-xf',
      path.resolve(archivePath),
      '-C',
      tempRoot,
      ...pagePaths,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 8 });
    if (extraction.status !== 0) {
      throw new Error(`archive extraction failed: ${extraction.stderr || extraction.stdout}`);
    }
    const documentsById = new Map(localCompendia.documents.map((document) => [document.id, document]));
    const sources = [];
    for (const config of SOURCE_CONFIGS) {
      const document = documentsById.get(config.document_id);
      if (!document) throw new Error(`missing local compendium metadata: ${config.document_id}`);
      if (document.page_count !== config.page_count) throw new Error(`page count drift: ${config.document_id}`);
      const tocPages = await Promise.all(config.toc_pages.map(async (physicalPage) => {
        const content = await readFile(pageFile(tempRoot, config.document_id, physicalPage), 'utf8');
        return { physical_page: physicalPage, content_sha256: sha256(content), content };
      }));
      const source = {
        ...config,
        title: document.title,
        source_pdf_sha256: document.checksum_sha256,
        redistribution: document.redistribution,
        citation_allowed: false,
        toc_pages: tocPages,
      };
      const items = parseTocSource(source);
      source.item_observations = await captureConceptObservations(tempRoot, source, items, lexicon);
      sources.push(source);
    }
    return {
      schema_version: 1,
      artifact_profile: 'curriculum-century-observation-source-v1',
      source_snapshot: '20260718-b3-final',
      assertion_boundary: ASSERTION_BOUNDARY,
      archive: {
        sha256: archiveSha,
        tree_sha256: inventory.source_tree_sha256,
        regular_files: inventory.regular_files,
        source_bytes: inventory.source_bytes,
        citation_allowed: false,
        receiver_apply_allowed: false,
      },
      sources,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function buildArtifacts(sourceEnvelope) {
  if (sourceEnvelope.schema_version !== 1
    || sourceEnvelope.artifact_profile !== 'curriculum-century-observation-source-v1'
    || sourceEnvelope.archive?.citation_allowed !== false
    || sourceEnvelope.sources?.length !== 2) {
    throw new Error('century observation source failed structural validation');
  }
  const items = [];
  const conceptObservations = [];
  const sourceDocuments = [];
  for (const source of sourceEnvelope.sources) {
    const parsed = parseTocSource(source);
    const observationsByIndex = new Map(source.item_observations.map((item) => [item.toc_index, item]));
    sourceDocuments.push({
      document_id: source.document_id,
      title: source.title,
      subject: source.subject,
      source_pdf_sha256: source.source_pdf_sha256,
      page_count: source.page_count,
      toc_physical_pages: source.toc_pages.map((page) => page.physical_page),
      toc_content_sha256: sha256(source.toc_pages.map((page) => `${page.physical_page}:${page.content_sha256}`).join('\n')),
      printed_to_physical_offset: source.printed_to_physical_offset,
      citation_allowed: false,
    });
    const mergedItems = mergeTocItems(source, parsed);
    for (const parsedItem of mergedItems) {
      const segmentObservations = parsedItem.segments.map((segment) => {
        const observation = observationsByIndex.get(segment.toc_index);
        const expectedPages = segment.physical_page_end - segment.physical_page_start + 1;
        if (!observation || observation.scanned_pages !== expectedPages) {
          throw new Error(`${source.document_id} missing bounded observation scan for toc item ${segment.toc_index}`);
        }
        return observation;
      });
      const id = itemId(source.document_id, parsedItem);
      const conceptMap = new Map();
      for (const observation of segmentObservations) {
        for (const concept of observation.concept_candidates) {
          const previous = conceptMap.get(concept.concept_id) || {
            ...concept,
            mention_count: 0,
            observed_physical_pages: [],
            observed_surfaces: [],
          };
          previous.mention_count += concept.mention_count;
          previous.observed_physical_pages.push(...concept.observed_physical_pages);
          previous.observed_surfaces.push(...concept.observed_surfaces);
          conceptMap.set(concept.concept_id, previous);
        }
      }
      const item = {
        id,
        parent_document_id: source.document_id,
        parent_title: source.title,
        subject: source.subject,
        year: parsedItem.year,
        title: parsedItem.title,
        stage: parsedItem.stage,
        document_type: deriveDocumentType(parsedItem.title),
        title_status: deriveTitleStatus(parsedItem.title_variants.join(' ')),
        title_variants: parsedItem.title_variants,
        segments: parsedItem.segments,
        range_content_sha256: sha256(segmentObservations.map((observation) => observation.range_content_sha256).join('\n')),
        identity_status: 'toc_bound_candidate',
        observation_status: 'ocr_complete_pending_item_audit',
        citation_allowed: false,
        semantic_claim_allowed: false,
        public_locator: `/historical/${encodeURIComponent(id)}`,
      };
      items.push(item);
      for (const concept of [...conceptMap.values()].sort((left, right) => left.concept_id.localeCompare(right.concept_id, 'en'))) {
        conceptObservations.push({
          id: `century-concept:${sha256(`${id}|${concept.concept_id}`).slice(0, 20)}`,
          item_id: id,
          concept_id: concept.concept_id,
          label: concept.label,
          category: concept.category,
          subject: source.subject,
          year: parsedItem.year,
          mention_count: concept.mention_count,
          observed_physical_pages: [...new Set(concept.observed_physical_pages)].sort((left, right) => left - right),
          observed_surfaces: [...new Set(concept.observed_surfaces)].sort((left, right) => left.localeCompare(right, 'zh-CN')),
          observation_class: 'ocr_surface_candidate_nonsemantic',
          semantic: false,
          citation_allowed: false,
        });
      }
    }
  }
  items.sort((left, right) => left.year - right.year
    || left.subject.localeCompare(right.subject, 'zh-CN')
    || left.segments[0].printed_page_start - right.segments[0].printed_page_start);
  conceptObservations.sort((left, right) => left.year - right.year
    || left.item_id.localeCompare(right.item_id, 'en')
    || left.concept_id.localeCompare(right.concept_id, 'en'));

  const sequenceRelations = [];
  for (const source of sourceEnvelope.sources) {
    const sourceItems = items
      .filter((item) => item.parent_document_id === source.document_id)
      .sort((left, right) => left.year - right.year
        || left.segments[0].printed_page_start - right.segments[0].printed_page_start);
    for (let index = 1; index < sourceItems.length; index += 1) {
      sequenceRelations.push({
        id: `century-sequence:${sha256(`${sourceItems[index - 1].id}|${sourceItems[index].id}`).slice(0, 20)}`,
        source: sourceItems[index - 1].id,
        target: sourceItems[index].id,
        type: 'source_order_adjacent',
        assertion_type: 'adjacent_in_compendium_table_of_contents',
        semantic: false,
        influence_claim_allowed: false,
      });
    }
  }

  const observationsByItem = new Map();
  for (const observation of conceptObservations) {
    const list = observationsByItem.get(observation.item_id) || [];
    list.push(observation.concept_id);
    observationsByItem.set(observation.item_id, list);
  }
  const pairCounts = new Map();
  for (const conceptIds of observationsByItem.values()) {
    const uniqueIds = [...new Set(conceptIds)].sort((left, right) => left.localeCompare(right, 'en'));
    for (let left = 0; left < uniqueIds.length; left += 1) {
      for (let right = left + 1; right < uniqueIds.length; right += 1) {
        const key = `${uniqueIds[left]}|${uniqueIds[right]}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }
  const coObservationRelations = [...pairCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort(([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || leftKey.localeCompare(rightKey, 'en'))
    .slice(0, 160)
    .map(([key, sharedItemCount]) => {
      const [source, target] = key.split('|');
      return {
        id: `century-co-observation:${sha256(key).slice(0, 20)}`,
        source,
        target,
        type: 'surface_co_observed_in_item',
        assertion_type: 'lexicon_surfaces_observed_within_same_toc_bounded_item',
        metric: { shared_item_count: sharedItemCount },
        semantic: false,
        influence_claim_allowed: false,
      };
    });
  const manifest = {
    schema_version: 1,
    artifact_profile: 'curriculum-embedded-century-items-v1',
    source_snapshot: sourceEnvelope.source_snapshot,
    assertion_boundary: ASSERTION_BOUNDARY,
    source_archive: sourceEnvelope.archive,
    source_documents: sourceDocuments,
    items,
    counts: {
      items: items.length,
      chinese_items: items.filter((item) => item.subject === '语文').length,
      plan_items: items.filter((item) => item.subject === '课程方案').length,
      first_year: Math.min(...items.map((item) => item.year)),
      last_year: Math.max(...items.map((item) => item.year)),
    },
  };
  const layer = {
    schema_version: 1,
    artifact_profile: 'curriculum-century-candidate-observation-layer-v1',
    source_snapshot: sourceEnvelope.source_snapshot,
    assertion_boundary: ASSERTION_BOUNDARY,
    publication_status: 'candidate_fail_closed',
    source_documents: sourceDocuments,
    items,
    concept_observations: conceptObservations,
    relations: [...sequenceRelations, ...coObservationRelations],
    counts: {
      items: items.length,
      concept_observations: conceptObservations.length,
      observed_concepts: new Set(conceptObservations.map((item) => item.concept_id)).size,
      sequence_relations: sequenceRelations.length,
      co_observation_relations: coObservationRelations.length,
      first_year: Math.min(...items.map((item) => item.year)),
      last_year: Math.max(...items.map((item) => item.year)),
    },
  };
  if (manifest.counts.items !== 134 || manifest.counts.chinese_items !== 57 || manifest.counts.plan_items !== 77) {
    throw new Error(`embedded item invariant failed: ${JSON.stringify(manifest.counts)}`);
  }
  return { manifest, layer };
}

async function assertExact(pathname, expected) {
  const actual = await readFile(pathname, 'utf8');
  if (actual !== expected) throw new Error(`${path.relative(ROOT, pathname)} is stale; run npm run century:build`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let sourceEnvelope;
  if (options.captureArchive) {
    sourceEnvelope = await captureSource(path.resolve(options.captureArchive));
    await writeFile(SOURCE_PATH, stableJson(sourceEnvelope));
  } else {
    sourceEnvelope = JSON.parse(await readFile(SOURCE_PATH, 'utf8'));
  }
  const { manifest, layer } = buildArtifacts(sourceEnvelope);
  const manifestJson = stableJson(manifest);
  const layerJson = stableJson(layer);
  if (options.check) {
    await Promise.all([
      assertExact(MANIFEST_PATH, manifestJson),
      assertExact(PUBLIC_PATH, layerJson),
    ]);
    process.stdout.write(`Century layer verified: ${manifest.counts.items} items, ${layer.counts.concept_observations} concept observations.\n`);
    return;
  }
  await Promise.all([
    writeFile(MANIFEST_PATH, manifestJson),
    writeFile(PUBLIC_PATH, layerJson),
  ]);
  process.stdout.write(`Century layer built: ${manifest.counts.items} items, ${layer.counts.concept_observations} concept observations.\n`);
}

await main();
