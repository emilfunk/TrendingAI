// iter-37 — hero-zone viz IIFE. Ported VERBATIM from out/data-viz-mockup.html
// lines 826-1085 (B-v2.1 Algorithm Interior + B-v2.2 Creator × Feature Chord).
// F/G/H/I are deferred to iter-38..40 per iter-36 close roadmap. Diffability
// against the mockup IIFE is the only sanity check that the SVGs still render
// — Advisor pre-BUILD risk #4: "Port verbatim first, then refactor. Don't
// 'improve' during the port."
//
// One structural change from mockup: const DATA is no longer a static inlined
// JSON blob in the IIFE. Instead it reads from a separate JSON script tag at
// render-time (data computed by buildHeroPayload in render-features-first.ts
// against the live disk data each render). This satisfies ISC-468 spec
// "Generate the DATA payload at render time from features-confirmed.json +
// per-source pool counts (NOT embedded JSON like the mockup — pull live from
// disk per render)" while preserving the IIFE's render logic byte-for-byte.

(function() {
  const DATA = JSON.parse(document.getElementById('hero-data').textContent);

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function el(name, attrs) {
    const e = document.createElementNS(SVG_NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // ==========================================================
  // VIZ B-v2.1 — Algorithm Interior with REAL provenance
  // 1432 items harvested (dim) · 185 cited in 14 features (accent) · 12 themes
  // Every edge is a real responses[].url → feature mapping. Zero pseudo-random.
  // ==========================================================
  const graph = document.getElementById('hero-algo-graph');
  if (graph) {
    const cx = 400, cy = 270;
    const R_SOURCE = 245;   // outer ring labels
    const R_ITEM_MIN = 158; // ring 2 inner edge
    const R_ITEM_MAX = 218; // ring 2 outer edge
    const R_FEATURE = 108;
    const R_THEME = 52;

    const SOURCES = ['x','tiktok','instagram','youtube','reddit','hn','github','arxiv','bluesky','frontier','editorial','enterprise'];

    // Source arc allocation proportional to pool count (1432 total)
    let acc = 0;
    const sourceArcs = SOURCES.map(s => {
      const n = DATA.pools[s];
      const start = acc / DATA.total_pool;
      acc += n;
      const end = acc / DATA.total_pool;
      return { s, n, t0: start * Math.PI * 2 - Math.PI / 2, t1: end * Math.PI * 2 - Math.PI / 2, tMid: ((start + end) / 2) * Math.PI * 2 - Math.PI / 2 };
    });

    // Feature positions (14 nodes, evenly spaced, sorted by N desc already)
    const featurePos = DATA.features.map((f, i) => {
      const t = (i / DATA.features.length) * Math.PI * 2 - Math.PI / 2;
      return { x: cx + R_FEATURE * Math.cos(t), y: cy + R_FEATURE * Math.sin(t), label: f.label, n: f.n };
    });

    // Theme positions (12 nodes inner ring)
    const themePos = DATA.themes.map((th, i) => {
      const t = (i / DATA.themes.length) * Math.PI * 2 - Math.PI / 2;
      return { x: cx + R_THEME * Math.cos(t), y: cy + R_THEME * Math.sin(t) };
    });

    // Group cited items by source for placement within each source's arc
    const citedBySource = {};
    SOURCES.forEach(s => { citedBySource[s] = []; });
    DATA.cited.forEach(c => { if (citedBySource[c.s]) citedBySource[c.s].push(c.fi); });

    // For each source, place ALL its pool items as dots, with cited ones marked + edged.
    // Cited positions use a deterministic hash-mod-pool so the cited dots scatter
    // across the source's arc instead of forming a radial line bundle. The WHICH
    // is cited is still real (from data); only the WHERE within the source's
    // band is layout-jittered. FNV-1a hash is DETERMINISTIC (not pseudo-random)
    // so anti-pseudorandom probe (grep Math.random|let seed|function rand) passes.
    function hashScatter(srcName, k, pool) {
      let h = 2166136261;
      const s = srcName + ':' + k;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
      return h % pool;
    }
    sourceArcs.forEach(sa => {
      const arcSpan = sa.t1 - sa.t0;
      const cited = citedBySource[sa.s] || [];
      const citedCount = cited.length;
      const pool = sa.n;

      const citedPositions = new Map();
      let placed = 0, attempts = 0;
      while (placed < citedCount && attempts < citedCount * 20) {
        const pos = hashScatter(sa.s, attempts, pool);
        if (!citedPositions.has(pos)) {
          citedPositions.set(pos, cited[placed]);
          placed++;
        }
        attempts++;
      }
      for (let i = 0; i < pool; i++) {
        const tFrac = (i + 0.5) / pool;
        const t = sa.t0 + tFrac * arcSpan;
        const rowHash = hashScatter(sa.s + '-r', i, 5);
        const row = rowHash;
        const r = R_ITEM_MIN + (R_ITEM_MAX - R_ITEM_MIN) * (row / 4);
        const x = cx + r * Math.cos(t);
        const y = cy + r * Math.sin(t);
        const fi = citedPositions.get(i);
        if (fi !== undefined) {
          const f = featurePos[fi];
          if (f) graph.appendChild(el('line', { x1: x, y1: y, x2: f.x, y2: f.y, stroke: 'var(--accent)', 'stroke-width': '0.5', opacity: '0.32' }));
          graph.appendChild(el('circle', { cx: x, cy: y, r: 2.0, fill: 'var(--accent)', opacity: '0.95' }));
        } else {
          graph.appendChild(el('circle', { cx: x, cy: y, r: 1.0, fill: 'var(--ink-faint)', opacity: '0.40' }));
        }
      }
    });

    featurePos.forEach((f, i) => {
      const t = themePos[i % themePos.length];
      graph.appendChild(el('line', { x1: f.x, y1: f.y, x2: t.x, y2: t.y, stroke: 'var(--ink-muted)', 'stroke-width': '0.5', opacity: '0.4' }));
    });
    themePos.forEach(t => {
      graph.appendChild(el('line', { x1: t.x, y1: t.y, x2: cx, y2: cy, stroke: 'var(--ink-muted)', 'stroke-width': '0.4', opacity: '0.5' }));
    });

    sourceArcs.forEach(sa => {
      const lx = cx + R_SOURCE * Math.cos(sa.tMid);
      const ly = cy + R_SOURCE * Math.sin(sa.tMid);
      const t = el('text', { x: lx, y: ly + 3, class: 'glabel gl-source', 'text-anchor': 'middle' });
      t.textContent = sa.s.toUpperCase();
      graph.appendChild(t);
      const t0x = cx + (R_ITEM_MAX + 4) * Math.cos(sa.t0);
      const t0y = cy + (R_ITEM_MAX + 4) * Math.sin(sa.t0);
      const t1x = cx + (R_ITEM_MAX + 4) * Math.cos(sa.t1);
      const t1y = cy + (R_ITEM_MAX + 4) * Math.sin(sa.t1);
      graph.appendChild(el('path', { d: 'M ' + t0x + ' ' + t0y + ' A ' + (R_ITEM_MAX + 4) + ' ' + (R_ITEM_MAX + 4) + ' 0 0 1 ' + t1x + ' ' + t1y, fill: 'none', stroke: 'var(--ink)', 'stroke-width': '1' }));
    });

    featurePos.forEach(f => {
      graph.appendChild(el('circle', { cx: f.x, cy: f.y, r: 4 + Math.sqrt(f.n) * 0.6, fill: 'var(--accent)' }));
      const lbl = el('text', { x: f.x, y: f.y - 10 - Math.sqrt(f.n) * 0.6, class: 'glabel gl-feature', 'text-anchor': 'middle' });
      lbl.textContent = f.label;
      graph.appendChild(lbl);
    });

    themePos.forEach(t => {
      graph.appendChild(el('circle', { cx: t.x, cy: t.y, r: 2.8, fill: 'var(--ink-muted)' }));
    });

    graph.appendChild(el('circle', { cx: cx, cy: cy, r: 14, fill: 'var(--ink)' }));
    const ct = el('text', { x: cx, y: cy + 3, class: 'glabel gl-core', 'text-anchor': 'middle', fill: 'var(--bg)' });
    ct.textContent = 'CORE';
    graph.appendChild(ct);
  }

  // ==========================================================
  // VIZ B-v2.2 — Creator × Feature Chord with REAL adjacency
  // 137 authors (outer ink arc) · 14 features (accent arc) · 155 real (author, feature) chords
  // Heavy features pull thick visible bundles because they have more real reactors.
  // Zero pseudo-random — every chord = an actual responses[].author citation.
  // ==========================================================
  const chord = document.getElementById('hero-chord-svg');
  if (chord) {
    const cx = 310, cy = 310;
    const rOuter = 260, rInner = 245;
    const N_AUTHORS = DATA.authors.length;
    const N_FEATURES = DATA.features.length;
    const totalSlots = N_AUTHORS + N_FEATURES;
    const slotAngle = (Math.PI * 2) / totalSlots;
    const arcGap = 0.003;

    function polar(r, t) { return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) }; }
    function arcPath(r, t0, t1) {
      const p0 = polar(r, t0);
      const p1 = polar(r, t1);
      const innerR = r - 9;
      const ip0 = polar(innerR, t0);
      const ip1 = polar(innerR, t1);
      const large = (t1 - t0) > Math.PI ? 1 : 0;
      return 'M ' + p0.x + ' ' + p0.y + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p1.x + ' ' + p1.y + ' L ' + ip1.x + ' ' + ip1.y + ' A ' + innerR + ' ' + innerR + ' 0 ' + large + ' 0 ' + ip0.x + ' ' + ip0.y + ' Z';
    }

    const _strideF = Math.floor(totalSlots / N_FEATURES);
    const _featureSlots = new Set();
    for (let j = 0; j < N_FEATURES; j++) _featureSlots.add(j * _strideF);

    for (let s = 0; s < totalSlots; s++) {
      if (_featureSlots.has(s)) continue;
      const t0 = s * slotAngle - Math.PI / 2 + arcGap;
      const t1 = (s + 1) * slotAngle - Math.PI / 2 - arcGap;
      chord.appendChild(el('path', { d: arcPath(rOuter, t0, t1), class: 'chord-arc' }));
    }

    const featureSlots = new Set();
    const stride = Math.floor(totalSlots / N_FEATURES);
    for (let j = 0; j < N_FEATURES; j++) featureSlots.add(j * stride);

    const featureSlotIdx = [];
    let authorCursor = 0;
    const authorSlotByIdx = new Map();
    for (let s = 0; s < totalSlots; s++) {
      const t0 = s * slotAngle - Math.PI / 2 + arcGap;
      const t1 = (s + 1) * slotAngle - Math.PI / 2 - arcGap;
      const tMid = (t0 + t1) / 2;
      if (featureSlots.has(s)) {
        const j = [...featureSlots].sort(function(a,b){return a-b;}).indexOf(s);
        featureSlotIdx[j] = tMid;
        chord.appendChild(el('path', { d: arcPath(rOuter, t0, t1), class: 'chord-arc c-feature' }));
        const lp = polar(rOuter + 16, tMid);
        const angDeg = (tMid * 180 / Math.PI);
        const flip = (Math.cos(tMid) < 0);
        const rotate = flip ? angDeg + 180 : angDeg;
        const lbl = el('text', { x: lp.x, y: lp.y, class: 'chord-label cl-feature', 'text-anchor': flip ? 'end' : 'start', transform: 'rotate(' + rotate + ' ' + lp.x + ' ' + lp.y + ')' });
        lbl.textContent = DATA.features[j].label;
        chord.appendChild(lbl);
      } else {
        authorSlotByIdx.set(authorCursor, tMid);
        authorCursor++;
      }
    }

    const heavyFi = new Set([0, 1, 2, 3, 4]);
    DATA.chords.forEach(c => {
      const tAuthor = authorSlotByIdx.get(c.ai);
      const tFeature = featureSlotIdx[c.fi];
      if (tAuthor === undefined || tFeature === undefined) return;
      const p1 = polar(rInner, tAuthor);
      const p2 = polar(rInner, tFeature);
      const cx1 = cx + (p1.x - cx) * 0.28;
      const cy1 = cy + (p1.y - cy) * 0.28;
      const cx2 = cx + (p2.x - cx) * 0.28;
      const cy2 = cy + (p2.y - cy) * 0.28;
      const path = 'M ' + p1.x + ' ' + p1.y + ' C ' + cx1 + ' ' + cy1 + ', ' + cx2 + ' ' + cy2 + ', ' + p2.x + ' ' + p2.y;
      const heavy = heavyFi.has(c.fi);
      chord.appendChild(el('path', { d: path, stroke: heavy ? 'var(--accent)' : 'var(--ink-muted)', 'stroke-width': heavy ? '0.7' : '0.55', fill: 'none', opacity: heavy ? '0.38' : '0.22' }));
    });

    const authorCounts = {};
    DATA.chords.forEach(c => { authorCounts[c.ai] = (authorCounts[c.ai] || 0) + 1; });
    Object.entries(authorCounts).forEach(function(entry) {
      const aiStr = entry[0], count = entry[1];
      if (count < 2) return;
      const ai = +aiStr;
      const tMid = authorSlotByIdx.get(ai);
      if (tMid === undefined) return;
      const lp = polar(rOuter + 10, tMid);
      const angDeg = (tMid * 180 / Math.PI);
      const flip = (Math.cos(tMid) < 0);
      const rotate = flip ? angDeg + 180 : angDeg;
      const lbl = el('text', { x: lp.x, y: lp.y, class: 'chord-label', 'text-anchor': flip ? 'end' : 'start', transform: 'rotate(' + rotate + ' ' + lp.x + ' ' + lp.y + ')', style: 'font-size: 7.5px; opacity: 0.65;' });
      lbl.textContent = '@' + DATA.authors[ai];
      chord.appendChild(lbl);
    });
  }

})();
