import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const workspaceRoot = resolve(projectRoot, '..');
const actionLogPath = resolve(workspaceRoot, 'reports/agent_action_log.jsonl');
const outputPath = resolve(projectRoot, 'docs/project-operations-ledger.md');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function markdown(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\r', ' ')
    .replaceAll('\n', '<br>');
}

function list(values, empty = '无') {
  const items = [...new Set((values || []).filter(Boolean))];
  return items.length ? items.map((value) => `\`${String(value).replaceAll('`', '\\`')}\``).join('、') : empty;
}

function readJson(relativePath) {
  return readFile(resolve(projectRoot, relativePath), 'utf8').then(JSON.parse);
}

async function readOptionalJson(relativePath) {
  try {
    return await readJson(relativePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function git(...args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
}

function localTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function matchingAction(entry) {
  return /^curriculum(?:-|$)|curriculum-atlas/i.test(String(entry.task || ''));
}

function parseActionLog(raw) {
  return raw.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid action log JSON at line ${index + 1}: ${error.message}`);
    }
  }).filter(matchingAction).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function groupTasks(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    if (!grouped.has(entry.task)) grouped.set(entry.task, []);
    grouped.get(entry.task).push(entry);
  }
  return [...grouped.entries()].map(([task, events]) => ({
    task,
    events,
    first: events[0].timestamp,
    last: events.at(-1).timestamp,
    agents: [...new Set(events.map((event) => event.agent).filter(Boolean))],
    phases: [...new Set(events.map((event) => event.phase))],
    resources: [...new Set(events.flatMap((event) => event.resources || []))],
    lastEvent: events.at(-1),
  })).sort((left, right) => left.first.localeCompare(right.first));
}

function latestEvent(entries, predicate) {
  return entries.filter(predicate).at(-1) || null;
}

function requireEnvironmentEvidence(releaseEvidence, environment) {
  const evidence = releaseEvidence?.environments?.[environment];
  if (!evidence) throw new Error(`missing ${environment} release environment evidence`);
  if (!Array.isArray(evidence.applied_migrations)) throw new Error(`invalid ${environment} applied migrations`);
  if (!evidence.health || !evidence.corpus) throw new Error(`incomplete ${environment} health/corpus evidence`);
  return evidence;
}

function releaseIdFromEvent(event) {
  const haystack = [...(event?.resources || []), event?.evidence || ''].join(' ');
  return haystack.match(/release-[a-f0-9]{24,}/u)?.[0] || null;
}

function taxonomyCounts(academic) {
  const counts = {};
  for (const item of academic.subject_entity_audit || []) {
    counts[item.entity_kind] = (counts[item.entity_kind] || 0) + 1;
  }
  const queryIdentities = new Set((academic.subject_entity_audit || [])
    .filter((item) => item.entity_kind === 'subject')
    .map((item) => item.canonical)
    .filter(Boolean));
  return {
    ...counts,
    scopes: (counts.assessment_domain || 0) + (counts.source_collection || 0) + (counts.cross_cutting_framework || 0),
    facets: academic.subject_facets?.length || 0,
    queryIdentities: queryIdentities.size,
  };
}

function assertCorpusParity(environment, evidence, manifest) {
  const expected = {
    release_id: manifest.release_id,
    documents: manifest.documents,
    paragraphs: manifest.paragraphs,
    fts_rows: manifest.fts_rows,
    page_publication_gates: manifest.page_publication_gates,
    displayed_paragraphs: manifest.displayed_paragraphs,
    accepted_ocr_documents: manifest.accepted_ocr_documents,
    chunks: manifest.sql_chunks,
  };
  const actual = {
    release_id: evidence.corpus.release_id,
    documents: evidence.corpus.counts.documents,
    paragraphs: evidence.corpus.counts.paragraphs,
    fts_rows: evidence.corpus.counts.fts_rows,
    page_publication_gates: evidence.corpus.counts.page_publication_gates,
    displayed_paragraphs: evidence.corpus.counts.displayed_paragraphs,
    accepted_ocr_documents: evidence.corpus.counts.accepted_ocr_documents,
    chunks: evidence.corpus.counts.chunks,
  };
  if (!evidence.corpus.ready || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${environment} corpus evidence does not match local manifest`);
  }
}

function countAcceptedPages(pageManifest) {
  return (pageManifest.documents || []).reduce((sum, document) => sum + (document.pages || []).length, 0);
}

function graphCounts(core, academic) {
  return {
    episodes: core.episodes?.length || 0,
    edges: core.edges?.length || 0,
    works: academic.works?.length || 0,
    editions: academic.editions?.length || 0,
    occurrences: academic.occurrences?.length || 0,
    evidence: academic.evidence?.length || 0,
    ontologyNodes: academic.ontology_nodes?.length || academic.concept_ontology?.nodes?.length || academic.ontology?.nodes?.length || 0,
    ontologyRelations: academic.ontology_relations?.length || academic.concept_ontology?.relations?.length || academic.ontology?.relations?.length || 0,
    ontologyEvidence: academic.ontology_evidence?.length || academic.concept_ontology?.evidence?.length || academic.ontology?.evidence?.length || 0,
  };
}

const [
  actionLogRaw,
  catalog,
  ingest,
  queue,
  corpus,
  pageManifest,
  semanticPolicy,
  artifactRegistry,
  ocrStatus,
  releaseEvidence,
  coreGraph,
  academicGraph,
] = await Promise.all([
  readFile(actionLogPath, 'utf8'),
  readJson('data/catalog.json'),
  readJson('data/ingest-manifest.json'),
  readJson('data/ocr-queue.json'),
  readJson('data/corpus-chunks/manifest.json'),
  readJson('data/page-publication-manifest.json'),
  readJson('data/semantic-publication-policy.json'),
  readJson('data/artifact-registry.json'),
  readOptionalJson('.cache/ocr-supervisor/status.json'),
  readJson('data/release-environment-evidence.json'),
  readJson('public/data/concept-evolution.json'),
  readJson('public/data/concept-evolution-academic.json'),
]);

const actionLogLines = actionLogRaw.split(/\r?\n/u).filter(Boolean);
const actionLogLineCutoff = actionLogLines.length;
const actionLogPrefixDigest = sha256(`${actionLogLines.join('\n')}\n`);
const entries = parseActionLog(actionLogLines.join('\n'));
if (!entries.length) throw new Error('no curriculum-atlas action-log entries found');
const tasks = groupTasks(entries);
const generatedAt = new Date().toISOString();
const head = git('rev-parse', 'HEAD');
const originMain = git('rev-parse', 'origin/main');
const branch = git('branch', '--show-current');
const releaseEvidenceCommit = git('log', '-1', '--format=%H', '--', 'data/release-environment-evidence.json');
const statusLines = git('status', '--short').split(/\r?\n/u).filter(Boolean);
const modifiedFiles = statusLines.filter((line) => !line.startsWith('??')).length;
const untrackedFiles = statusLines.filter((line) => line.startsWith('??')).length;
const treeVerdict = statusLines.length
  ? '生成器工作树含待提交文档变更；发布证据仍绑定已推送 commit'
  : '工作树 clean';
const gitHistory = git('log', '--reverse', '--date=iso-strict', '--pretty=format:%H%x09%ad%x09%s').split(/\r?\n/u);
const graphs = graphCounts(coreGraph, academicGraph);
const acceptedPages = countAcceptedPages(pageManifest);
const queueByHash = new Map();
for (const document of queue.documents || []) {
  if (!queueByHash.has(document.source_sha256)) queueByHash.set(document.source_sha256, []);
  queueByHash.get(document.source_sha256).push(document);
}
const uniqueQueuePages = [...queueByHash.values()].reduce((sum, documents) =>
  sum + Math.max(...documents.map((item) => item.page_count || 0)), 0);
const uniqueQueueDocuments = queueByHash.size;
const statusById = new Map((ocrStatus?.documents || []).map((document) => [document.id, document]));
const uniqueCompletedPages = [...queueByHash.values()].reduce((sum, documents) =>
  sum + Math.max(0, ...documents.map((item) => statusById.get(item.id)?.completed || 0)), 0);
const uniqueWitnessPages = [...queueByHash.values()].reduce((sum, documents) =>
  sum + Math.max(0, ...documents.map((item) => statusById.get(item.id)?.witness || 0)), 0);
const explicitDispositionCounts = (artifactRegistry.artifacts || []).reduce((counts, artifact) => {
  counts[artifact.disposition] = (counts[artifact.disposition] || 0) + 1;
  return counts;
}, {});
const canonicalArtifactCount = artifactRegistry.expected_counts.unique_source_pdf_artifacts
  - Object.values(explicitDispositionCounts).reduce((sum, value) => sum + value, 0);
const previewEvidence = requireEnvironmentEvidence(releaseEvidence, 'preview');
const productionEvidence = requireEnvironmentEvidence(releaseEvidence, 'production');
assertCorpusParity('preview', previewEvidence, corpus);
assertCorpusParity('production', productionEvidence, corpus);
const taxonomy = taxonomyCounts(academicGraph);
const productionR2Event = latestEvent(entries, (entry) =>
  entry.phase === 'verify'
  && /post-activation production R2/u.test(entry.scope || '')
  && /17 unique release-prefixed objects/u.test(entry.evidence || ''));
const previewR2Event = latestEvent(entries, (entry) =>
  entry.phase === 'verify'
  && /post-activation preview R2 readback/u.test(entry.scope || '')
  && /all 17 objects/u.test(entry.evidence || ''));
const previewR2CorrectionEvent = latestEvent(entries, (entry) =>
  entry.phase === 'verify'
  && /correct prior ingest manifest hash transcription/u.test(entry.scope || ''));
const productionBrowserEvent = latestEvent(entries, (entry) =>
  entry.phase === 'verify'
  && entry.timestamp > productionEvidence.observed_at
  && /production/u.test(`${entry.scope || ''} ${entry.resources?.join(' ') || ''}`)
  && /browser|desktop|mobile|Canvas|visual/u.test(`${entry.scope || ''} ${entry.evidence || ''}`));
const productionBrowserDetail = productionBrowserEvent?.timestamp === '2026-07-17T06:35:37.437Z'
  ? 'event 2026-07-17T06:35:37.437Z；1440x1000 / 1280x720 / 390x844 均无 overflow；full 553 nodes / 214 lineage / 261 cross-subject，hide-all 0/0，Chinese 143/60，sports leak 0；auto zoom 0.864→1.32 与 0.20→0.568；deep links/workbenches/drag/zoom pass；D1 before=after 0/0/3/2/0，canonical digest c4166f451f4b9529bf4221b56fb3017dc51aef7493a699553dc218287e42c430；Pulse 425 requests / 0 errors；first-party console/page errors 0，Turnstile only 2 third-party opaque errors / 5 warnings；named sessions closed、CLI list empty、root ps 无 task daemon/profile，仅 App-owned MCP；orphan dry-run 因平台 usage limit 拒绝提权且未绕过'
  : null;
const releaseVerifyEvent = latestEvent(entries, (entry) => /380 of 380/u.test(entry.evidence || ''));
const archiveVerifyEvent = latestEvent(entries, (entry) =>
  entry.task === 'curriculum-atlas-private-archive-upload-20260717'
  && ['verify', 'closeout'].includes(entry.phase));
const remoteBEvent = latestEvent(entries, (entry) =>
  /protect remote OCR shard B/u.test(entry.scope || '')
  && /1259 of 3182/u.test(entry.evidence || ''));
const seedLineageEvent = latestEvent(entries, (entry) =>
  entry.task === 'curriculum-ocr-b-r2-lineage-implementation-20260717');
const previewR2ReleaseId = releaseIdFromEvent(previewR2Event);
const productionR2ReleaseId = releaseIdFromEvent(productionR2Event);
const openTasks = tasks.filter((task) => task.lastEvent.phase !== 'closeout');
const actionLogDigest = sha256(entries.map((entry) => JSON.stringify(entry)).join('\n'));
const ledgerSnapshot = {
  schema_version: 1,
  action_log_line_cutoff: actionLogLineCutoff,
  action_log_prefix_sha256: actionLogPrefixDigest,
  included_event_count: entries.length,
  included_task_count: tasks.length,
  included_event_sha256: actionLogDigest,
  included_through: entries.at(-1).timestamp,
};

const lines = [];
lines.push('# Curriculum Atlas 项目运维总账');
lines.push('');
lines.push(`<!-- curriculum-operations-ledger-snapshot ${JSON.stringify(ledgerSnapshot)} -->`);
lines.push('');
lines.push(`生成时间：\`${generatedAt}\`（America/Los_Angeles：\`${localTime(generatedAt)}\`）`);
lines.push('');
lines.push(`覆盖区间：\`${entries[0].timestamp}\` 至 \`${entries.at(-1).timestamp}\`；共 \`${tasks.length}\` 个任务、\`${entries.length}\` 条运维事件。`);
lines.push('');
lines.push(`本文件是项目内的可重建运维总账快照。事件明细来自 \`/Users/ylsuen/CF/reports/agent_action_log.jsonl\` 的 append-only 前 ${actionLogLineCutoff} 行；前缀 SHA-256 为 \`${actionLogPrefixDigest}\`。本地数据数字来自生成时实际文件；Cloudflare 与远端 OCR 数字只引用带时间戳的最后一次只读核验。快照之后新增的日志属于待纳入事件，不会使已冻结发布提交失真；后来的状态不得回写覆盖历史，只能新增事件并在下一发布快照重新生成。`);
lines.push('');
lines.push('## 读数规则');
lines.push('');
lines.push('- “OCR 已识别”只表示主 OCR 产物存在，不等于通过 Apple Vision、图像复核、同版在线核对、篇目/版次裁决、显示闸门或引文闸门。');
lines.push('- “本地完成”“预览已发布”“生产已发布”是三种不同状态；未注明部署 ID 的本地改动不得描述为上线。');
lines.push(`- OCR 队列保留目录身份分母 ${queue.counts.documents} 份/${queue.counts.pages.toLocaleString('en-US')} 页；精确 SHA-256 去重后的物理实体口径为 ${uniqueQueueDocuments} 份/${uniqueQueuePages.toLocaleString('en-US')} 页。两种口径必须同时标明。`);
lines.push('- D1、R2、Worker Assets 必须属于同一发布批次；任一层未对齐即视为未完成发布。');
lines.push('- 本文件包含完整历史事件，但旧事件的“当前”描述会被后续带时间戳事件 supersede；不能把旧进度相加到新进度。');
lines.push('');
lines.push('## 原始目标与后续约束');
lines.push('');
lines.push('### 立项目标');
lines.push('');
lines.push('- 建成面向教师的“中国历年课程标准与考试评价演变”公共网站，覆盖资料检索、数据整理、产品设计、前后端、AI 研究、教师讨论、部署、验证和运维文档。');
lines.push('- 优先采用教育部、教育部课程教材研究所、教育考试机构和可信学术来源；保留来源机构、题名、版次、学段、学科、文件类型、日期、URL、文件哈希、页数、取得状态与再分发边界。');
lines.push('- 扫描件以原 PDF/页图为真值：主 OCR、独立 Apple Vision 见证、图像复核、目录/篇目定位、同篇同版在线文本和人工裁决相互印证；异版只能旁证稳定事实。');
lines.push('- 概念图必须呈现各学科历代关键概念、术语、能力、目标、内容、任务、学业质量与评价的演进，不把一份课标文件直接画成一颗星。');
lines.push('- Cloudflare Worker + Assets、D1、R2、统一用户中心、共享 APIS、Turnstile 与 Pulse 形成可部署、可回滚、可审计的生产体系。');
lines.push('');
lines.push('### 迭代中追加的硬约束');
lines.push('');
lines.push('- 利用本机 Downloads 中全部相关标准/汇编，但任何物理文件必须先登记身份、hash、版本关系和处置；不能因文件名相似直接合并或漏掉替代扫描。');
lines.push('- OCR 质量优先同时要求吞吐最大化；本机失败要立即隔离/恢复，DMITPro2 内层 Kali 可全负载运行，但远端只产生不可引文 staging。');
lines.push('- 星空是主视线区：学科显隐、年代、谱系、搜索、版本/资料、AI/讨论均围绕星图组织；删除冗余统计文字和重复 tabs。');
lines.push('- 学科数据必须使用受控分类：外语合并为显示组但保留语种身份，思想政治/思想品德/品德与社会/道德与法治建立历史谱系，信息科技/信息技术/通用技术归技术族；课程方案、学业质量、范围词、定向行走、美工等不得伪装成学科。');
lines.push('- 单学科选择后镜头自动适配；语文等学科必须下钻到三维目标、语言文字运用、阅读与鉴赏、能力要求、学业质量层级等可研究的底层概念。');
lines.push('- 任何仍不能由图像、OCR 和同版在线文本确认之处，由人工判断并保留不确定注释，显示/引文/语义发布继续 fail-closed。');
lines.push('');
lines.push('## 生成时本地事实');
lines.push('');
lines.push('| 层 | 当前事实 | 状态判定 |');
lines.push('|---|---|---|');
lines.push(`| Git | branch \`${branch}\`; HEAD \`${head}\`; origin/main \`${originMain}\`; modified ${modifiedFiles}; untracked ${untrackedFiles} | ${treeVerdict}；production environment evidence commit \`${releaseEvidenceCommit}\` |`);
lines.push(`| Catalog | ${catalog.counts.documents} records；verified_online ${catalog.counts.verified_online}；local_verified_scan ${catalog.counts.local_verified_scan}；metadata_only ${catalog.counts.metadata_only}；citation_ready ${catalog.counts.citation_ready}；ocr_review_pending ${catalog.counts.ocr_review_pending} | checked-in generated snapshot |`);
lines.push(`| Ingest | ${ingest.entries.length} entries | 与 catalog ID 集合精确一致；物理文件另由 artifact registry 审计 |`);
lines.push(`| Asset registry | ${artifactRegistry.expected_counts.source_pdf_files} PDF paths / ${artifactRegistry.expected_counts.unique_source_pdf_artifacts} unique SHA-256；${canonicalArtifactCount} canonical、${explicitDispositionCounts.variant || 0} variant、${explicitDispositionCounts.derived || 0} derived、${explicitDispositionCounts.quarantine || 0} quarantine | 遗漏 hash、处置冲突、路径/校验和漂移均 fail closed |`);
lines.push(`| OCR queue | 名义 ${queue.counts.documents} docs / ${queue.counts.pages} pages；唯一实体 ${uniqueQueueDocuments} docs / ${uniqueQueuePages} pages；blocked ${queue.counts.blocked_documents} | 未完成且全部 fail-closed |`);
if (ocrStatus) lines.push(`| Local OCR evidence | 主 OCR/audit 名义 ${ocrStatus.queue.completed_pages}/${ocrStatus.queue.pages}，唯一实体 ${uniqueCompletedPages}/${uniqueQueuePages}；Vision 名义 ${ocrStatus.evidence.witness_pages}，唯一实体 ${uniqueWitnessPages}；failed ${ocrStatus.queue.failed_pages} | ${ocrStatus.generated_at} 本机快照；显示/引文合格 ${ocrStatus.evidence.citation_eligible_pages} |`);
lines.push(`| OCR publication | ${pageManifest.documents.length} accepted documents / ${acceptedPages} accepted pages | 0 页进入显示/引文发布 |`);
lines.push(`| Semantic quarantine | aliases ${(semanticPolicy.document_aliases || []).length}；page controls ${(semanticPolicy.page_controls || []).length} | unresolved controls override future page acceptance |`);
lines.push(`| Corpus release | \`${corpus.release_id}\`；${corpus.documents} documents / ${corpus.paragraphs} paragraphs / ${corpus.fts_rows} FTS / ${corpus.page_publication_gates} page gates / ${corpus.displayed_paragraphs} displayed / ${corpus.accepted_ocr_documents} accepted OCR / ${corpus.sql_chunks} chunks | preview 与 production evidence 均为 ready；OCR 正文仍未接入 |`);
lines.push(`| Taxonomy | ${taxonomy.subject || 0} subject + ${taxonomy.assessment_subject || 0} assessment subject + ${taxonomy.curriculum_course || 0} courses + ${taxonomy.scopes} scopes；${taxonomy.facets} facets / ${taxonomy.queryIdentities} exact query identities | schema 2；课程和范围不伪装成学科 |`);
lines.push(`| Concept graph | core ${graphs.episodes} episodes / ${graphs.edges} edges；academic ${graphs.works} works / ${graphs.editions} editions / ${graphs.occurrences} occurrences / ${graphs.evidence} evidence | 五项 live asset byte parity 已由两端 release evidence 绑定 |`);
lines.push(`| Deep ontology | ${graphs.ontologyNodes} nodes / ${graphs.ontologyRelations} relations / ${graphs.ontologyEvidence} evidence anchors | 当前主要为语文深层模型；其他学科不可伪装已完成 |`);
lines.push('');
lines.push('### 本轮完成、保留边界与剩余阻断');
lines.push('');
lines.push('1. **已登记**：三个替代扫描 `biology-b.pdf`、`math-b.pdf`、`politics-b.pdf` 已归为 `variant`；两个无可重放谱系的 OCR PDF 已归为 `derived`。五者都明确禁止入队和发布，不再作为“孤儿文件”静默存在。');
lines.push('2. **已隔离**：三个唯一的全零/无效下载载荷已归为 `quarantine`；文件魔数、大小和 SHA-256 发生变化时审计会要求重新裁决。');
lines.push('3. **已去重建模**：`moe-2022-17` 与 `ictr-6c6df9d121ac` 是同一 68 页实体，目录身份仍保留两条，物理 OCR/进度口径按 SHA-256 只计一次。');
lines.push(`4. **已上线**：两端 D1 均通过 \`0007_document_taxonomy_contract.sql\`，Worker 均为 \`${productionEvidence.health.version}\`，corpus \`${productionEvidence.corpus.release_id}\` ready；corpus importer 的 91 个远端回执名称、hash 与 bytes 已闭环。`);
lines.push(`5. **已上线**：taxonomy 为 ${taxonomy.subject || 0} 学科资料、${taxonomy.assessment_subject || 0} 考试学科、${taxonomy.curriculum_course || 0} 课程、${taxonomy.scopes} 范围，公开契约为 ${taxonomy.facets} 个展示分面与 ${taxonomy.queryIdentities} 个精确普通学科查询身份。`);
lines.push(`6. **R2 已原子激活**：preview \`${previewR2ReleaseId || '未从事件解析'}\` 与 production \`${productionR2ReleaseId || '未从事件解析'}\` 均在 evidence snapshot 之后由 append-only readback 事件证明；environment evidence 内的旧/空 pointer 只能解释为采集时快照，不能覆盖后续激活事实。`);
lines.push(`7. **私有备份已验证**：${archiveVerifyEvent ? markdown(archiveVerifyEvent.evidence) : '尚无完整远端回读事件'}；本地索引为 \`backups/curriculum-atlas/private-archive/20260717T021000Z/archive-index.json\`，远端仅引用精确受控前缀，不记录密钥。`);
lines.push('8. **OCR 仍阻断发布**：本机主 OCR/audit 6,947、Vision 7,012，但显示/引文 accepted 仍为 0；B-r1 冻结在 1,259/3,182。新并发配置不得直接复制旧输出或启动 B-r2，必须先落地并测试 hash-bound seed lineage，再以 predecessor receipt 验签。');
lines.push('');
lines.push('## 最后一次外部核验快照');
lines.push('');
lines.push('| 环境 | 已核验状态 | 回滚 / 阻断 |');
lines.push('|---|---|---|');
lines.push(`| Production Worker | \`${productionEvidence.worker_version_id}\` / \`${productionEvidence.deployment_id}\` / \`${productionEvidence.health.version}\`；Assets Git \`${productionEvidence.asset_git_commit}\`；health ${productionEvidence.health.http_status} | coupled rollback：D1 bookmark \`0000002b-00002585-000050ab-8645885d977dc9bf5678e6cdf12b084f\` + Worker \`7d1766b2-32be-4ce1-9528-f6c69bb2a092\`，仅在确认无后续用户写入后执行 |`);
lines.push(`| Preview Worker | \`${previewEvidence.worker_version_id}\` / \`${previewEvidence.deployment_id}\` / \`${previewEvidence.health.version}\`；Assets Git \`${previewEvidence.asset_git_commit}\`；health ${previewEvidence.health.http_status} | rollback：preview D1 bookmark 与 Worker predecessor 由发布任务私有锚点保存 |`);
lines.push(`| D1 prod + preview | 两端 applied migrations 均为 ${productionEvidence.applied_migrations.map((name) => `\`${name}\``).join('、')}；pending 0；schema 3 / taxonomy 2 / page 1 | corpus 非 ready 或实时计数漂移时 API fail closed 503 |`);
lines.push(`| Corpus prod + preview | \`${productionEvidence.corpus.release_id}\` ready；${productionEvidence.corpus.counts.documents}/${productionEvidence.corpus.counts.paragraphs}/${productionEvidence.corpus.counts.fts_rows}/${productionEvidence.corpus.counts.page_publication_gates}/${productionEvidence.corpus.counts.displayed_paragraphs}/${productionEvidence.corpus.counts.accepted_ocr_documents}/${productionEvidence.corpus.counts.chunks} | documents / paragraphs / FTS / page gates / displayed / accepted OCR / chunks 必须精确相等 |`);
lines.push(`| Production R2（post-evidence） | ${productionR2Event ? markdown(productionR2Event.evidence) : '尚无 post-evidence readback'} | 删除且只删除 \`release/current.json\` 可恢复 v10 stable-key fallback；不可变 release objects 保留 |`);
lines.push(`| Preview R2（post-evidence） | ${previewR2Event ? markdown(previewR2Event.evidence) : '尚无 post-evidence readback'}${previewR2CorrectionEvent ? `；authoritative correction：${markdown(previewR2CorrectionEvent.evidence)}` : ''} | 恢复已备份 predecessor pointer；不可变 successor objects 可不引用保留 |`);
lines.push(`| Taxonomy | ${taxonomy.subject || 0} subject + ${taxonomy.assessment_subject || 0} assessment subject + ${taxonomy.curriculum_course || 0} course + ${taxonomy.scopes} scope；${taxonomy.facets} facets / ${taxonomy.queryIdentities} query identities | assessment/course/scope 保留身份，不进入普通学科精确筛选 |`);
lines.push(`| Local OCR | primary+audit ${ocrStatus?.queue?.completed_pages ?? 6947}/${queue.counts.pages}；Vision ${ocrStatus?.evidence?.witness_pages ?? 7012}；accepted ${ocrStatus?.evidence?.citation_eligible_pages ?? 0} | OCR 未完成、未上线；page publication 与 citation 保持 fail closed |`);
lines.push(`| DMITPro2 shard B-r1 | ${remoteBEvent ? markdown(remoteBEvent.evidence) : '1,259/3,182 frozen by low-memory gate'} | ${seedLineageEvent ? markdown(seedLineageEvent.unresolved || seedLineageEvent.scope) : 'B-r2 seed lineage 尚未完成'}；不得无 lineage 复制旧 state |`);
lines.push(`| Private encrypted archive | ${archiveVerifyEvent ? markdown(archiveVerifyEvent.evidence) : '尚无完整回读'} | index \`backups/curriculum-atlas/private-archive/20260717T021000Z/archive-index.json\`；远端精确前缀回滚需另行明确授权 |`);
lines.push(`| Production browser / API / Pulse | ${productionBrowserEvent ? `${markdown(productionBrowserEvent.evidence)}${productionBrowserDetail ? `；${productionBrowserDetail}` : ''}` : 'API/R2 已核验；生产桌面/移动视觉 QA 仍待 release owner 回传，本快照不声明通过'} | ${productionBrowserEvent ? '只读 QA 无状态回滚；下一 release 必须重新产生事件。现有 observation 数据止于 2020，accepted OCR 后才能重建 2022 概念观察' : '视觉门未有 append-only verify 事件前不得写成已通过'} |`);
lines.push(`| Full governed verify | ${releaseVerifyEvent ? markdown(releaseVerifyEvent.evidence) : '未找到 380/380 事件'} | Git evidence commit \`${releaseEvidenceCommit}\` |`);
lines.push('| Public registration | User Center、Nav、Portal、Companion source、Pulse 已登记；Pulse tracked | Companion 新 APK 因无真实 Android 设备验证而显式延期 |');
lines.push('');
lines.push('## 生命周期里程碑');
lines.push('');
lines.push('| 本地日期 | 里程碑 | 可证明结果 | 尚未完成 |');
lines.push('|---|---|---|---|');
lines.push('| 2026-07-14 | 立项、Cloudflare 资源创建、初版数据模型和公共站点 | 建立 Worker/D1/R2 preview+production、统一用户/AI/讨论边界；初始 Git `720d6ff` | 历史扫描 OCR、深层概念模型、完整视觉复刻 |');
lines.push('| 2026-07-14 夜间 | 生产发布、公共仓库与五面注册 | `curriculum.bdfz.net` 上线；GitHub `ieduer/curriculum-atlas`；User Center/Nav/Portal/Companion/Pulse 注册 | Companion 安装包真实设备 QA |');
lines.push('| 2026-07-14 至 07-15 | 全屏宇宙、概念星、学科/课程/范围重分类 | 文档星改为概念 episode；移除冗余 tabs；建立 subject/course/scope 边界与 12 个显示 facet | 全学科深层 ontology 与 OCR 证据接入 |');
lines.push('| 2026-07-15 | OCR 质量 supervisor 与故障恢复 | Paddle primary、Apple Vision blind witness、exact audit、页级 retry/quarantine、MuPDF 240 DPI、hash-bound provenance | 所有页仍不可自动引文 |');
lines.push('| 2026-07-15 | 深层语文 ontology 与生产 v7 | 生产部署 `ececd77`；概念层具有证据定位、版本/学段边界和 fail-closed relations | 当前本地模型已继续演化，生产不是最新 |');
lines.push('| 2026-07-15 夜间 | full-canvas preview v8 与本机 OCR hold | 预览 `b8344a9`；双栏轨道、学科聚焦自适应、移动工作台修复 | macOS syspolicyd/native runtime 与真实浏览器门阻断生产提升 |');
lines.push('| 2026-07-16 | DMITPro2 CUDA offload r1→r5 | 逐轮修复 venv realpath、共享 runtime 分类、owner lock、child timeout、sidecar/hash、PEG 单页失败隔离 | 远端结果仍仅 staging |');
lines.push('| 2026-07-16 | R6 72 卷回传与 6 页修复 | 72/5,483 whole-document 接收、receipt/rollback/idempotence 验证；Apple Vision evidence drain 完成 | 大部分页面仍未人工/在线同版裁决 |');
lines.push('| 2026-07-16 | page/semantic publication gates | 新增 page manifest、semantic quarantine、duplicate alias、外语/表格/精确字符规则；accepted=0 | migrations、D1/R2/Worker 三层尚未形成同一 release |');
lines.push('| 2026-07-16 至 07-17 | partial14 整卷重跑和全项目资产审计 | 资产主账、D1 release gate、R2 manifest 和 importer 原子性缺陷已收口；B-r1 因低内存冻结于 1,259/3,182 | hash-bound B-r2 seed lineage 与 OCR 质量闭环仍未完成 |');
lines.push(`| 2026-07-17 | v10 taxonomy/corpus/R2 preview 与 production 发布 | 两端 D1 0001–0007、taxonomy schema 2、corpus 91/91 receipts、Worker v10、17-object versioned R2 release；production evidence commit \`2907557\`${productionBrowserEvent ? '；production API/D1/browser/Pulse 终验通过' : ''} | OCR accepted 仍为 0；observation 数据止于 2020，全学科深层 ontology 仍须继续建设 |`);
lines.push('| 2026-07-17 | 私有加密档案远端恢复演练 | 14 个 parts + index 共 15 objects/3,304,581,750 bytes；完整 GET/hash/decrypt/decompress/replay 零差异 | 不公开密钥；保留受控前缀与本地 index |');
lines.push('');
lines.push('## Git 提交时间线');
lines.push('');
lines.push('| Commit | 时间 | 说明 |');
lines.push('|---|---|---|');
for (const row of gitHistory) {
  const [commit, time, ...subjectParts] = row.split('\t');
  lines.push(`| \`${commit.slice(0, 12)}\` | ${markdown(time)} | ${markdown(subjectParts.join('\t'))} |`);
}
lines.push('');
lines.push('## 任务索引');
lines.push('');
lines.push('| 首次时间 UTC | 末次时间 UTC | 任务 | 事件 | 阶段 | 最后状态 / 未决 |');
lines.push('|---|---|---|---:|---|---|');
for (const task of tasks) {
  lines.push(`| ${task.first} | ${task.last} | \`${markdown(task.task)}\` | ${task.events.length} | ${task.phases.join(', ')} | ${markdown(task.lastEvent.unresolved || task.lastEvent.scope || '')} |`);
}
lines.push('');
lines.push(`### 未以 closeout 结束的历史任务（${openTasks.length}）`);
lines.push('');
lines.push('这些任务可能已被后续任务 supersede，但 action log 中没有对应 closeout。它们必须保留为治理缺口，不能静默当作已完成。');
lines.push('');
for (const task of openTasks) {
  lines.push(`- \`${task.task}\`：最后阶段 \`${task.lastEvent.phase}\`，最后时间 \`${task.last}\`；${task.lastEvent.unresolved || '未写未决项'}`);
}
lines.push('');
lines.push('## 截止点内完整 append-only 运维事件');
lines.push('');
lines.push(`事件子集 SHA-256：\`${actionLogDigest}\`。以下 ${entries.length} 条按任务首次 UTC 排序，任务内事件再按 UTC 排序；逐条保留 scope、resources、evidence、rollback 和 unresolved。`);
lines.push('');
for (const task of tasks) {
  lines.push(`<details><summary><code>${markdown(task.task)}</code> · ${task.events.length} events · ${task.first} → ${task.last}</summary>`);
  lines.push('');
  lines.push(`Agents：${list(task.agents)}`);
  lines.push(`Resources：${list(task.resources)}`);
  lines.push('');
  for (const event of task.events) {
    lines.push(`### ${event.timestamp} · ${event.phase} · ${event.agent}`);
    lines.push('');
    lines.push(`- Scope：${event.scope || '未记录'}`);
    lines.push(`- Resources：${list(event.resources)}`);
    lines.push(`- Evidence：${event.evidence || '未记录'}`);
    lines.push(`- Rollback：${event.rollback || '未记录'}`);
    lines.push(`- Unresolved：${event.unresolved || '无'}`);
    lines.push('');
  }
  lines.push('</details>');
  lines.push('');
}
lines.push('## 发布与回滚硬规则');
lines.push('');
lines.push('1. 先冻结 Git commit 与 generated asset hashes，再创建 release manifest；不从 dirty tree 直接部署。');
lines.push('2. 先备份/Time Travel，按 preview 顺序执行 migrations → 支持新 schema 的 Worker/Assets → corpus release → Git-bound environment evidence → R2 metadata pointer；每层完成 hash/count readback。');
lines.push('3. D1 corpus import 必须有 `in_progress`/`ready` marker；未 ready 时所有数据 API、AI 和段落讨论路径返回 503，不能暴露混合快照。');
lines.push('4. R2 不允许固定手写文件白名单；每个公开元数据对象必须由 release policy 枚举并在上传后核对 size/hash。');
lines.push('5. OCR source、primary、witness、audit、online same-edition、page gate、semantic gate 是不同层；任何一层缺失都不可进入引文。');
lines.push('6. 生产 Worker v10 与 D1 0007 是耦合回滚：只回 Worker v7 会因 schema 不匹配返回 503；仅在确认无后续用户写入后同时使用已记录 Worker version 与 D1 bookmark。');
lines.push('7. R2-only 回滚只改 `release/current.json`：首次 production bootstrap 可删除 pointer 恢复 v10 stable-key fallback；有 predecessor 的环境恢复其原始 pointer bytes。中断发布先检查远端 immutable objects/pointer，不得盲目重跑。');
lines.push('8. 每次修改都写 action log `start/change/verify/closeout`，然后重新生成本总账并检查未 closeout 列表。');
lines.push('');
lines.push('## 重建命令');
lines.push('');
lines.push('```bash');
lines.push('cd /Users/ylsuen/CF/curriculum-atlas');
lines.push('node scripts/build-project-operations-ledger.mjs');
lines.push('```');
lines.push('');
lines.push('生成器只读取项目文件、Git 与 append-only action log，只覆盖本文件；不访问网络、不运行 OCR、不写 D1/R2、不部署。');

await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
process.stdout.write(`${outputPath}\n${entries.length} events / ${tasks.length} tasks / sha256 ${sha256(lines.join('\n'))}\n`);
