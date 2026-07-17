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
  releasePolicy,
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
  readOptionalJson('data/release-assets-policy.json'),
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
const statusLines = git('status', '--short').split(/\r?\n/u).filter(Boolean);
const modifiedFiles = statusLines.filter((line) => !line.startsWith('??')).length;
const untrackedFiles = statusLines.filter((line) => line.startsWith('??')).length;
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
const remoteAppliedMigrations = releasePolicy?.environment_snapshot?.production?.applied_migrations || [];
const pendingRemoteMigrations = ['0005_page_publication_gate.sql', '0006_corpus_import_release.sql']
  .filter((name) => !remoteAppliedMigrations.includes(name));
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
lines.push(`| Git | branch \`${branch}\`; HEAD \`${head}\`; origin/main \`${originMain}\`; modified ${modifiedFiles}; untracked ${untrackedFiles} | HEAD ahead/dirty；未形成可部署单一提交 |`);
lines.push(`| Catalog | ${catalog.counts.documents} records；verified_online ${catalog.counts.verified_online}；local_verified_scan ${catalog.counts.local_verified_scan}；metadata_only ${catalog.counts.metadata_only}；citation_ready ${catalog.counts.citation_ready}；ocr_review_pending ${catalog.counts.ocr_review_pending} | checked-in generated snapshot |`);
lines.push(`| Ingest | ${ingest.entries.length} entries | 与 catalog ID 集合精确一致；物理文件另由 artifact registry 审计 |`);
lines.push(`| Asset registry | ${artifactRegistry.expected_counts.source_pdf_files} PDF paths / ${artifactRegistry.expected_counts.unique_source_pdf_artifacts} unique SHA-256；${canonicalArtifactCount} canonical、${explicitDispositionCounts.variant || 0} variant、${explicitDispositionCounts.derived || 0} derived、${explicitDispositionCounts.quarantine || 0} quarantine | 遗漏 hash、处置冲突、路径/校验和漂移均 fail closed |`);
lines.push(`| OCR queue | 名义 ${queue.counts.documents} docs / ${queue.counts.pages} pages；唯一实体 ${uniqueQueueDocuments} docs / ${uniqueQueuePages} pages；blocked ${queue.counts.blocked_documents} | 未完成且全部 fail-closed |`);
if (ocrStatus) lines.push(`| Local OCR evidence | 主 OCR/audit 名义 ${ocrStatus.queue.completed_pages}/${ocrStatus.queue.pages}，唯一实体 ${uniqueCompletedPages}/${uniqueQueuePages}；Vision 名义 ${ocrStatus.evidence.witness_pages}，唯一实体 ${uniqueWitnessPages}；failed ${ocrStatus.queue.failed_pages} | ${ocrStatus.generated_at} 本机快照；显示/引文合格 ${ocrStatus.evidence.citation_eligible_pages} |`);
lines.push(`| OCR publication | ${pageManifest.documents.length} accepted documents / ${acceptedPages} accepted pages | 0 页进入显示/引文发布 |`);
lines.push(`| Semantic quarantine | aliases ${(semanticPolicy.document_aliases || []).length}；page controls ${(semanticPolicy.page_controls || []).length} | unresolved controls override future page acceptance |`);
lines.push(`| Corpus chunks | ${corpus.documents} documents / ${corpus.paragraphs} paragraphs / ${corpus.sql_chunks} SQL chunks；accepted OCR ${corpus.accepted_ocr_documents} | 当前只有官方原生文本；OCR 正文未接入 |`);
lines.push(`| Concept graph | core ${graphs.episodes} episodes / ${graphs.edges} edges；academic ${graphs.works} works / ${graphs.editions} editions / ${graphs.occurrences} occurrences / ${graphs.evidence} evidence | 本地生成物；需与部署 release manifest 对齐 |`);
lines.push(`| Deep ontology | ${graphs.ontologyNodes} nodes / ${graphs.ontologyRelations} relations / ${graphs.ontologyEvidence} evidence anchors | 当前主要为语文深层模型；其他学科不可伪装已完成 |`);
lines.push('');
lines.push('### 本轮发现、处置与剩余阻断');
lines.push('');
lines.push('1. **已登记**：三个替代扫描 `biology-b.pdf`、`math-b.pdf`、`politics-b.pdf` 已归为 `variant`；两个无可重放谱系的 OCR PDF 已归为 `derived`。五者都明确禁止入队和发布，不再作为“孤儿文件”静默存在。');
lines.push('2. **已隔离**：三个唯一的全零/无效下载载荷已归为 `quarantine`；文件魔数、大小和 SHA-256 发生变化时审计会要求重新裁决。');
lines.push('3. **已去重建模**：`moe-2022-17` 与 `ictr-6c6df9d121ac` 是同一 68 页实体，目录身份仍保留两条，物理 OCR/进度口径按 SHA-256 只计一次。');
lines.push(`4. **本地已纠偏、远端未部署**：catalog-only 两条记录已显式 \`metadata_only / citation_allowed=false\`，当前文档级引文闸门为 ${catalog.counts.citation_ready}，不再由文件格式猜测。`);
lines.push('5. **本地已加固、远端未部署**：corpus builder/importer 采用确定性 release ID、输入与 SQL chunk hash、逐块 receipt、`in_progress/ready/failed` 状态及最终行数/FTS/page-gate 校验；D1 API 在非 ready 状态返回 503。');
lines.push('6. **仍阻断发布**：生产与预览 D1 仍停在 `0004`；本地新增 `0005_page_publication_gate.sql` 与 `0006_corpus_import_release.sql`，任何 v9 发布前必须先做 preview Time Travel 与迁移/导入演练。');
lines.push('7. **仍阻断发布**：生产与预览 R2 仍是旧清单（50 卷/8,690 页）；本地已改为完整 policy、不可变 versioned objects 与最后切换 current pointer，但远端 Worker 仍读旧稳定 key。');
lines.push('8. **仍阻断上线声称**：OCR 本机已有大量主结果/见证，但 page publication manifest 仍为 0；未通过图像、同版在线核对和人工裁决的页面不能进入 corpus、概念关系或引文。');
lines.push('');
lines.push('## 最后一次外部核验快照');
lines.push('');
lines.push('| 环境 | 已核验状态 | 回滚 / 阻断 |');
lines.push('|---|---|---|');
lines.push('| Production Worker | `7d1766b2-32be-4ce1-9528-f6c69bb2a092` / `2026.07.15-v7`；Assets 与 Git `ececd77` 对应 | rollback `b91d1d29-6f10-49a3-ab40-e4f84af76256`；不是本地 v9 |');
lines.push('| Preview Worker | `2459045b-9337-477e-af09-571bcd91dcab` / `2026.07.15-v8`；Assets 与 Git `b8344a9` 对应 | rollback `55cf188f-b794-4ec5-ab8d-b25ab39f8351`；缺真实浏览器视觉门 |');
lines.push(`| D1 prod + preview | 各 196 documents / 16,456 paragraphs / 103 document gates / 1 verification；migration \`0004\` | pending：${pendingRemoteMigrations.map((name) => `\`${name}\``).join('、') || '需重新只读确认'}；远端仍是旧快照 |`);
lines.push('| R2 prod + preview | 两端一致但均是旧 catalog/queue；ingest 与本地相同 | 必须由 release manifest 驱动逐对象 hash/size readback |');
lines.push(`| Local OCR R6 receive | 72 documents / 5,483 pages 已经 whole-document 验签并原子接收；本地 primary+audit 名义 ${ocrStatus?.queue?.completed_pages ?? 6947}/${queue.counts.pages}，Vision 名义 ${ocrStatus?.evidence?.witness_pages ?? 7012} | quality review unresolved ${ocrStatus?.evidence?.gates?.unresolved_fail_closed ?? 6091}；citation/display accepted ${ocrStatus?.evidence?.citation_eligible_pages ?? 0} |`);
lines.push('| DMITPro2 partial14 | `2026-07-17T00:03:14Z`：A 1,118 + B 699 = 1,817/6,364，failed/quarantined 0；双 shard 与 llama 0 restart | 仍是隔离 staging；热/内存 guard 自动降载；不得与已接收 5,483 页相加为队列完成 |');
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
lines.push('| 2026-07-16 至当前 | partial14 整卷重跑和全项目资产审计 | 14 卷/6,364 页在隔离 A/B shards；发现 5 份有效孤儿、R2/D1/Assets 漂移与 importer 原子性缺陷 | 先完成资产主账、D1 release gate、R2 release manifest，再决定部署 |');
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
lines.push('2. 先备份/Time Travel，按 preview 顺序执行 migrations → corpus release → R2 metadata → Worker/Assets；每层完成 hash/count readback。');
lines.push('3. D1 corpus import 必须有 `in_progress`/`ready` marker；未 ready 时所有数据 API、AI 和段落讨论路径返回 503，不能暴露混合快照。');
lines.push('4. R2 不允许固定手写文件白名单；每个公开元数据对象必须由 release policy 枚举并在上传后核对 size/hash。');
lines.push('5. OCR source、primary、witness、audit、online same-edition、page gate、semantic gate 是不同层；任何一层缺失都不可进入引文。');
lines.push('6. 生产回滚必须同时记录 Worker version、D1 Time Travel、R2 object set 与 public registration impact；不能只回 Worker。');
lines.push('7. 每次修改都写 action log `start/change/verify/closeout`，然后重新生成本总账并检查未 closeout 列表。');
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
