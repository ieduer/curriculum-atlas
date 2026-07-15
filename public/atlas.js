const TAU = Math.PI * 2;
const CORE_COLORS = {
  '语文': '#ff7878', '数学': '#63d9ff', '英语': '#ad8cff', '物理': '#6ae7cf',
  '化学': '#ffd166', '生物学': '#75e38f', '生物': '#75e38f', '历史': '#ef9f62',
  '地理': '#68b7ff', '道德与法治': '#ee7fb4', '思想政治': '#ee7fb4',
  '科学': '#70e0bc', '信息科技': '#73c8ff', '信息技术': '#73c8ff',
  '艺术': '#e69cff', '音乐': '#d59aff', '美术': '#ff9cb3', '体育与健康': '#90df83',
  '劳动': '#e5b66f', '综合实践活动': '#a9c876', '课程方案': '#f2c86a',
  '考试评价': '#f4d17a', '考试大纲': '#f4d17a', '综合': '#e8d6a2',
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

export function subjectColor(subject) {
  return CORE_COLORS[subject] || FALLBACK_COLORS[hash(subject) % FALLBACK_COLORS.length];
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
    this.canvas.setAttribute('aria-label', '历代课程标准星图，可拖动旋转、滚轮缩放并点击星体');
    this.mount.replaceChildren(this.canvas);
    this.context = this.canvas.getContext('2d');
    this.abort = new AbortController();
    this.graph = null;
    this.nodes = [];
    this.lineageEdges = [];
    this.crossEdges = [];
    this.screenNodes = [];
    this.subjects = [];
    this.filters = { hiddenSubjects: new Set(), maxYear: 2022, query: '' };
    this.mode = 'lineage';
    this.selectedId = null;
    this.hovered = null;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.frame = 0;
    this.raf = 0;
    this.stable = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.camera = { yaw: -.12, pitch: -.11, zoom: 1, panX: 0, panY: 8 };
    this.target = { ...this.camera };
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
    this.subjects = [...new Set(episodes.map((episode) => episode.subject?.canonical || '未分类'))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const subjectIndex = new Map(this.subjects.map((subject, index) => [subject, index]));
    this.nodes = episodes.map((episode) => {
      const subject = episode.subject?.canonical || '未分类';
      const slot = subjectIndex.get(subject) || 0;
      const angle = (slot / Math.max(1, this.subjects.length)) * TAU + .58;
      const conceptDrift = randomFrom(hash(episode.concept_id));
      const lineDrift = randomFrom(hash(episode.curriculum_line?.id));
      const radius = 255 + (slot % 5) * 15 + (conceptDrift() - .5) * 54;
      const display = episode.claim_policy?.display_level || 'candidate_dashed';
      return {
        kind: 'concept', episode, id: episode.id, subject, year: Number(episode.time.year),
        conceptId: episode.concept_id, color: subjectColor(subject),
        x: yearX(Math.max(1902, Math.min(2022, Number(episode.time.year)))),
        y: Math.sin(angle) * radius + (conceptDrift() - .5) * 68 + (lineDrift() - .5) * 24,
        z: Math.cos(angle) * radius * .8 + (conceptDrift() - .5) * 52 + (lineDrift() - .5) * 24,
        phase: conceptDrift() * TAU, display,
        strength: Number(episode.observation?.visual_strength) || .35,
      };
    });
    this.buildEdges(graph?.edges || []);
    this.draw();
  }

  buildEdges(edges) {
    const byId = new Map(this.nodes.map((node) => [node.id, node]));
    const resolved = edges.map((edge) => ({ ...edge, sourceNode: byId.get(edge.source), targetNode: byId.get(edge.target) }))
      .filter((edge) => edge.sourceNode && edge.targetNode);
    this.lineageEdges = resolved.filter((edge) => edge.mode === 'lineage' && edge.type === 'next_observed');
    this.crossEdges = resolved.filter((edge) => edge.mode === 'cross');
  }

  setFilters(next) {
    this.filters = {
      hiddenSubjects: next.hiddenSubjects || this.filters.hiddenSubjects,
      maxYear: Number(next.maxYear ?? this.filters.maxYear),
      query: String(next.query ?? this.filters.query).trim().toLocaleLowerCase('zh-CN'),
    };
    this.draw();
  }

  setMode(mode) {
    this.mode = mode === 'cross' ? 'cross' : 'lineage';
    this.draw();
  }

  setSelected(id) {
    this.selectedId = id || null;
    this.draw();
  }

  setStable(stable) {
    this.stable = Boolean(stable);
    if (!this.raf) this.loop();
    this.draw();
  }

  reset() {
    Object.assign(this.target, { yaw: -.12, pitch: -.11, zoom: 1, panX: 0, panY: 8 });
    this.draw();
  }

  visible(node) {
    if (node.year > this.filters.maxYear || this.filters.hiddenSubjects.has(node.subject)) return false;
    if (!this.filters.query) return true;
    const episode = node.episode;
    return `${episode.label} ${(episode.aliases || []).join(' ')} ${node.subject} ${node.year} ${episode.category} ${episode.curriculum_line?.stage}`
      .toLocaleLowerCase('zh-CN').includes(this.filters.query);
  }

  project(node) {
    const cosY = Math.cos(this.camera.yaw);
    const sinY = Math.sin(this.camera.yaw);
    const x1 = node.x * cosY - node.z * sinY;
    const z1 = node.x * sinY + node.z * cosY;
    const cosX = Math.cos(this.camera.pitch);
    const sinX = Math.sin(this.camera.pitch);
    const y1 = node.y * cosX - z1 * sinX;
    const z2 = node.y * sinX + z1 * cosX;
    const perspective = 930 / Math.max(360, 930 + z2);
    const scale = this.camera.zoom * perspective;
    return {
      x: this.width / 2 + x1 * scale + this.camera.panX,
      y: this.height / 2 + y1 * scale + this.camera.panY,
      z: z2, scale,
    };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.background = makeMilkyWay(this.width, this.height);
    this.draw();
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
    context.font = '9px ui-sans-serif, system-ui, sans-serif';
    for (const gate of ERA_GATES) {
      const top = this.project({ x: yearX(gate.year), y: -450, z: 0 });
      const bottom = this.project({ x: yearX(gate.year), y: 450, z: 0 });
      context.beginPath();
      context.moveTo(top.x, top.y);
      context.lineTo(bottom.x, bottom.y);
      context.strokeStyle = gate.year === 2022 ? 'rgba(231,189,97,.18)' : 'rgba(155,178,222,.07)';
      context.lineWidth = 1;
      context.stroke();
      if (top.x > 90 && top.x < this.width - 90) {
        context.fillStyle = gate.year === 2022 ? 'rgba(231,189,97,.58)' : 'rgba(170,187,221,.35)';
        context.fillText(`${gate.year}  ${gate.label}`, top.x + 6, Math.max(150, top.y + 16));
      }
    }
    context.restore();
  }

  drawEdge(source, target, color, width = 1, dash = []) {
    if (!source || !target || !this.visible(source) || !this.visible(target)) return;
    const a = this.project(source);
    const b = this.project(target);
    if ((a.x < -40 && b.x < -40) || (a.x > this.width + 40 && b.x > this.width + 40)) return;
    const context = this.context;
    context.beginPath();
    context.moveTo(a.x, a.y);
    const curve = Math.min(90, Math.abs(b.x - a.x) * .18);
    context.bezierCurveTo(a.x + curve, a.y, b.x - curve, b.y, b.x, b.y);
    context.setLineDash(dash);
    context.lineWidth = width;
    context.strokeStyle = color;
    context.stroke();
    context.setLineDash([]);
  }

  drawNode(node, projected, time) {
    const context = this.context;
    const selected = node.id === this.selectedId;
    const hovered = node.id === this.hovered?.id;
    const base = 2.25 + node.strength * 3.35;
    const radius = Math.max(1.6, base * Math.min(1.65, projected.scale)) + (selected ? 2.2 : hovered ? 1.4 : 0);
    const pulse = this.stable ? 0 : Math.sin(time * .0017 + node.phase) * .6;
    const halo = radius * 4.5 + pulse;
    const gradient = context.createRadialGradient(projected.x, projected.y, 0, projected.x, projected.y, halo);
    gradient.addColorStop(0, rgba(node.color, selected ? .48 : .29));
    gradient.addColorStop(.22, rgba(node.color, .14));
    gradient.addColorStop(1, rgba(node.color, 0));
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(projected.x, projected.y, halo, 0, TAU);
    context.fill();

    if (node.display === 'reviewed_ring') {
      context.strokeStyle = rgba(node.color, selected || hovered ? .9 : .55);
      context.lineWidth = selected ? 1.5 : 1;
      context.beginPath();
      context.arc(projected.x, projected.y, radius + 3 + pulse * .25, 0, TAU);
      context.stroke();
    } else if (node.display !== 'solid') {
      context.setLineDash([2.5, 2.5]);
      context.strokeStyle = node.display === 'warning_ring' ? 'rgba(255,178,102,.82)' : rgba(node.color, selected || hovered ? .9 : .5);
      context.lineWidth = 1;
      context.beginPath();
      context.arc(projected.x, projected.y, radius + 2.6, 0, TAU);
      context.stroke();
      context.setLineDash([]);
    }

    context.beginPath();
    context.arc(projected.x, projected.y, radius, 0, TAU);
    context.fillStyle = node.display === 'solid' ? node.color : rgba(node.color, node.display === 'reviewed_ring' ? .68 : .38);
    context.fill();
    context.beginPath();
    context.arc(projected.x - radius * .28, projected.y - radius * .28, Math.max(.55, radius * .27), 0, TAU);
    context.fillStyle = 'rgba(255,255,255,.84)';
    context.fill();

    const showLabel = selected || hovered || node.display === 'reviewed_ring';
    if (showLabel) {
      const label = `${node.episode.label} · ${node.year}`;
      context.font = `${selected ? '600' : '500'} 10px ui-sans-serif, system-ui, sans-serif`;
      context.fillStyle = node.display === 'solid' ? 'rgba(238,241,249,.86)' : 'rgba(244,225,174,.78)';
      context.fillText(label, projected.x + radius + 7, projected.y - radius - 2);
    }
  }

  draw(time = performance.now()) {
    if (!this.width || !this.height) return;
    this.drawBackground(time);
    this.drawEraGates();
    if (this.mode === 'lineage') {
      for (const edge of this.lineageEdges) {
        const connected = this.selectedId && (edge.source === this.selectedId || edge.target === this.selectedId);
        this.drawEdge(edge.sourceNode, edge.targetNode, rgba(edge.sourceNode.color, connected ? .56 : .14), connected ? 1.45 : .8);
      }
    } else {
      for (const edge of this.crossEdges) {
        const connected = this.selectedId && (edge.source === this.selectedId || edge.target === this.selectedId);
        this.drawEdge(edge.sourceNode, edge.targetNode, connected ? 'rgba(239,204,126,.62)' : 'rgba(229,195,119,.18)', connected ? 1.5 : .85, [3, 5]);
      }
    }
    this.screenNodes = this.nodes.filter((node) => this.visible(node)).map((node) => ({ node, projected: this.project(node) }))
      .filter(({ projected }) => projected.x > -50 && projected.x < this.width + 50 && projected.y > -50 && projected.y < this.height + 50)
      .sort((left, right) => left.projected.z - right.projected.z);
    for (const { node, projected } of this.screenNodes) this.drawNode(node, projected, time);
  }

  loop(time = performance.now()) {
    this.raf = 0;
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
        if (this.lastPinch) this.target.zoom = Math.max(.48, Math.min(2.3, this.target.zoom * (distance / this.lastPinch)));
        this.lastPinch = distance;
        if (!this.raf) this.loop();
        return;
      }
      if (this.pointer?.id === event.pointerId) {
        const dx = event.clientX - this.pointer.x;
        const dy = event.clientY - this.pointer.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) this.pointer.moved = true;
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
      this.target.zoom = Math.max(.48, Math.min(2.3, this.target.zoom * Math.exp(-event.deltaY * .0011)));
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
