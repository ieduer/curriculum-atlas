const palette = ['#78d8ff', '#e7b75f', '#bb8cff', '#7de1b5', '#f18a82'];

function subjectBand(subject) {
  let hash = 0;
  for (const char of subject || '') hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % 11;
}

export function mountAtlas(canvas, documents, onSelect) {
  if (!canvas) return () => {};
  const context = canvas.getContext('2d');
  const tip = canvas.parentElement.querySelector('.atlas-tip');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.classList.contains('stable');
  let width = 0;
  let height = 0;
  let dpr = 1;
  let panX = 0;
  let panY = 0;
  let zoom = 1;
  let dragging = false;
  let pointer = null;
  let hover = null;
  let frame = 0;
  let raf = 0;
  const docs = documents.filter((doc) => doc.sort_year).map((doc, index) => ({
    ...doc,
    year: doc.sort_year,
    band: subjectBand(doc.subject),
    color: palette[subjectBand(doc.subject) % palette.length],
    phase: (index * 2.399) % (Math.PI * 2),
  }));

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(2, devicePixelRatio || 1);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function position(doc) {
    const x = ((doc.year - 1945) / (2030 - 1945)) * width * .82 + width * .09;
    const y = height * .18 + (doc.band / 10) * height * .7 + Math.sin(doc.phase) * 18;
    return { x: (x - width / 2) * zoom + width / 2 + panX, y: (y - height / 2) * zoom + height / 2 + panY };
  }

  function draw() {
    context.clearRect(0, 0, width, height);
    const time = reduced ? 0 : frame * .008;
    context.save();
    for (let i = 0; i < 90; i += 1) {
      const x = ((i * 83.17) % width + Math.sin(time + i) * 3 + width) % width;
      const y = (i * 47.63) % height;
      const alpha = .12 + (i % 7) * .025;
      context.fillStyle = `rgba(255,255,255,${alpha})`;
      context.fillRect(x, y, i % 9 === 0 ? 1.8 : 1, i % 9 === 0 ? 1.8 : 1);
    }
    const groups = new Map();
    docs.forEach((doc) => {
      if (!groups.has(doc.subject)) groups.set(doc.subject, []);
      groups.get(doc.subject).push(doc);
    });
    context.lineWidth = 1;
    for (const group of groups.values()) {
      group.sort((a, b) => a.year - b.year);
      context.beginPath();
      group.forEach((doc, index) => {
        const p = position(doc);
        if (index === 0) context.moveTo(p.x, p.y);
        else context.lineTo(p.x, p.y);
      });
      context.strokeStyle = 'rgba(120,216,255,.12)';
      context.stroke();
    }
    for (const doc of docs) {
      const p = position(doc);
      const current = hover?.id === doc.id;
      const radius = (doc.document_type === '课程方案' ? 5 : 3.2) * Math.min(1.5, zoom) + (current ? 3 : 0);
      context.beginPath();
      context.arc(p.x, p.y, radius * 3.4, 0, Math.PI * 2);
      context.fillStyle = current ? `${doc.color}35` : `${doc.color}12`;
      context.fill();
      context.beginPath();
      context.arc(p.x, p.y, radius + Math.sin(time + doc.phase) * .35, 0, Math.PI * 2);
      context.fillStyle = doc.color;
      context.fill();
      if (current) {
        context.fillStyle = '#fffdf8';
        context.font = '600 12px ui-sans-serif, sans-serif';
        context.fillText(`${doc.year} · ${doc.subject}`, p.x + 14, p.y - 8);
      }
    }
    context.restore();
    if (!reduced) {
      frame += 1;
      raf = requestAnimationFrame(draw);
    }
  }

  function hitTest(x, y) {
    let nearest = null;
    let distance = 18;
    for (const doc of docs) {
      const p = position(doc);
      const value = Math.hypot(p.x - x, p.y - y);
      if (value < distance) { nearest = doc; distance = value; }
    }
    return nearest;
  }

  function showTip(event, doc) {
    if (!tip) return;
    if (!doc) { tip.classList.remove('show'); return; }
    tip.replaceChildren();
    const title = document.createElement('b');
    title.textContent = doc.title;
    const meta = document.createElement('small');
    meta.textContent = `${doc.year} · ${doc.stage} · 点击阅读`;
    tip.append(title, meta);
    tip.style.left = `${Math.min(width - 330, event.offsetX + 8)}px`;
    tip.style.top = `${Math.min(height - 100, event.offsetY + 8)}px`;
    tip.classList.add('show');
  }

  canvas.addEventListener('pointerdown', (event) => {
    dragging = false;
    pointer = { x: event.clientX, y: event.clientY, panX, panY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (pointer) {
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) dragging = true;
      panX = pointer.panX + dx;
      panY = pointer.panY + dy;
      if (reduced) draw();
      return;
    }
    hover = hitTest(event.offsetX, event.offsetY);
    canvas.style.cursor = hover ? 'pointer' : 'grab';
    showTip(event, hover);
    if (reduced) draw();
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!dragging) {
      const doc = hitTest(event.offsetX, event.offsetY);
      if (doc) onSelect(doc);
    }
    pointer = null;
  });
  canvas.addEventListener('pointerleave', () => { pointer = null; hover = null; showTip({}, null); if (reduced) draw(); });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoom = Math.min(2.2, Math.max(.72, zoom * (event.deltaY > 0 ? .92 : 1.08)));
    if (reduced) draw();
  }, { passive: false });
  addEventListener('resize', resize);
  resize();
  if (!reduced) raf = requestAnimationFrame(draw);
  return () => { cancelAnimationFrame(raf); removeEventListener('resize', resize); };
}
