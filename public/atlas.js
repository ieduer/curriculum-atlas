const TAU = Math.PI * 2;
const MIN_ZOOM = .2;
const MAX_ZOOM = 2.3;
const DEFAULT_CAMERA = Object.freeze({ yaw: -.12, pitch: -.11, zoom: 1, panX: 0, panY: 0 });
const CORE_COLORS = {
  '语文': '#ff828b', '数学': '#67dcff', '外语': '#b99bff',
  '思想政治与道德法治': '#ff8fc4', '历史': '#f2a467', '历史与社会': '#e8bb72',
  '地理': '#71beff', '科学类': '#69e3c4', '技术': '#7bcfff',
  '劳动': '#e9bd72', '艺术': '#e8a4ff', '体育与健康': '#96e78c',
};

const FALLBACK_COLORS = ['#79d6ff', '#d990ff', '#78e0b0', '#ff9a80', '#e9c768', '#98a8ff', '#7ae4e5'];
const ERA_GATES = [
  { year: 1950, label: '国家课程起点' },
  { year: 1978, label: '恢复与重建' },
  { year: 2001, label: '课程标准转型' },
  { year: 2017, label: '核心素养' },
  { year: 2022, label: '素养导向重构' },
];

function hash(value) {
  let result = 2166136261;
  for (const char of String(value || '')) {
    result ^= char.codePointAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function randomFrom(seed) {
  let value = seed || 1;
  return () => {
    value = Math.imul(value ^ (value >>> 15), 1 | value);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function boxesOverlap(left, right) {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

export function subjectColor(subject) {
  return CORE_COLORS[subject] || FALLBACK_COLORS[hash(subject) % FALLBACK_COLORS.length];
}

const SHARED_STAR_EFFECTS = Object.freeze({
  coreOpacity: 1,
  haloOpacity: 1,
  pulseAmplitude: 1,
  spikeScale: 1,
  labelOpacity: 1,
});

export function starEffectProfile() {
  return { ...SHARED_STAR_EFFECTS, evidenceRing: 'none' };
}

export function starAutoLabelEligible(node) {
  return Number(node?.strength) >= .55;
}

export function selectedEvolutionNodeIds(nodes, selectedId) {
  const selected = nodes.find((node) => node.id === selectedId);
  if (!selected) return new Set();
  if (!selected.evolutionFamilyId) return new Set([selected.id]);
  return new Set(nodes
    .filter((node) => node.evolutionFamilyId === selected.evolutionFamilyId)
    .map((node) => node.id));
}

export function episodeSubjectFacet(episode) {
  const subject = episode?.subject;
  return ['subject', 'assessment_subject'].includes(subject?.entity_kind) && subject?.facet_eligible === true && typeof subject?.facet === 'string' && subject.facet.trim()
    ? subject.facet.trim()
    : null;
}

export function episodeVisibilityFacets(episode) {
  if (Array.isArray(episode?.visibility_facets)) return episode.visibility_facets.filter((facet) => typeof facet === 'string' && facet.trim());
  const direct = episodeSubjectFacet(episode);
  return direct ? [direct] : [];
}

export function episodeVisibleForSubjectFilter(episode, hiddenSubjects, hideAll, subjectFacets) {
  if (hideAll) return false;
  const controlled = Array.isArray(subjectFacets) ? subjectFacets : [];
  const hidden = hiddenSubjects instanceof Set ? hiddenSubjects : new Set(hiddenSubjects || []);
  if (hidden.size === 0) return true;
  const visible = new Set(controlled.filter((facet) => !hidden.has(facet)));
  return episodeVisibilityFacets(episode).some((facet) => visible.has(facet));
}

export function episodeCanonicalSubject(episode) {
  const subject = episode?.subject;
  return ['subject', 'assessment_subject'].includes(subject?.entity_kind) && subject?.facet_eligible === true && typeof subject?.canonical === 'string' && subject.canonical.trim()
    ? subject.canonical.trim()
    : null;
}

export function episodeCourseEntity(episode) {
  const course = episode?.course_entity || (episode?.scope_entity?.entity_kind === 'curriculum_course' ? episode.scope_entity : null);
  return course?.entity_kind === 'curriculum_course' ? course : null;
}

export function episodeColor(episode) {
  const subject = episodeSubjectFacet(episode);
  if (subject) return subjectColor(subject);
  const course = episodeCourseEntity(episode);
  const visibilityFacets = episodeVisibilityFacets(episode);
  if (course && visibilityFacets.length === 1) return subjectColor(visibilityFacets[0]);
  return course ? '#67d7b1' : '#e7bd61';
}

export function episodeEntityLabel(episode) {
  return episodeCanonicalSubject(episode)
    || (typeof episodeCourseEntity(episode)?.canonical === 'string' && episodeCourseEntity(episode).canonical.trim())
    || (typeof episode?.scope_entity?.label === 'string' && episode.scope_entity.label.trim())
    || (typeof episode?.scope_entity?.canonical === 'string' && episode.scope_entity.canonical.trim())
    || (typeof episode?.subject?.source_label === 'string' && episode.subject.source_label.trim())
    || '跨学科框架';
}

function rgba(hex, alpha) {
  const value = hex.replace('#', '');
  const number = Number.parseInt(value.length === 3 ? value.split('').map((part) => part + part).join('') : value, 16);
  return `rgba(${(number >> 16) & 255},${(number >> 8) & 255},${number & 255},${alpha})`;
}

function yearX(year) {
  // Equal visual breathing room is assigned to reform eras so the dense
  // post-2001 corpus does not collapse into the right edge of the universe.
  const anchors = [[1902, -820], [1950, -650], [1978, -390], [2001, -110], [2011, 160], [2017, 410], [2022, 680]];
  const value = Number(year);
  if (value <= anchors[0][0]) return anchors[0][1];
  if (value >= anchors.at(-1)[0]) return anchors.at(-1)[1];
  for (let index = 1; index < anchors.length; index += 1) {
    const [rightYear, rightX] = anchors[index];
    const [leftYear, leftX] = anchors[index - 1];
    if (value <= rightYear) return leftX + ((value - leftYear) / (rightYear - leftYear)) * (rightX - leftX);
  }
  return 0;
}

function makeMilkyWay(width, height) {
  const layer = document.createElement('canvas');
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  layer.width = Math.max(1, Math.round(width * ratio));
  layer.height = Math.max(1, Math.round(height * ratio));
  const context = layer.getContext('2d');
  context.scale(ratio, ratio);
  const random = randomFrom(90210 + Math.round(width) * 7 + Math.round(height));
  context.clearRect(0, 0, width, height);

  const haze = context.createLinearGradient(0, height * .84, width, height * .14);
  haze.addColorStop(0, 'rgba(34,61,126,0)');
  haze.addColorStop(.32, 'rgba(50,78,145,.08)');
  haze.addColorStop(.55, 'rgba(157,122,186,.09)');
  haze.addColorStop(.72, 'rgba(59,117,158,.07)');
  haze.addColorStop(1, 'rgba(15,35,85,0)');
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate(-.34);
  context.fillStyle = haze;
  context.filter = 'blur(28px)';
  context.fillRect(-width * .7, -height * .18, width * 1.4, height * .36);
  context.restore();
  context.filter = 'none';

  const nebulae = [
    [.24, .62, '#39286b', .20], [.67, .34, '#204e72', .18], [.79, .67, '#603456', .12], [.48, .45, '#415f9c', .13],
  ];
  for (const [x, y, color, opacity] of nebulae) {
    const radius = Math.max(width, height) * (.18 + random() * .13);
    const gradient = context.createRadialGradient(width * x, height * y, 0, width * x, height * y, radius);
    gradient.addColorStop(0, rgba(color, opacity));
    gradient.addColorStop(.38, rgba(color, opacity * .45));
    gradient.addColorStop(1, rgba(color, 0));
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  }

  for (let index = 0; index < Math.min(1100, Math.round(width * height / 900)); index += 1) {
    const x = random() * width;
    const y = random() * height;
    const size = random() > .986 ? 1.8 : random() * 1.05 + .2;
    const alpha = .13 + random() * .58;
    context.fillStyle = random() > .82 ? `rgba(157,205,255,${alpha})` : `rgba(255,250,230,${alpha})`;
    context.fillRect(x, y, size, size);
  }
  return layer;
}

export class CurriculumCosmos {
  constructor(mount, callbacks = {}) {
    this.mount = mount;
    this.callbacks = callbacks;
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-label', '历代课程标准星图，可拖动旋转、滚轮缩放并点击星体；菱形星体为课程节点，圆形星体为学科概念');
    this.mount.replaceChildren(this.canvas);
    this.context = this.canvas.getContext('2d');
    this.abort = new AbortController();
    this.graph = null;
    this.nodes = [];
    this.lineageEdges = [];
    this.crossEdges = [];
    this.evolutionEdges = [];
    this.screenNodes = [];
    this.subjects = [];
    this.tracks = [];
    this.filters = { hiddenSubjects: new Set(), hideAll: false, maxYear: 2022, query: '' };
    this.mode = 'lineage';
    this.selectedId = null;
    this.selectedFamilyId = null;
    this.activeSelectionIds = new Set();
    this.hovered = null;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.frame = 0;
    this.raf = 0;
    this.motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
    this.stable = this.motionQuery.matches;
    this.camera = { ...DEFAULT_CAMERA };
    this.target = { ...this.camera };
    this.hasUserCamera = false;
    this.pointer = null;
    this.pointers = new Map();
    this.lastPinch = null;
    this.meteor = { t: -1, x: 0, y: 0, length: 0 };
    this.background = null;
    this.bind();
    this.resize();
    this.loop();
  }

  setData(graph) {
    this.graph = graph;
    const episodes = (graph?.episodes || []).filter((episode) => Number(episode.time?.year) >= 1800);
    this.subjects = Array.isArray(graph?.subject_facets) ? [...graph.subject_facets] : [...new Set(episodes.map(episodeSubjectFacet).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    this.tracks = [...new Set(episodes.map((episode) => `${episodeSubjectFacet(episode) ? 'subject' : episodeCourseEntity(episode) ? 'course' : 'scope'}:${episodeEntityLabel(episode)}`))]
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const trackIndex = new Map(this.tracks.map((track, index) => [track, index]));
    this.nodes = episodes.map((episode) => {
      const subject = episodeSubjectFacet(episode);
      const visibilityFacets = episodeVisibilityFacets(episode);
      const course = episodeCourseEntity(episode);
      const entityLabel = episodeEntityLabel(episode);
      const track = `${subject ? 'subject' : course ? 'course' : 'scope'}:${entityLabel}`;
      const slot = trackIndex.get(track) || 0;
      const angle = (slot / Math.max(1, this.tracks.length)) * TAU + .58;
      const conceptDrift = randomFrom(hash(episode.concept_id));
      const lineDrift = randomFrom(hash(episode.curriculum_line?.id));
      const radius = 255 + (slot % 5) * 15 + (conceptDrift() - .5) * 54;
      const display = episode.claim_policy?.display_level || 'uniform_star';
      return {
        kind: 'concept', episode, id: episode.id, subject, visibilityFacets, course: course?.canonical || null, entityLabel, facetEligible: Boolean(subject), year: Number(episode.time.year),
        conceptId: episode.concept_id, color: episodeColor(episode),
        evolutionFamilyId: episode.evolution_family_id || null,
        evolutionTierId: episode.evolution_tier_id || null,
        x: yearX(Math.max(1902, Math.min(2022, Number(episode.time.year)))),
        y: Math.sin(angle) * radius + (conceptDrift() - .5) * 68 + (lineDrift() - .5) * 24,
        z: Math.cos(angle) * radius * .8 + (conceptDrift() - .5) * 52 + (lineDrift() - .5) * 24,
        phase: conceptDrift() * TAU, display, effects: starEffectProfile(display),
        strength: Number(episode.observation?.visual_strength) || .35,
      };
    });
    this.buildEdges(graph?.edges || []);
    this.fitToGraph({ immediate: true, maxZoom: 1 });
  }

  buildEdges(edges) {
    const byId = new Map(this.nodes.map((node) => [node.id, node]));
    const resolved = edges.map((edge) => ({ ...edge, sourceNode: byId.get(edge.source), targetNode: byId.get(edge.target) }))
      .filter((edge) => edge.sourceNode && edge.targetNode);
    this.lineageEdges = resolved.filter((edge) => edge.mode === 'lineage' && edge.type === 'next_observed');
    this.crossEdges = resolved.filter((edge) => edge.mode === 'cross');
    this.evolutionEdges = resolved.filter((edge) => edge.mode === 'evolution');
  }

  setFilters(next, { fitVisible = false, maxZoom = 1.32 } = {}) {
    this.filters = {
      hiddenSubjects: next.hiddenSubjects || this.filters.hiddenSubjects,
      hideAll: Boolean(next.hideAll),
      maxYear: Number(next.maxYear ?? this.filters.maxYear),
      query: String(next.query ?? this.filters.query).trim().toLocaleLowerCase('zh-CN'),
    };
    if (!fitVisible || !this.fitToVisibleGraph({ maxZoom, preserveOrientation: true })) this.draw();
  }

  setMode(mode) {
    this.mode = mode === 'cross' ? 'cross' : 'lineage';
    this.draw();
  }

  setSelected(id) {
    this.selectedId = id || null;
    const selected = this.nodes.find((node) => node.id === this.selectedId);
    this.selectedFamilyId = selected?.evolutionFamilyId || null;
    this.activeSelectionIds = selectedEvolutionNodeIds(this.nodes, this.selectedId);
    this.draw();
  }

  reset() {
    this.hasUserCamera = false;
    this.fitToVisibleGraph({ immediate: this.stable, maxZoom: this.visibleSubjectCount() === 1 ? 1.32 : 1 });
  }

  visible(node) {
    if (node.year > this.filters.maxYear || !episodeVisibleForSubjectFilter(node.episode, this.filters.hiddenSubjects, this.filters.hideAll, this.subjects)) return false;
    if (!this.filters.query) return true;
    const episode = node.episode;
    return `${episode.label} ${(episode.aliases || []).join(' ')} ${node.entityLabel} ${node.year} ${episode.category} ${episode.curriculum_line?.stage}`
      .toLocaleLowerCase('zh-CN').includes(this.filters.query);
  }

  transformed(node, camera = this.camera) {
    const cosY = Math.cos(camera.yaw);
    const sinY = Math.sin(camera.yaw);
    const x1 = node.x * cosY - node.z * sinY;
    const z1 = node.x * sinY + node.z * cosY;
    const cosX = Math.cos(camera.pitch);
    const sinX = Math.sin(camera.pitch);
    const y1 = node.y * cosX - z1 * sinX;
    const z2 = node.y * sinX + z1 * cosX;
    const perspective = 930 / Math.max(360, 930 + z2);
    return { x: x1 * perspective, y: y1 * perspective, z: z2, perspective };
  }

  project(node) {
    const transformed = this.transformed(node);
    const scale = this.camera.zoom * transformed.perspective;
    return {
      x: this.width / 2 + transformed.x * this.camera.zoom + this.camera.panX,
      y: this.height / 2 + transformed.y * this.camera.zoom + this.camera.panY,
      z: transformed.z, scale,
    };
  }

  safeViewport() {
    if (this.width <= 640) {
      return { left: Math.min(118, this.width * .31), top: 78, right: this.width - 8, bottom: this.height - 10 };
    }
    if (this.width <= 980) {
      return { left: 176, top: 96, right: this.width - 18, bottom: this.height - 18 };
    }
    return { left: 254, top: 108, right: this.width - 24, bottom: this.height - 24 };
  }

  fitToGraph({ immediate = false, nodes = this.nodes, maxZoom = 1, preserveOrientation = false } = {}) {
    const candidates = Array.isArray(nodes) ? nodes.filter(Boolean) : [];
    if (!candidates.length || this.width < 2 || this.height < 2) return false;
    const orientation = preserveOrientation
      ? { ...DEFAULT_CAMERA, yaw: this.target.yaw, pitch: this.target.pitch }
      : { ...DEFAULT_CAMERA };
    const points = candidates.map((node) => this.transformed(node, orientation));
    const bounds = points.reduce((result, point) => ({
      minX: Math.min(result.minX, point.x), maxX: Math.max(result.maxX, point.x),
      minY: Math.min(result.minY, point.y), maxY: Math.max(result.maxY, point.y),
    }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    const safe = this.safeViewport();
    const availableWidth = Math.max(80, safe.right - safe.left);
    const availableHeight = Math.max(120, safe.bottom - safe.top);
    const graphWidth = Math.max(1, bounds.maxX - bounds.minX + 120);
    const graphHeight = Math.max(1, bounds.maxY - bounds.minY + 90);
    const zoom = clamp(Math.min(availableWidth / graphWidth, availableHeight / graphHeight) * .96, MIN_ZOOM, Math.min(MAX_ZOOM, maxZoom));
    const graphCenterX = (bounds.minX + bounds.maxX) / 2;
    const graphCenterY = (bounds.minY + bounds.maxY) / 2;
    const viewportCenterX = (safe.left + safe.right) / 2;
    const viewportCenterY = (safe.top + safe.bottom) / 2;
    const fitted = {
      ...orientation,
      zoom,
      panX: viewportCenterX - this.width / 2 - graphCenterX * zoom,
      panY: viewportCenterY - this.height / 2 - graphCenterY * zoom,
    };
    Object.assign(this.target, fitted);
    if (immediate) Object.assign(this.camera, fitted);
    if (!this.raf) this.loop();
    else this.draw();
    return true;
  }

  fitToVisibleGraph(options = {}) {
    return this.fitToGraph({ ...options, nodes: this.nodes.filter((node) => this.visible(node)) });
  }

  visibleSubjectCount() {
    return new Set(this.nodes.filter((node) => this.visible(node)).map((node) => node.subject).filter(Boolean)).size;
  }

  resize() {
    const previousWidth = this.width;
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.background = makeMilkyWay(this.width, this.height);
    const crossedMobileBreakpoint = Boolean(previousWidth) && (previousWidth <= 640) !== (this.width <= 640);
    if (this.nodes.length && (!this.hasUserCamera || crossedMobileBreakpoint)) this.fitToVisibleGraph({
      immediate: true,
      maxZoom: this.visibleSubjectCount() === 1 ? 1.32 : 1,
      preserveOrientation: this.hasUserCamera,
    });
    else this.draw();
  }

  drawBackground(time) {
    const context = this.context;
    context.fillStyle = '#03050e';
    context.fillRect(0, 0, this.width, this.height);
    if (this.background) context.drawImage(this.background, 0, 0, this.width, this.height);
    const vignette = context.createRadialGradient(this.width * .5, this.height * .48, 0, this.width * .5, this.height * .48, Math.max(this.width, this.height) * .69);
    vignette.addColorStop(.2, 'rgba(5,10,24,0)');
    vignette.addColorStop(1, 'rgba(0,1,7,.72)');
    context.fillStyle = vignette;
    context.fillRect(0, 0, this.width, this.height);

    if (!this.stable && Math.sin(time * .00019) > .997 && this.meteor.t < 0) {
      this.meteor = { t: 0, x: this.width * (.45 + Math.random() * .4), y: this.height * (.08 + Math.random() * .25), length: 90 + Math.random() * 90 };
    }
    if (this.meteor.t >= 0) {
      const progress = this.meteor.t;
      const x = this.meteor.x - progress * 240;
      const y = this.meteor.y + progress * 100;
      const gradient = context.createLinearGradient(x, y, x + this.meteor.length, y - this.meteor.length * .42);
      gradient.addColorStop(0, 'rgba(255,255,255,0)');
      gradient.addColorStop(1, `rgba(190,224,255,${Math.max(0, .65 - progress * .65)})`);
      context.strokeStyle = gradient;
      context.lineWidth = 1.2;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + this.meteor.length, y - this.meteor.length * .42);
      context.stroke();
      this.meteor.t = progress > 1 ? -1 : progress + .018;
    }
  }

  drawEraGates() {
    const context = this.context;
    context.save();
    context.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    for (const gate of ERA_GATES) {
      const top = this.project({ x: yearX(gate.year), y: -450, z: 0 });
      const bottom = this.project({ x: yearX(gate.year), y: 450, z: 0 });
      context.beginPath();
      context.moveTo(top.x, top.y);
      context.lineTo(bottom.x, bottom.y);
      context.strokeStyle = gate.year === 2022 ? 'rgba(231,189,97,.27)' : 'rgba(155,178,222,.12)';
      context.lineWidth = 1;
      context.stroke();
      const safe = this.safeViewport();
      if (top.x > safe.left && top.x < safe.right) {
        const label = `${gate.year}  ${gate.label}`;
        const labelX = top.x + 7;
        const labelY = Math.max(safe.top + 13, top.y + 17);
        const labelWidth = context.measureText(label).width;
        context.fillStyle = 'rgba(3,6,16,.58)';
        context.fillRect(labelX - 4, labelY - 13, labelWidth + 8, 18);
        context.fillStyle = gate.year === 2022 ? 'rgba(242,205,124,.9)' : 'rgba(200,215,242,.76)';
        context.fillText(label, labelX, labelY);
      }
    }
    context.restore();
  }

  drawEdge(source, target, color, width = 1, options = {}) {
    if (!source || !target || !this.visible(source) || !this.visible(target)) return;
    const a = this.project(source);
    const b = this.project(target);
    if ((a.x < -40 && b.x < -40) || (a.x > this.width + 40 && b.x > this.width + 40)) return;
    const context = this.context;
    const curve = Math.min(90, Math.abs(b.x - a.x) * .18);
    const c1 = { x: a.x + curve, y: a.y };
    const c2 = { x: b.x - curve, y: b.y };
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
    context.lineWidth = width;
    context.strokeStyle = color;
    context.stroke();
    if (options.arrow) {
      const angle = Math.atan2(b.y - c2.y, b.x - c2.x);
      const size = 4.5 + width;
      context.save();
      context.translate(b.x, b.y);
      context.rotate(angle);
      context.fillStyle = color;
      context.beginPath();
      context.moveTo(0, 0);
      context.lineTo(-size, -size * .56);
      context.lineTo(-size, size * .56);
      context.closePath();
      context.fill();
      context.restore();
    }
    if (options.label) {
      const t = .5;
      const mt = 1 - t;
      const x = mt ** 3 * a.x + 3 * mt ** 2 * t * c1.x + 3 * mt * t ** 2 * c2.x + t ** 3 * b.x;
      const y = mt ** 3 * a.y + 3 * mt ** 2 * t * c1.y + 3 * mt * t ** 2 * c2.y + t ** 3 * b.y;
      context.save();
      context.font = '650 9px ui-sans-serif, system-ui, sans-serif';
      const textWidth = context.measureText(options.label).width;
      context.fillStyle = 'rgba(4,7,17,.9)';
      context.fillRect(x - textWidth / 2 - 5, y - 8, textWidth + 10, 16);
      context.fillStyle = 'rgba(244,220,165,.92)';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(options.label, x, y);
      context.restore();
    }
  }

  drawNode(node, projected, time) {
    const context = this.context;
    const selected = node.id === this.selectedId;
    const related = this.activeSelectionIds.has(node.id);
    const selectionActive = this.activeSelectionIds.size > 0;
    const muted = selectionActive && !related;
    const visualAlpha = muted ? .34 : 1;
    const hovered = node.id === this.hovered?.id;
    const emphasized = selected || related;
    const depthScale = clamp(projected.scale, .42, 1.55);
    const radius = Math.max(1.05, (1.45 + node.strength * 3.15) * depthScale) + (selected ? 2.35 : related ? 1.15 : hovered ? 1.45 : 0);
    const pulse = this.stable ? 0 : Math.sin(time * .0017 + node.phase) * .72 * node.effects.pulseAmplitude;
    const depthAlpha = clamp(.48 + projected.scale * .38, .5, 1);
    const halo = radius * (selected ? 6.2 : related ? 5.4 : hovered ? 5.4 : 4.4) + pulse;
    const gradient = context.createRadialGradient(projected.x, projected.y, 0, projected.x, projected.y, halo);
    gradient.addColorStop(0, rgba(node.color, (selected ? .66 : related ? .48 : .32 * depthAlpha) * node.effects.haloOpacity * visualAlpha));
    gradient.addColorStop(.22, rgba(node.color, (selected ? .22 : related ? .18 : .13 * depthAlpha) * node.effects.haloOpacity * visualAlpha));
    gradient.addColorStop(1, rgba(node.color, 0));
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(projected.x, projected.y, halo, 0, TAU);
    context.fill();

    const spikeLength = (selected ? radius * 5.2 : related ? radius * 3.3 : hovered ? radius * 3.8 : node.strength >= .72 ? radius * 2.25 : 0) * node.effects.spikeScale;
    if (spikeLength) {
      context.save();
      context.strokeStyle = rgba(node.color, (selected ? .62 : related ? .4 : hovered ? .45 : .2 * depthAlpha) * visualAlpha);
      context.lineWidth = selected ? 1.1 : .65;
      context.beginPath();
      context.moveTo(projected.x - spikeLength, projected.y);
      context.lineTo(projected.x + spikeLength, projected.y);
      context.moveTo(projected.x, projected.y - spikeLength * .7);
      context.lineTo(projected.x, projected.y + spikeLength * .7);
      context.stroke();
      context.restore();
    }

    context.beginPath();
    context.arc(projected.x, projected.y, radius, 0, TAU);
    context.fillStyle = rgba(node.color, depthAlpha * node.effects.coreOpacity * visualAlpha);
    context.fill();
    context.beginPath();
    context.arc(projected.x - radius * .28, projected.y - radius * .28, Math.max(.55, radius * .27), 0, TAU);
    context.fillStyle = `rgba(255,255,255,${(.68 + depthAlpha * .26) * visualAlpha})`;
    context.fill();

    if (node.course) {
      const markerRadius = radius + 2.4;
      context.save();
      context.translate(projected.x, projected.y);
      context.rotate(Math.PI / 4);
      context.strokeStyle = rgba(node.color, (emphasized || hovered ? .88 : .56 * depthAlpha) * visualAlpha);
      context.lineWidth = selected ? 1.35 : .85;
      context.strokeRect(-markerRadius, -markerRadius, markerRadius * 2, markerRadius * 2);
      context.restore();
    }

    if (selected) {
      context.save();
      context.strokeStyle = rgba(node.color, .82);
      context.lineWidth = 1.15;
      context.beginPath();
      context.arc(projected.x, projected.y, radius + 8 + pulse * .4, 0, TAU);
      context.stroke();
      context.restore();
    }
    return radius;
  }

  drawNodeLabel(item, occupied) {
    const { node, projected, radius } = item;
    const selected = node.id === this.selectedId;
    const related = this.activeSelectionIds.has(node.id);
    const hovered = node.id === this.hovered?.id;
    const label = `${node.episode.label} · ${node.year}`;
    const context = this.context;
    context.save();
    context.font = `${selected || related || hovered ? '650' : '550'} 11px ui-sans-serif, system-ui, sans-serif`;
    const textWidth = context.measureText(label).width;
    const width = textWidth + 14;
    const height = 23;
    const safe = this.safeViewport();
    let x = projected.x + radius + 8;
    if (x + width > safe.right) x = projected.x - radius - 8 - width;
    x = clamp(x, safe.left, Math.max(safe.left, safe.right - width));
    const y = clamp(projected.y - radius - height + 4, safe.top, Math.max(safe.top, safe.bottom - height));
    const box = { x: x - 3, y: y - 3, width: width + 6, height: height + 6 };
    if (!selected && !hovered && occupied.some((candidate) => boxesOverlap(box, candidate))) {
      context.restore();
      return;
    }
    occupied.push(box);
    context.fillStyle = selected ? 'rgba(7,10,22,.94)' : related ? 'rgba(5,9,22,.9)' : 'rgba(3,6,16,.8)';
    context.fillRect(x, y, width, height);
    if (selected || related || hovered) {
      context.strokeStyle = rgba(node.color, selected ? .72 : related ? .55 : .45);
      context.lineWidth = 1;
      context.strokeRect(x + .5, y + .5, width - 1, height - 1);
    }
    context.textBaseline = 'middle';
    context.lineWidth = 3;
    context.strokeStyle = 'rgba(0,2,8,.95)';
    context.strokeText(label, x + 7, y + height / 2 + .5);
    context.fillStyle = `rgba(244,247,255,${.96 * node.effects.labelOpacity})`;
    context.fillText(label, x + 7, y + height / 2 + .5);
    context.restore();
  }

  draw(time = performance.now()) {
    if (!this.width || !this.height) return;
    this.drawBackground(time);
    this.drawEraGates();
    if (this.selectedFamilyId) {
      for (const edge of this.evolutionEdges.filter((item) => item.family_id === this.selectedFamilyId)) {
        const span = Math.abs(Number(edge.target_year) - Number(edge.source_year));
        const relationLabel = edge.type === 'editorial_correspondence' || span >= 12
          ? `${edge.source_year}→${edge.target_year} · ${edge.label}`
          : null;
        const color = edge.type === 'editorial_correspondence'
          ? 'rgba(242,198,105,.76)'
          : rgba(edge.sourceNode.color, .48);
        this.drawEdge(edge.sourceNode, edge.targetNode, color, edge.type === 'editorial_correspondence' ? 1.55 : 1.08, {
          arrow: true,
          label: relationLabel,
        });
      }
      if (this.mode === 'cross') {
        for (const edge of this.crossEdges.filter((item) =>
          this.activeSelectionIds.has(item.source) && this.activeSelectionIds.has(item.target))) {
          this.drawEdge(edge.sourceNode, edge.targetNode, 'rgba(118,223,255,.24)', .8);
        }
      }
    } else if (this.selectedId) {
      const edges = this.mode === 'cross' ? this.crossEdges : this.lineageEdges;
      for (const edge of edges.filter((item) => item.source === this.selectedId || item.target === this.selectedId)) {
        this.drawEdge(edge.sourceNode, edge.targetNode, this.mode === 'cross'
          ? 'rgba(239,204,126,.62)'
          : rgba(edge.sourceNode.color, .56), 1.45);
      }
    }
    this.screenNodes = this.nodes.filter((node) => this.visible(node)).map((node) => ({ node, projected: this.project(node) }))
      .filter(({ projected }) => projected.x > -50 && projected.x < this.width + 50 && projected.y > -50 && projected.y < this.height + 50)
      .sort((left, right) => left.projected.z - right.projected.z);
    const drawn = this.screenNodes.map((item) => ({ ...item, radius: this.drawNode(item.node, item.projected, time) }));
    const labels = drawn.filter(({ node }) => this.activeSelectionIds.has(node.id) || node.id === this.hovered?.id
      || starAutoLabelEligible(node));
    labels.sort((left, right) => {
      const priority = ({ node }) => (node.id === this.selectedId ? 100 : this.activeSelectionIds.has(node.id) ? 94 : node.id === this.hovered?.id ? 90 : 30 + node.strength);
      return priority(right) - priority(left);
    });
    const occupied = [];
    for (const item of labels) this.drawNodeLabel(item, occupied);
  }

  loop(time = performance.now()) {
    this.raf = 0;
    if (document.hidden) return;
    const easing = this.stable ? 1 : .085;
    let moving = false;
    for (const key of ['yaw', 'pitch', 'zoom', 'panX', 'panY']) {
      const delta = this.target[key] - this.camera[key];
      if (Math.abs(delta) > .0001) moving = true;
      this.camera[key] += delta * easing;
    }
    this.draw(time);
    if (!this.stable || moving) this.raf = requestAnimationFrame((next) => this.loop(next));
  }

  hitTest(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let found = null;
    let distance = 20;
    for (let index = this.screenNodes.length - 1; index >= 0; index -= 1) {
      const item = this.screenNodes[index];
      const current = Math.hypot(item.projected.x - x, item.projected.y - y);
      if (current < distance) { found = item.node; distance = current; }
    }
    return found;
  }

  bind() {
    const { signal } = this.abort;
    window.addEventListener('resize', () => this.resize(), { signal });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        return;
      }
      this.draw();
      if (!this.raf) this.loop();
    }, { signal });
    this.motionQuery.addEventListener('change', (event) => {
      this.stable = event.matches;
      if (!this.raf) this.loop();
    }, { signal });
    this.canvas.addEventListener('pointerdown', (event) => {
      this.canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, yaw: this.target.yaw, pitch: this.target.pitch, panX: this.target.panX, panY: this.target.panY, moved: false, button: event.button };
      this.canvas.classList.add('dragging');
    }, { signal });
    this.canvas.addEventListener('pointermove', (event) => {
      if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.lastPinch) {
          this.hasUserCamera = true;
          this.target.zoom = clamp(this.target.zoom * (distance / this.lastPinch), MIN_ZOOM, MAX_ZOOM);
        }
        this.lastPinch = distance;
        if (!this.raf) this.loop();
        return;
      }
      if (this.pointer?.id === event.pointerId) {
        const dx = event.clientX - this.pointer.x;
        const dy = event.clientY - this.pointer.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) {
          this.pointer.moved = true;
          this.hasUserCamera = true;
        }
        if (this.pointer.button === 2 || event.shiftKey) {
          this.target.panX = this.pointer.panX + dx;
          this.target.panY = this.pointer.panY + dy;
        } else {
          this.target.yaw = this.pointer.yaw + dx * .0042;
          this.target.pitch = Math.max(-.72, Math.min(.72, this.pointer.pitch + dy * .0034));
        }
        if (!this.raf) this.loop();
        return;
      }
      const next = this.hitTest(event.clientX, event.clientY);
      if (next?.id !== this.hovered?.id) {
        this.hovered = next;
        this.canvas.classList.toggle('pointing', Boolean(next));
        this.callbacks.onHover?.(next, event);
        this.draw();
      } else if (next) this.callbacks.onHover?.(next, event);
    }, { signal });
    const release = (event) => {
      this.pointers.delete(event.pointerId);
      this.lastPinch = null;
      if (this.pointer?.id === event.pointerId && !this.pointer.moved) {
        const node = this.hitTest(event.clientX, event.clientY);
        if (node) {
          this.selectedId = node.id;
          this.callbacks.onSelect?.(node.episode);
        }
      }
      this.pointer = null;
      this.canvas.classList.remove('dragging');
      this.draw();
    };
    this.canvas.addEventListener('pointerup', release, { signal });
    this.canvas.addEventListener('pointercancel', release, { signal });
    this.canvas.addEventListener('pointerleave', (event) => {
      if (!this.pointer) {
        this.hovered = null;
        this.canvas.classList.remove('pointing');
        this.callbacks.onHover?.(null, event);
      }
    }, { signal });
    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.hasUserCamera = true;
      this.target.zoom = clamp(this.target.zoom * Math.exp(-event.deltaY * .0011), MIN_ZOOM, MAX_ZOOM);
      if (!this.raf) this.loop();
    }, { passive: false, signal });
    this.canvas.addEventListener('dblclick', () => this.reset(), { signal });
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });
  }

  destroy() {
    this.abort.abort();
    cancelAnimationFrame(this.raf);
    this.mount.replaceChildren();
  }
}
