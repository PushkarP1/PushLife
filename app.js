/* A Life on the Map: functional wireframe.
   One dataset (data.json) drives four modes: Timeline, Map, Locations, Print.
   Overview first (everything visible at "now"), zoom and filter, details on demand. */
(() => {
'use strict';

const WORLD = 'lib/countries-50m.json';
const STORE = 'lifemap.data.v1';
const DAY_COLORS = ['#D4A08A', '#CDB98A', '#93B3AB', '#A9B4CF', '#C3A9C4', '#B8C49A'];
const NIGHT_COLORS = ['#F4B79E', '#EED7A0', '#A3DDD0', '#B9C6F2', '#E1BDE6', '#CFE3A6'];   // same hues, lifted to glow on black
const THEME_KEY = 'pushlife.theme.v2';
const TRAIL_FADE = 1.5;   // seconds for a light trail to fade to ~37%
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ZOOM_CITIES = 3, ZOOM_PLACES = 6;
const PAPER = { a3p:[297,420], a3l:[420,297], a4p:[210,297], p1824:[457.2,609.6], letterl:[279.4,215.9] };

const $ = s => document.querySelector(s);
const now = new Date();
const NOW_M = now.getFullYear() * 12 + now.getMonth();
const ym = s => { const [y, m] = String(s).split('-').map(Number); return y * 12 + ((m || 1) - 1); };
const ymStr = m => `${Math.floor(m / 12)}-${String(m % 12 + 1).padStart(2, '0')}`;
const fmtM = m => `${MONTHS[((m % 12) + 12) % 12]} ${Math.floor(m / 12)}`;
const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const ease = d3.easeCubicInOut;
// Moves bow upward as a smooth planar arc, so long hops (e.g. Dubai to Vancouver) never wrap over the pole.
const bowArc = (pr, a, b) => {
  const p = pr([+a.lng, +a.lat]), q = pr([+b.lng, +b.lat]);
  const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2, dx = q[0] - p[0], dy = q[1] - p[1];
  let nx = -dy, ny = dx; if (ny > 0) { nx = -nx; ny = -ny; }
  const f = 0.22;
  return `M${p[0]},${p[1]}Q${mx + nx * f},${my + ny * f} ${q[0]},${q[1]}`;
};
const geoLine = (a, b) => ({ type: 'LineString', coordinates: [[+a.lng, +a.lat], [+b.lng, +b.lat]] });

const ATTRACT_YEAR = 1990; // ambient loop starts and restarts here
const attractStart = () => Math.max(D.birth, Math.min(D.end, ATTRACT_YEAR * 12));
const S = { data: null, base: null, mode: 'map', theme: 'night', t: NOW_M, attract: false, tf: NOW_M, hold: 0, playing: false, sel: null, visit: 0,
            k: 1, zt: d3.zoomIdentity, land: null, expanded: new Set(), etab: 'trips', efilter: '' };
let D = null;

/* ---------- data ---------- */
function derive() {
  const d = S.data;
  const birth = ym(d.profile.birth || d.homes[0]?.start || '1980-01');
  const homes = d.homes.filter(h => h.start).map(h => ({ ...h, src: h, startM: ym(h.start), endM: h.end ? ym(h.end) : NOW_M }))
    .sort((a, b) => a.startM - b.startM);
  const pal = S.theme === 'night' ? NIGHT_COLORS : DAY_COLORS;
  homes.forEach((h, i) => { h.color = pal[i % pal.length]; h.dayColor = DAY_COLORS[i % DAY_COLORS.length]; });
  const homeAt = m => { let r = homes[0]; for (const h of homes) if (h.startM <= m) r = h; return r; };
  const trips = d.trips.filter(t => t.start && isFinite(+t.lat) && isFinite(+t.lng) && t.city)
    .map(t => { const m = ym(t.start); return { ...t, src: t, m, home: homeAt(m), key: slug(`${t.city}-${t.country}`) }; })
    .sort((a, b) => a.m - b.m);
  const dm = new Map();
  for (const t of trips) {
    let x = dm.get(t.key);
    if (!x) { x = { key: t.key, city: t.city, country: t.country, lat: +t.lat, lng: +t.lng, trips: [] }; dm.set(t.key, x); }
    x.trips.push(t);
  }
  const dests = [...dm.values()];
  dests.forEach(x => {
    x.first = x.trips[0].m;
    const seen = new Map();
    x.trips.forEach(t => (t.places || []).forEach(p => {
      if (!p.name) return;
      const q = seen.get(p.name);
      if (!q) { seen.set(p.name, { ...p, media: [...(p.media || [])], trip: t }); return; }
      if (p.note && !(q.note || '').includes(p.note)) q.note = q.note ? `${q.note}\n${p.note}` : p.note;
      // real media first, placeholders only if nothing real exists
      q.media = [...q.media, ...(p.media || [])];
      const real = q.media.filter(m => m.url);
      if (real.length) q.media = real;
    }));
    x.places = [...seen.values()];
  });
  const moves = [];
  for (let i = 1; i < homes.length; i++) moves.push({ from: homes[i - 1], to: homes[i], m: homes[i].startM });
  const moments = (d.moments || []).filter(x => x.date).map(x => ({ ...x, src: x, m: ym(x.date) })).sort((a, b) => a.m - b.m);
  const events = [...trips.map(t => ({ type: 'trip', m: t.m, trip: t })), ...moves.map(v => ({ type: 'move', m: v.m, move: v }))]
    .sort((a, b) => a.m - b.m || (a.type === 'move' ? -1 : 1));
  trips.forEach(t => t.km = 2 * d3.geoDistance([+t.home.lng, +t.home.lat], [+t.lng, +t.lat]) * 6371);
  moves.forEach(v => v.km = d3.geoDistance([+v.from.lng, +v.from.lat], [+v.to.lng, +v.to.lat]) * 6371);
  const km = trips.reduce((s, t) => s + t.km, 0) + moves.reduce((s, v) => s + v.km, 0);
  const countries = new Set([...homes.map(h => h.country), ...trips.map(t => t.country)].filter(Boolean));
  D = { birth, end: NOW_M, homes, homeAt, trips, dests, moves, moments, events, km, countries };
}

function saveLocal() { try { localStorage.setItem(STORE, JSON.stringify(S.data)); } catch (e) {} }

/* ---------- stats + header ---------- */
let lastStats = '';
function renderHeader() {
  lastStats = '';
  const p = S.data.profile;
  $('#subtitle').textContent = `${p.name || ''} · ${Math.floor(D.birth / 12)} to ${now.getFullYear()} · ${D.homes.map(h => h.city).join(' → ')}`;
  $('#stats').innerHTML = ['Years', 'Homes', 'Countries', 'Cities', 'Trips', 'km travelled'].map(l => `<div class="stat"><b></b><span>${l}</span></div>`).join('') +
    `<div class="legend">${D.homes.map(h => `<span><i style="background:${h.color}"></i>${esc(h.city)}</span>`).join('')}
     <span><i style="background:var(--ink);border-radius:1px;transform:rotate(45deg) scale(.8)"></i>Key moment</span></div>`;
}

/* Stats follow the playhead: everything counted up to the month on screen. */
function updateStats() {
  if (!D) return;
  const t = S.t;
  const hs = D.homes.filter(h => h.startM <= t), ts = D.trips.filter(x => x.m <= t);
  const countries = new Set([...hs.map(h => h.country), ...ts.map(x => x.country)].filter(Boolean)).size;
  const cities = new Set([...hs.map(h => slug(`${h.city}-${h.country}`)), ...ts.map(x => x.key)]).size;
  const km = ts.reduce((s, x) => s + x.km, 0) + D.moves.filter(v => v.m <= t).reduce((s, v) => s + v.km, 0);
  const vals = [Math.max(0, Math.floor((t - D.birth) / 12)), hs.length, countries, cities, ts.length, d3.format(',')(Math.round(km / 100) * 100)];
  const key = vals.join('|');
  if (key === lastStats) return;
  lastStats = key;
  document.querySelectorAll('#stats .stat b').forEach((b, i) => { if (b.textContent !== String(vals[i])) b.textContent = vals[i]; });
}

/* ---------- map ---------- */
const svg = d3.select('#map');
let W, H, proj, gpath, gRoot, zoom, L = {};

function buildMap(onlyIfResized) {
  const el = svg.node();
  if (onlyIfResized && gRoot && el.clientWidth === W && el.clientHeight === H) return;
  W = el.clientWidth; H = el.clientHeight;
  if (!W || !H) return;
  clearFlights();
  svg.attr('viewBox', `0 0 ${W} ${H}`).selectAll('*').remove();
  const defs = svg.append('defs');
  const f = defs.append('filter').attr('id', 'glow').attr('x', '-100%').attr('y', '-100%').attr('width', '300%').attr('height', '300%');
  f.append('feGaussianBlur').attr('stdDeviation', 3);
  const sg = defs.append('filter').attr('id', 'starglow').attr('x', '-200%').attr('y', '-200%').attr('width', '500%').attr('height', '500%');
  sg.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', 2.2).attr('result', 'b');
  const mg = sg.append('feMerge'); mg.append('feMergeNode').attr('in', 'b'); mg.append('feMergeNode').attr('in', 'b'); mg.append('feMergeNode').attr('in', 'SourceGraphic');
  // night sky: a fixed field of faint background stars (screen space, seeded so it never jumps)
  const rnd = d3.randomLcg(42), stars = svg.append('g').attr('class', 'stars');
  for (let i = 0; i < Math.round(W * H / 2600); i++) {
    stars.append('circle').attr('cx', rnd() * W).attr('cy', rnd() * H).attr('r', .35 + rnd() * .75)
      .style('animation-delay', `${(-rnd() * 7).toFixed(2)}s`).style('animation-duration', `${(4 + rnd() * 6).toFixed(2)}s`);
  }
  sizeTrails();
  proj = d3.geoNaturalEarth1().fitExtent([[16, 16], [W - 16, H - 16]], S.fitLand);
  gpath = d3.geoPath(proj);
  gRoot = svg.append('g');
  gRoot.append('path').datum({ type: 'Sphere' }).attr('class', 'sphere').attr('d', gpath);
  gRoot.append('path').datum(S.land).attr('class', 'land').attr('d', gpath);
  ['arcs', 'moves', 'fx', 'dests', 'homes', 'moments', 'places', 'labels', 'you'].forEach(n => L[n] = gRoot.append('g').attr('class', 'layer-' + n));
  L.labels.attr('class', 'layer-places');

  L.arcs.selectAll('path').data(D.trips, d => d.id).join('path').attr('class', 'arc')
    .attr('stroke', d => d.home.color).attr('d', d => gpath(geoLine(d.home, d)));
  L.moves.selectAll('path').data(D.moves).join('path').attr('class', 'move').attr('stroke', d => d.to.color).attr('d', d => bowArc(proj, d.from, d.to));

  const P = d => proj([+d.lng, +d.lat]);
  const tw = d3.randomLcg(7);
  L.dests.selectAll('circle').data(D.dests, d => d.key).join('circle').attr('class', 'dest')
    .attr('cx', d => P(d)[0]).attr('cy', d => P(d)[1])
    .style('animation-delay', () => `${(-tw() * 6).toFixed(2)}s`)
    .on('mouseenter', (e, d) => tip(e, `<b>${esc(d.city)}</b>, ${esc(d.country)} · ${d.trips.length} visit${d.trips.length > 1 ? 's' : ''}`))
    .on('mousemove', moveTip).on('mouseleave', hideTip)
    .on('click', (e, d) => { e.stopPropagation(); select({ type: 'dest', key: d.key }, true); });

  const hg = L.homes.selectAll('g').data(D.homes, d => d.id).join('g').attr('class', 'home')
    .attr('transform', d => `translate(${P(d)})`)
    .on('mouseenter', (e, d) => tip(e, `<b>Home · ${esc(d.city)}</b> · ${fmtM(d.startM)} to ${d.end ? fmtM(d.endM) : 'now'}`))
    .on('mousemove', moveTip).on('mouseleave', hideTip)
    .on('click', (e, d) => { e.stopPropagation(); select({ type: 'home', id: d.id }, true); });
  hg.append('circle').attr('class', 'ring').attr('stroke', d => d.color);
  hg.append('circle').attr('class', 'core').attr('fill', d => d.color);

  L.moments.selectAll('rect').data(D.moments, d => d.id).join('rect').attr('class', 'moment')
    .attr('transform', d => { const p = P(d); return `translate(${p}) rotate(45)`; })
    .on('mouseenter', (e, d) => tip(e, `<b>${esc(d.title)}</b> · ${fmtM(d.m)}${d.city ? ' · ' + esc(d.city) : ''}`))
    .on('mousemove', moveTip).on('mouseleave', hideTip);

  const places = D.dests.flatMap(x => x.places.filter(p => isFinite(+p.lat) && isFinite(+p.lng)).map(p => ({ ...p, dest: x })));
  L.places.attr('class', 'layer-places');
  L.places.selectAll('circle').data(places).join('circle').attr('class', 'place')
    .attr('cx', d => P(d)[0]).attr('cy', d => P(d)[1])
    .on('mouseenter', (e, d) => tip(e, `<b>${esc(d.name)}</b> · ${esc(d.dest.city)}`))
    .on('mousemove', moveTip).on('mouseleave', hideTip)
    .on('click', (e, d) => { e.stopPropagation(); select({ type: 'dest', key: d.dest.key, place: d.name }, false); });
  L.places.selectAll('text').data(places).join('text').attr('class', 'placeLabel')
    .attr('x', d => P(d)[0]).attr('y', d => P(d)[1]).text(d => d.name);
  L.labels.selectAll('text').data([...D.dests, ...D.homes]).join('text').attr('class', 'cityLabel')
    .attr('x', d => P(d)[0]).attr('y', d => P(d)[1]).text(d => d.city);

  const you = L.you.append('g').attr('class', 'you');
  you.append('circle').attr('class', 'halo');
  you.append('circle').attr('class', 'core');

  zoom = d3.zoom().scaleExtent([1, 1200]).translateExtent([[0, 0], [W, H]])
    .on('zoom', e => { S.zt = e.transform; S.k = e.transform.k; gRoot.attr('transform', e.transform); applyScale(); clearTrails(); });
  svg.call(zoom).on('click', () => { if (S.sel) select(null); });
  svg.call(zoom.transform, S.zt);
  update();
  if (S.afterBuild) { const f = S.afterBuild; S.afterBuild = null; f(); }
}

function rDest(d) { const n = d.trips.filter(t => t.m <= S.t).length; return 2.2 + Math.sqrt(n) * (S.mode === 'locations' ? 2.2 : 1.4); }

function applyScale() {
  if (!gRoot) return;
  const k = S.k;
  L.dests.selectAll('circle').attr('r', d => rDest(d) / k);
  L.homes.selectAll('.core').attr('r', 5.5 / k);
  L.homes.selectAll('.ring').attr('r', 5.5 / k);
  L.moments.selectAll('rect').attr('x', -3 / k).attr('y', -3 / k).attr('width', 6 / k).attr('height', 6 / k);
  L.places.selectAll('circle').attr('r', 3.5 / k);
  L.places.selectAll('text').style('font-size', (10.5 / k) + 'px').attr('dx', 6 / k).attr('dy', 3.5 / k).style('stroke-width', 3 / k);
  L.labels.selectAll('text').style('font-size', (11.5 / k) + 'px').attr('dx', 8 / k).attr('dy', -6 / k).style('stroke-width', 3 / k);
  L.you.select('.halo').attr('r', 11 / k);
  L.you.select('.core').attr('r', 4.5 / k);
  svg.select('#glow feGaussianBlur').attr('stdDeviation', 3 / k);
  svg.select('#starglow feGaussianBlur').attr('stdDeviation', 2.2 / k);
  const w = $('#mapWrap');
  w.classList.toggle('zoomed', k >= ZOOM_CITIES);
  L.places.style('display', k >= ZOOM_PLACES ? null : 'none');
}

function moveYou(x, y) { L.you.select('.you').attr('transform', `translate(${x},${y})`); }

function update() {
  if (!gRoot) return;
  const t = S.t, loc = S.mode === 'locations';
  L.arcs.style('display', loc ? 'none' : null);
  L.moves.style('display', loc ? 'none' : null);
  L.arcs.selectAll('path')
    .style('display', d => d.m <= t ? null : 'none')
    .classed('recent', d => t - d.m <= 6 && t < D.end);
  L.moves.selectAll('path').style('display', d => d.m <= t ? null : 'none');
  L.dests.selectAll('circle').style('display', d => d.first <= t ? null : 'none')
    .attr('fill', d => { const v = d.trips.filter(x => x.m <= t); return (v[v.length - 1] || d.trips[0]).home.color; })
    .classed('sel', d => S.sel?.type === 'dest' && S.sel.key === d.key);
  L.labels.selectAll('text').style('display', d => (d.first ?? d.startM) <= t ? null : 'none');
  L.places.selectAll('circle,text').style('display', d => d.dest.first <= t ? null : 'none');
  const cur = D.homeAt(t);
  L.homes.selectAll('g.home').style('display', d => d.startM <= t ? null : 'none').classed('active', d => d === cur);
  L.moments.selectAll('rect').style('display', d => d.m <= t ? null : 'none');
  if (cur) moveYou(...proj([cur.lng, cur.lat]));
  L.you.style('display', loc ? 'none' : null);
  applyScale();
  updateTimeline();
  readout();
  updateStats();
}

function flash(d) {
  if (!gRoot) return;
  const [x, y] = proj([+d.lng, +d.lat]), k = S.k;
  L.fx.append('circle').attr('class', 'flash').attr('cx', x).attr('cy', y).attr('r', 2 / k).attr('stroke-width', 1.5)
    .style('opacity', 1).transition().duration(1100).ease(d3.easeCubicOut).attr('r', 22 / k).style('opacity', 0).remove();
}

function zoomTo(lng, lat, k) {
  const [x, y] = proj([+lng, +lat]);
  svg.transition().duration(900).call(zoom.transform, d3.zoomIdentity.translate(W / 2 - (S.sel ? 150 : 0), H / 2).scale(k).translate(-x, -y));
}

/* ---------- timeline ---------- */
const tsvg = d3.select('#timeline');
let tx, TW, TH, TL = {};

function buildTimeline(onlyIfResized) {
  const el = tsvg.node();
  if (onlyIfResized && TL.ph && el.clientWidth === TW && el.clientHeight === TH) return;
  TW = el.clientWidth; TH = el.clientHeight;
  if (!TW || !TH) return;
  tsvg.attr('viewBox', `0 0 ${TW} ${TH}`).selectAll('*').remove();
  const big = S.mode === 'timeline', pad = 16;
  tx = d3.scaleLinear([D.birth, D.end + 1], [pad, TW - pad]).clamp(true);
  const axisY = TH - 16, bandH = big ? 22 : 14, bandY = axisY - 8 - bandH;

  const ax = tsvg.append('g').attr('class', 'axis');
  const y0 = Math.floor(D.birth / 12), y1 = Math.floor(D.end / 12);
  const step = TW < 600 ? 10 : 5;
  for (let y = y0; y <= y1; y++) {
    const x = tx(y * 12);
    ax.append('line').attr('x1', x).attr('x2', x).attr('y1', axisY - 4).attr('y2', axisY - (y % step === 0 ? 0 : 2));
    if (y % step === 0) ax.append('text').attr('x', x).attr('y', axisY + 11).attr('text-anchor', 'middle').text(y);
  }

  const bands = tsvg.append('g');
  bands.selectAll('rect').data(D.homes).join('rect').attr('class', 'band').attr('rx', 4)
    .attr('x', d => tx(d.startM)).attr('width', d => Math.max(1, tx(d.endM + 1) - tx(d.startM) - 1))
    .attr('y', bandY).attr('height', bandH).attr('fill', d => d.color)
    .style('cursor', 'pointer')
    .on('pointerdown', (e, d) => { e.stopPropagation(); select({ type: 'home', id: d.id }, true); })
    .on('mouseenter', (e, d) => tip(e, `<b>${esc(d.city)}</b> · ${fmtM(d.startM)} to ${d.end ? fmtM(d.endM) : 'now'}`))
    .on('mousemove', moveTip).on('mouseleave', hideTip);
  bands.selectAll('text').data(D.homes.filter(d => tx(d.endM) - tx(d.startM) > 60)).join('text').attr('class', 'bandLabel')
    .attr('x', d => tx(d.startM) + (big ? 8 : 14)).attr('y', bandY + bandH / 2 + 4).text(d => d.city);

  // trips: stacked dots per year (big) or short ticks (compact)
  const perYear = {};
  const tg = tsvg.append('g');
  TL.ticks = tg.selectAll('g').data(D.trips).join('g').attr('class', 'tick')
    .on('pointerdown', (e, d) => { e.stopPropagation(); pause(); S.t = d.m; syncTime(); select({ type: 'dest', key: d.key }, true); update(); writeHash(); })
    .on('mouseenter', (e, d) => tip(e, `<b>${esc(d.city)}</b>, ${esc(d.country)} · ${fmtM(d.m)}`))
    .on('mousemove', moveTip).on('mouseleave', hideTip);
  TL.ticks.each(function (d) {
    const y = Math.floor(d.m / 12), i = perYear[y] = (perYear[y] ?? -1) + 1, g = d3.select(this), x = tx(d.m + .5);
    if (big) g.append('circle').attr('cx', x).attr('cy', bandY - 9 - i * 9).attr('r', 3.2).attr('fill', d.home.color);
    else g.append('rect').attr('x', x - 1).attr('width', 2).attr('y', bandY - 6 - i * 5).attr('height', 4).attr('fill', d.home.color);
    g.append('rect').attr('x', x - 4).attr('width', 8).attr('y', bandY - (big ? 14 : 8) - i * (big ? 9 : 5)).attr('height', big ? 10 : 7).attr('fill', 'transparent');
  });

  // key moments
  const mg = tsvg.append('g');
  TL.mk = mg.selectAll('g').data(D.moments).join('g')
    .on('mouseenter', (e, d) => tip(e, `<b>${esc(d.title)}</b> · ${fmtM(d.m)}`))
    .on('mousemove', moveTip).on('mouseleave', hideTip);
  TL.mk.each(function (d, i) {
    const g = d3.select(this), x = tx(d.m + .5);
    const y = big ? 16 + (i % 2) * 16 : bandY + bandH + 6;
    if (big) g.append('line').attr('x1', x).attr('x2', x).attr('y1', y).attr('y2', bandY).attr('stroke', 'var(--line)');
    g.append('rect').attr('class', 'mk').attr('width', 7).attr('height', 7)
      .attr('transform', `translate(${x},${y - 5}) rotate(45)`).attr('fill', big ? 'var(--ink)' : 'var(--panel)')
      .attr('stroke', 'var(--ink)').attr('stroke-width', big ? 0 : 1.2);
    if (big) g.append('text').attr('class', 'mkLabel').attr('x', x + 9).attr('y', y + 3.5).text(d.title);
  });

  TL.ph = tsvg.append('g').attr('class', 'playhead').style('pointer-events', 'none');
  TL.ph.append('line').attr('y1', 4).attr('y2', axisY);
  TL.ph.append('circle').attr('cy', 4).attr('r', 4);

  const scrub = e => { const r = el.getBoundingClientRect(); S.t = Math.round(Math.max(D.birth, Math.min(D.end, tx.invert((e.clientX - r.left) * TW / r.width)))); syncTime(); update(); };
  tsvg.on('pointerdown', e => { pause(); el.setPointerCapture(e.pointerId); scrub(e);
    tsvg.on('pointermove', scrub).on('pointerup pointercancel', () => { tsvg.on('pointermove', null).on('pointerup pointercancel', null); writeHash(); }); });
  updateTimeline();
}

function updateTimeline() {
  if (!TL.ph || !tx) return;
  TL.ph.attr('transform', `translate(${tx(S.t + .5)},0)`);
  TL.ticks.classed('future', d => d.m > S.t);
  TL.mk.selectAll('.mk').classed('future', d => d.m > S.t);
}

function readout() {
  const t = S.t, h = D.homeAt(t), n = D.trips.filter(x => x.m <= t).length;
  const living = h && t >= h.startM ? `Living in <b>${esc(h.city)}</b>` : '';
  $('#rdMonth').textContent = MONTHS[t % 12];
  const yj = $('#yearJump');
  if (document.activeElement !== yj) { yj.value = Math.floor(t / 12); yj.classList.remove('bad'); }
  $('#readout').innerHTML = [living, `${n} trip${n === 1 ? '' : 's'} so far`].filter(Boolean).join(' · ');
  $('#nowLabel').innerHTML = `<b>${Math.floor(t / 12)}</b>${h ? esc(h.city) : ''}`;
}

/* ---------- playback ----------
   Time runs continuously. Each trip or move launches a "flight": a glowing comet that travels
   its arc (out and back for trips) while the arc draws in behind it. */
const SPEED = { map: 0.55, timeline: 1.2 };   // years per second
const LOOP_HOLD = 4;                           // seconds to rest on "now" before looping
let last = 0, flights = [];
function syncTime() { S.tf = S.t; S.hold = 0; }
function play() {
  if (S.mode === 'print') return;
  if (S.mode === 'locations') setMode('map');
  if (S.t >= D.end) S.t = D.birth;
  syncTime();
  S.playing = true; last = performance.now(); $('#playBtn').textContent = '❚❚'; $('#playBtn').setAttribute('aria-label', 'Pause');
  update();
  requestAnimationFrame(loop);
}
function pause() {
  if (!S.playing) return;
  S.playing = false; $('#playBtn').textContent = '▶'; $('#playBtn').setAttribute('aria-label', 'Play');
  clearFlights();
  update(); writeHash();
}
function loop(ts) {
  if (!S.playing) return;
  const dt = Math.min(0.1, (ts - last) / 1000); last = ts;
  stepTime(dt);
  tickFlights(dt);
  if (S.playing) requestAnimationFrame(loop);
}
function stepTime(dt) {
  if (S.t >= D.end) {
    if (!S.attract) { if (!flights.length) pause(); return; }
    S.hold += dt;
    if (S.hold >= LOOP_HOLD) { clearFlights(); S.t = attractStart(); syncTime(); update(); }
    return;
  }
  const prev = S.t;
  S.tf += dt * 12 * (SPEED[S.mode] || 1);
  const nt = Math.min(D.end, Math.floor(S.tf));
  if (nt !== prev) {
    S.t = nt;
    D.events.forEach(e => { if (e.m > prev && e.m <= nt) launch(e); });
    update();
  }
}
function launch(ev) {
  if (!gRoot || S.mode === 'locations') return;
  const isMove = ev.type === 'move';
  const sel = isMove ? L.moves.selectAll('path').filter(d => d === ev.move) : L.arcs.selectAll('path').filter(d => d === ev.trip);
  const el = sel.node(); if (!el) return;
  const len = el.getTotalLength(); if (!len) return;
  const g = L.fx.append('g').attr('class', 'comet');
  g.append('circle').attr('class', 'halo');
  g.append('circle').attr('class', 'core').attr('fill', isMove ? ev.move.to.color : ev.trip.home.color);
  flights.push({ ev, sel, el, len, g, p: 0, dur: isMove ? 3.4 : 2.0, isMove });
}
function tickFlights(dt) {
  if (!flights.length) return;
  const k = S.k;
  for (const f of flights) {
    f.p += dt / f.dur;
    const p = Math.min(1, f.p);
    let pos, reveal;
    if (f.isMove) { pos = ease(p); reveal = pos; }
    else { pos = p < .5 ? ease(p / .5) : 1 - ease((p - .5) / .5); reveal = Math.min(1, p / .5); }
    f.sel.classed('drawing', true).style('stroke-dasharray', `${f.len} ${f.len}`).style('stroke-dashoffset', f.len * (1 - reveal));
    const pt = f.el.getPointAtLength(f.len * pos);
    f.g.attr('transform', `translate(${pt.x},${pt.y})`);
    const sp = S.zt.apply([pt.x, pt.y]);
    if (f.prev && Math.hypot(sp[0] - f.prev[0], sp[1] - f.prev[1]) < 200) trailSeg(f.prev, sp, f.isMove ? f.ev.move.to.color : f.ev.trip.home.color, f.isMove);
    f.prev = sp;
    f.g.select('.halo').attr('r', 10 / k);
    f.g.select('.core').attr('r', 3.6 / k);
    if (!f.isMove && !f.arrived && p >= .5) { f.arrived = true; flash(f.ev.trip); }
    if (f.p >= 1) { endFlight(f); f.done = true; }
  }
  flights = flights.filter(f => !f.done);
}
function endFlight(f) {
  f.sel.classed('drawing', false).style('stroke-dasharray', null).style('stroke-dashoffset', null);
  f.g.remove();
}
function clearFlights() { flights.forEach(endFlight); flights = []; }

/* Light trails: a canvas over the map that is never cleared outright. Each frame the comets
   paint a short glowing segment and the whole canvas fades a little, like a long exposure. */
const trailCv = document.getElementById('trails');
const tctx = trailCv.getContext('2d');
let trailUntil = 0, trailLast = 0, trailRaf = 0;
function sizeTrails() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  trailCv.width = Math.round(W * dpr); trailCv.height = Math.round(H * dpr);
  trailCv.style.width = W + 'px'; trailCv.style.height = H + 'px';
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function clearTrails() { tctx.save(); tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.clearRect(0, 0, trailCv.width, trailCv.height); tctx.restore(); }
function trailSeg(a, b, color, isMove) {
  const night = S.theme === 'night';
  tctx.save();
  tctx.globalCompositeOperation = night ? 'lighter' : 'source-over';
  tctx.lineCap = 'round';
  tctx.strokeStyle = color; tctx.shadowColor = color;
  tctx.shadowBlur = night ? 16 : 6;
  tctx.globalAlpha = night ? .85 : .55;
  tctx.lineWidth = isMove ? 2.6 : 2.1;
  tctx.beginPath(); tctx.moveTo(a[0], a[1]); tctx.lineTo(b[0], b[1]); tctx.stroke();
  tctx.restore();
  trailUntil = performance.now() + TRAIL_FADE * 4000;
  if (!trailRaf) { trailLast = performance.now(); trailRaf = requestAnimationFrame(fadeTrails); }
}
function fadeTrails(ts) {
  const dt = Math.min(.1, (ts - trailLast) / 1000); trailLast = ts;
  tctx.save();
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.globalCompositeOperation = 'destination-out';
  tctx.fillStyle = `rgba(0,0,0,${(1 - Math.exp(-dt / TRAIL_FADE)).toFixed(4)})`;
  tctx.fillRect(0, 0, trailCv.width, trailCv.height);
  tctx.restore();
  if (ts < trailUntil) trailRaf = requestAnimationFrame(fadeTrails);
  else { clearTrails(); trailRaf = 0; }
}

/* Day / Night sky */
function setTheme(t, rebuild = true) {
  S.theme = t === 'night' ? 'night' : 'day';
  document.body.classList.toggle('night', S.theme === 'night');
  const b = $('#themeBtn');
  b.setAttribute('aria-checked', S.theme === 'night');
  b.setAttribute('aria-label', S.theme === 'night' ? 'Night sky on. Switch to daylight' : 'Daylight on. Switch to night sky');
  try { localStorage.setItem(THEME_KEY, S.theme); } catch (e) {}
  if (!rebuild) return;
  clearTrails(); derive(); renderHeader();
  if (S.mode === 'print') renderPoster(); else { buildTimeline(); buildMap(); renderDetail(); }
  writeHash();
}

/* The home view runs as an ambient loop until someone interacts; the first interaction
   stops it and resets the timeline to the start. */
function stopAttract() {
  if (!S.attract) return;
  S.attract = false;
  if (S.playing) { S.playing = false; $('#playBtn').textContent = '▶'; $('#playBtn').setAttribute('aria-label', 'Play'); }
  clearFlights();
  S.t = D.birth; syncTime();
  update(); writeHash();
}

/* ---------- details on demand ---------- */
const wxCache = new Map();
async function weather(lat, lng, m) {
  const y = Math.floor(m / 12), mo = m % 12;
  const start = new Date(Date.UTC(y, mo, 1)), endD = new Date(Date.UTC(y, mo + 1, 0));
  const lim = new Date(Date.now() - 6 * 864e5);
  const end = endD > lim ? lim : endD;
  if (start > lim) return null;
  const iso = d => d.toISOString().slice(0, 10);
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${(+lat).toFixed(3)}&longitude=${(+lng).toFixed(3)}&start_date=${iso(start)}&end_date=${iso(end)}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`;
  if (!wxCache.has(url)) wxCache.set(url, fetch(url).then(r => r.ok ? r.json() : null).catch(() => null));
  const j = await wxCache.get(url);
  if (!j?.daily) return null;
  const avg = a => a.filter(v => v != null).reduce((s, v, _, A) => s + v / A.length, 0);
  return { hi: avg(j.daily.temperature_2m_max), lo: avg(j.daily.temperature_2m_min),
           rain: j.daily.precipitation_sum.filter(v => v != null).reduce((s, v) => s + v, 0) };
}

function mediaHTML(list) {
  if (!list?.length) return '';
  return `<div class="media">${list.map(m => {
    const cap = esc(m.caption || m.type);
    if (!m.url) return `<div class="ph">${m.type === 'video' ? '▶ ' : ''}${cap}</div>`;
    const yt = m.url.match(/(?:youtu\.be\/|v=)([\w-]{11})/);
    if (m.type === 'video' && yt) return `<iframe src="https://www.youtube-nocookie.com/embed/${yt[1]}" title="${cap}" allowfullscreen></iframe>`;
    if (m.type === 'video') return `<video src="${esc(m.url)}" controls preload="metadata"></video>`;
    return `<a href="${esc(m.url)}" target="_blank" rel="noopener"><img src="${esc(m.url)}" alt="${cap}" loading="lazy"></a>`;
  }).join('')}</div>`;
}

function select(sel, zoomIn) {
  S.sel = sel; S.visit = 0;
  if (sel?.type === 'dest') { const d = D.dests.find(x => x.key === sel.key); if (!d) S.sel = null; else S.visit = Math.max(0, d.trips.filter(t => t.m <= S.t).length - 1); }
  renderDetail();
  update();
  writeHash();
  if (S.sel && zoomIn && S.mode === 'locations') {
    const o = S.sel.type === 'dest' ? D.dests.find(x => x.key === S.sel.key) : D.homes.find(h => h.id === S.sel.id);
    if (o) zoomTo(o.lng, o.lat, Math.max(S.k, 40));
  }
}

function renderDetail() {
  const el = $('#detail');
  if (!S.sel) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  let html = '<button class="close" aria-label="Close">×</button>', wx = null;
  if (S.sel.type === 'dest') {
    const d = D.dests.find(x => x.key === S.sel.key);
    const v = d.trips[S.visit] || d.trips[0];
    html += `<h2>${esc(d.city)}</h2><div class="meta">${esc(d.country)} · ${d.trips.length} visit${d.trips.length > 1 ? 's' : ''} · from ${esc([...new Set(d.trips.map(t => t.home.city))].join(', '))}</div>`;
    html += `<h3>Visits</h3><div class="chips">${d.trips.map((t, i) => `<button class="chip${i === S.visit ? ' on' : ''}" data-v="${i}">${fmtM(t.m)}</button>`).join('')}</div>`;
    html += `<h3>Weather · ${fmtM(v.m)}</h3><div class="weather" id="wx"><span class="muted">Loading…</span></div>`;
    if (v.note) html += `<h3>Note</h3><p>${esc(v.note)}</p>`;
    html += `<h3>Places visited</h3>`;
    html += d.places.length ? d.places.map(p => `<div class="pl${S.sel.place === p.name ? ' hl' : ''}" data-p="${esc(p.name)}">
      <div class="n" data-lat="${p.lat}" data-lng="${p.lng}">${esc(p.name)}</div>${p.note ? `<p>${esc(p.note)}</p>` : ''}${mediaHTML(p.media)}</div>`).join('')
      : '<p class="muted">No places added yet.</p>';
    wx = [d.lat, d.lng, v.m];
  } else {
    const h = D.homes.find(x => x.id === S.sel.id);
    const yrs = ((h.endM - h.startM + 1) / 12).toFixed(1).replace('.0', '');
    const tr = D.trips.filter(t => t.home === h);
    const mo = D.moments.filter(m => m.m >= h.startM && m.m <= h.endM);
    const wm = Math.min(Math.max(S.t, h.startM), h.endM);
    html += `<h2>${esc(h.city)}</h2><div class="meta">Home · ${esc(h.country)} · ${fmtM(h.startM)} to ${h.end ? fmtM(h.endM) : 'now'} · ${yrs} years</div>`;
    html += `<h3>From here</h3><p>${tr.length} trips to ${new Set(tr.map(t => t.key)).size} places in ${new Set(tr.map(t => t.country)).size} countries</p>`;
    if (mo.length) html += `<h3>Key moments</h3>${mo.map(m => `<div class="pl"><div class="n">${esc(m.title)}</div><p>${fmtM(m.m)}${m.note ? ' · ' + esc(m.note) : ''}</p></div>`).join('')}`;
    html += `<h3>Weather · ${fmtM(wm)}</h3><div class="weather" id="wx"><span class="muted">Loading…</span></div>`;
    if (h.note) html += `<h3>Note</h3><p>${esc(h.note)}</p>`;
    html += mediaHTML(h.media);
    wx = [h.lat, h.lng, wm];
  }
  el.innerHTML = html;
  el.querySelector('.close').onclick = () => select(null);
  el.querySelectorAll('.chip').forEach(b => b.onclick = () => { S.visit = +b.dataset.v; renderDetail(); });
  el.querySelectorAll('.pl .n[data-lat]').forEach(n => n.onclick = () => zoomTo(n.dataset.lng, n.dataset.lat, 400));
  const hl = el.querySelector('.pl.hl'); if (hl) hl.scrollIntoView({ block: 'nearest' });
  const token = S.sel;
  weather(...wx).then(w => {
    const box = $('#wx'); if (!box || S.sel !== token) return;
    box.innerHTML = w ? `<div><b>${Math.round(w.hi)}°C</b><span>avg high</span></div><div><b>${Math.round(w.lo)}°C</b><span>avg low</span></div><div><b>${Math.round(w.rain)} mm</b><span>rain that month</span></div>`
      : '<span class="muted">Weather not available for this month.</span>';
  });
}

/* ---------- deep links ---------- */
function writeHash() {
  if (!D) return;
  const p = new URLSearchParams();
  p.set('mode', S.mode);
  if (S.t < D.end) p.set('t', ymStr(S.t));
  p.set('theme', S.theme);
  if (S.sel) p.set('sel', S.sel.type === 'dest' ? 'place:' + S.sel.key : 'home:' + S.sel.id);
  if (S.sel?.place) p.set('spot', slug(S.sel.place));
  try { history.replaceState(null, '', '#' + p.toString()); } catch (e) {}
}
function readHash(hash = location.hash) {
  const p = new URLSearchParams(hash.slice(1));
  const m = p.get('mode'); if (['timeline', 'map', 'locations', 'print'].includes(m)) S.mode = m;
  if (p.get('theme')) S.theme = p.get('theme') === 'night' ? 'night' : 'day';
  const t = p.get('t'); if (t && /^\d{4}-\d{2}$/.test(t)) S.t = Math.max(D.birth, Math.min(D.end, ym(t)));
  const s = p.get('sel');
  if (s) {
    const [type, id] = s.split(':');
    if (type === 'place' && D.dests.some(x => x.key === id)) {
      const d = D.dests.find(x => x.key === id), spot = p.get('spot');
      S.sel = { type: 'dest', key: id, place: spot ? d.places.find(q => slug(q.name) === spot)?.name : undefined };
    }
    if (type === 'home' && D.homes.some(h => h.id === id)) S.sel = { type: 'home', id };
  }
}

/* ---------- modes ---------- */
function setMode(m) {
  S.mode = m;
  document.body.classList.remove('m-map', 'm-timeline', 'm-locations', 'm-print');
  document.body.classList.add('m-' + m);
  document.querySelectorAll('.modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  const pr = m === 'print';
  $('#print').hidden = !pr; $('#stage').hidden = pr; $('#timeWrap').hidden = pr; $('#stats').hidden = pr;
  if (pr) { pause(); renderPoster(); }
  else { if (S.playing && m === 'locations') pause(); requestAnimationFrame(() => { buildTimeline(); buildMap(); renderDetail(); }); }
  writeHash();
}

/* ---------- print ---------- */
function renderPoster() {
  const size = $('#pSize').value, [pw, ph] = PAPER[size];
  const vis = $('#pVisual').value;
  const P = $('#poster');
  P.style.width = pw + 'mm'; P.style.height = ph + 'mm';
  let ps = $('#pageSize'); if (!ps) { ps = document.createElement('style'); ps.id = 'pageSize'; document.head.appendChild(ps); }
  ps.textContent = `@page{size:${pw}mm ${ph}mm;margin:0}`;
  const title = $('#pTitle').value || S.data.profile.title || 'A life on the map';
  const years = Math.floor((D.end - D.birth) / 12);
  const imgs = [...D.homes.flatMap(h => h.media || []), ...D.trips.flatMap(t => (t.places || []).flatMap(p => p.media || []))]
    .filter(m => m.type === 'photo' && m.url).slice(0, 3);
  while (imgs.length < 3) imgs.push(null);
  P.innerHTML = `<h1>${esc(title)}</h1>
    <div class="psub">${esc(S.data.profile.name || '')} · ${Math.floor(D.birth / 12)} to ${now.getFullYear()} · ${D.homes.map(h => esc(h.city)).join(' → ')}</div>
    <div class="pstats">${[[years, 'Years'], [D.homes.length, 'Homes'], [D.countries.size, 'Countries'], [D.dests.length + D.homes.length, 'Cities'], [D.trips.length, 'Trips'], [d3.format(',')(Math.round(D.km / 1000) * 1000), 'Kilometres']]
      .map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>
    <div class="pviz"><svg></svg></div>
    <div class="pimgs">${imgs.map(m => `<div>${m ? `<img src="${esc(m.url)}" alt="">` : 'Key photo'}</div>`).join('')}</div>
    <div class="phomes">${D.homes.map(h => `<div><b>${esc(h.city)}</b>${fmtM(h.startM)} to ${h.end ? fmtM(h.endM) : 'now'}</div>`).join('')}</div>`;
  const box = P.querySelector('.pviz'), w = box.clientWidth, h = box.clientHeight;
  const s = d3.select(box).select('svg').attr('viewBox', `0 0 ${w} ${h}`);
  if (vis === 'timeline') posterTimeline(s, w, h); else posterMap(s, w, h, vis === 'locations');
  fitPoster();
}
function fitPoster() {
  const st = $('#posterStage'), P = $('#poster');
  const sc = Math.min((st.clientWidth - 40) / P.offsetWidth, (st.clientHeight - 40) / P.offsetHeight, 1);
  P.style.transform = `scale(${sc})`;
}
function posterMap(s, w, h, locs) {
  const pr = d3.geoNaturalEarth1().fitExtent([[4, 4], [w - 4, h - 4]], S.fitLand), pa = d3.geoPath(pr);
  s.append('path').datum(S.land).attr('d', pa).attr('fill', '#E6E2DA').attr('stroke', '#FBFAF7').attr('stroke-width', .5);
  if (!locs) {
    s.append('g').selectAll('path').data(D.trips).join('path').attr('d', d => pa(geoLine(d.home, d)))
      .attr('fill', 'none').attr('stroke', d => d.home.dayColor).attr('stroke-width', 1).attr('opacity', .7);
    s.append('g').selectAll('path').data(D.moves).join('path').attr('d', d => bowArc(pr, d.from, d.to))
      .attr('fill', 'none').attr('stroke', d => d.to.dayColor).attr('stroke-width', 1.6);
  }
  s.append('g').selectAll('circle').data(D.dests).join('circle')
    .attr('transform', d => `translate(${pr([d.lng, d.lat])})`).attr('r', d => locs ? 2 + Math.sqrt(d.trips.length) * 2.4 : 2)
    .attr('fill', d => d.trips[d.trips.length - 1].home.dayColor).attr('stroke', '#FBFAF7').attr('stroke-width', .6);
  s.append('g').selectAll('circle').data(D.homes).join('circle')
    .attr('transform', d => `translate(${pr([d.lng, d.lat])})`).attr('r', 5).attr('fill', d => d.dayColor).attr('stroke', '#2F2E2B').attr('stroke-width', 1.2);
  const lab = locs ? [...D.dests].sort((a, b) => b.trips.length - a.trips.length).slice(0, 12) : [];
  s.append('g').selectAll('text').data([...D.homes, ...lab]).join('text')
    .attr('transform', d => `translate(${pr([d.lng, d.lat])})`).attr('dx', 7).attr('dy', -6)
    .attr('font-size', 11).attr('fill', '#2F2E2B').attr('paint-order', 'stroke').attr('stroke', '#FBFAF7').attr('stroke-width', 3).text(d => d.city);
}
function posterTimeline(s, w, h) {
  const x = d3.scaleLinear([D.birth, D.end + 1], [10, w - 10]);
  const mid = h * .62, bh = 26;
  s.append('g').selectAll('rect').data(D.homes).join('rect').attr('x', d => x(d.startM)).attr('width', d => x(d.endM + 1) - x(d.startM) - 1)
    .attr('y', mid).attr('height', bh).attr('rx', 4).attr('fill', d => d.dayColor);
  s.append('g').selectAll('text').data(D.homes).join('text').attr('x', d => x(d.startM) + 8).attr('y', mid + 17).attr('font-size', 12).attr('fill', '#2F2E2B').text(d => d.city);
  const per = {};
  s.append('g').selectAll('circle').data(D.trips).join('circle').attr('cx', d => x(d.m + .5))
    .attr('cy', d => { const y = Math.floor(d.m / 12); per[y] = (per[y] ?? -1) + 1; return mid - 10 - per[y] * 10; })
    .attr('r', 3.6).attr('fill', d => d.home.dayColor);
  const ax = s.append('g');
  for (let y = Math.ceil(D.birth / 60) * 5; y * 12 <= D.end; y += 5) {
    ax.append('text').attr('x', x(y * 12)).attr('y', mid + bh + 20).attr('text-anchor', 'middle').attr('font-size', 10).attr('fill', '#7E7B74').text(y);
  }
  D.moments.forEach((m, i) => {
    const xx = x(m.m + .5), yy = 20 + (i % 3) * 22;
    s.append('line').attr('x1', xx).attr('x2', xx).attr('y1', yy).attr('y2', mid).attr('stroke', '#DEDAD2');
    s.append('rect').attr('width', 7).attr('height', 7).attr('transform', `translate(${xx},${yy - 5}) rotate(45)`).attr('fill', '#2F2E2B');
    s.append('text').attr('x', xx + 9).attr('y', yy + 4).attr('font-size', 10).attr('fill', '#7E7B74').text(m.title);
  });
}

/* ---------- editor ---------- */
function commit() {
  saveLocal(); derive(); renderHeader();
  if (S.sel && !(S.sel.type === 'dest' ? D.dests.some(x => x.key === S.sel.key) : D.homes.some(h => h.id === S.sel.id))) S.sel = null;
  if (S.mode === 'print') renderPoster(); else { buildTimeline(); buildMap(); renderDetail(); }
}
const mediaToText = a => (a || []).map(m => [m.type, m.url, m.caption].join(' | ')).join('\n');
const textToMedia = s => s.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
  const [type, url, caption] = l.split('|').map(x => (x || '').trim());
  return { type: /video/i.test(type) ? 'video' : 'photo', url: url || '', caption: caption || '' };
});

function fld(label, obj, prop, opts = {}) {
  const w = document.createElement('label'); w.className = 'fld' + (opts.full ? ' full' : '');
  w.textContent = label;
  const i = document.createElement(opts.area ? 'textarea' : 'input');
  if (!opts.area) i.type = opts.type || 'text';
  if (opts.step) i.step = opts.step;
  if (opts.ph) i.placeholder = opts.ph;
  i.value = opts.get ? opts.get(obj) : (obj[prop] ?? '');
  i.addEventListener('change', () => {
    if (opts.set) opts.set(obj, i.value); else obj[prop] = opts.type === 'number' ? (i.value === '' ? '' : +i.value) : i.value;
    commit(); if (opts.rerender) refreshHeaders();
  });
  w.appendChild(i); return w;
}
function btn(text, fn, cls = 'sm') { const b = document.createElement('button'); b.className = cls; b.textContent = text; b.type = 'button'; b.onclick = fn; return b; }
async function geocode(obj, q, button) {
  const set = (lat, lng) => { obj.lat = +(+lat).toFixed(4); obj.lng = +(+lng).toFixed(4); commit(); renderEditor(); };
  if (button) { button.disabled = true; button.textContent = 'Finding…'; }
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const j = r.ok ? await r.json() : [];
    if (j[0]) return set(j[0].lat, j[0].lon);
  } catch (e) {}
  try {   // fallback: Open-Meteo geocoder (city names only)
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(q.split(',')[0].trim())}`);
    const j = r.ok ? await r.json() : {};
    if (j.results?.[0]) return set(j.results[0].latitude, j.results[0].longitude);
  } catch (e) {}
  if (button) { button.disabled = false; button.textContent = 'Find coordinates'; }
  alert(`Couldn't find "${q}". You can type the latitude and longitude instead.`);
}
function coordRow(bd, obj, q) {
  bd.append(fld('Latitude', obj, 'lat', { type: 'number', step: 'any' }), fld('Longitude', obj, 'lng', { type: 'number', step: 'any' }));
  const r = document.createElement('div'); r.className = 'full';
  const b = btn('Find coordinates', () => geocode(obj, q(), b)); r.appendChild(b);
  bd.appendChild(r);
}
let headers = [];
function card(id, title, date, build) {
  const c = document.createElement('div'); c.className = 'card';
  const hd = document.createElement('div'); hd.className = 'hd';
  hd.setAttribute('role', 'button'); hd.tabIndex = 0; hd.setAttribute('aria-expanded', S.expanded.has(id));
  hd.innerHTML = `<span class="t"></span><span class="d"></span><span class="muted">${S.expanded.has(id) ? '▾' : '▸'}</span>`;
  const paint = () => { hd.querySelector('.t').textContent = title(); hd.querySelector('.d').textContent = date(); };
  paint(); headers.push(paint);
  const toggle = () => { S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id); renderEditor(); };
  hd.onclick = toggle;
  hd.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  c.appendChild(hd);
  if (S.expanded.has(id)) {
    const bd = document.createElement('div'); bd.className = 'bd'; build(bd); c.appendChild(bd);
    if (S.focusNew === id) { S.focusNew = null; setTimeout(() => { const i = bd.querySelector('input'); if (i) { i.focus(); i.select(); } }, 0); }
  }
  return c;
}
const refreshHeaders = () => headers.forEach(f => f());

/* Month + year picker: a month menu plus a 4-digit year you can type (numeric keypad on phones)
   or nudge with the arrow keys. Saves as soon as the year is complete; "Present" for open-ended homes. */
function ymField(label, obj, prop, opts = {}) {
  const w = document.createElement('div'); w.className = 'fld' + (opts.full ? ' full' : '');
  const lab = document.createElement('span'); lab.textContent = label; w.appendChild(lab);
  const row = document.createElement('div'); row.className = 'ym';
  const sel = document.createElement('select'); sel.setAttribute('aria-label', label + ', month');
  MONTHS.forEach((m, i) => sel.add(new Option(m, String(i + 1).padStart(2, '0'))));
  const yr = document.createElement('input');
  Object.assign(yr, { type: 'text', inputMode: 'numeric', maxLength: 4, placeholder: 'YYYY', autocomplete: 'off' });
  yr.setAttribute('aria-label', label + ', year');
  const err = document.createElement('div'); err.className = 'err'; err.setAttribute('aria-live', 'polite');
  const maxY = now.getFullYear() + 1;
  const fill = () => { const [y, m] = obj[prop] ? String(obj[prop]).split('-') : ['', '01']; yr.value = y || ''; sel.value = (m || '01').padStart(2, '0'); };
  fill();
  let present = null;
  row.append(sel, yr);
  if (opts.allowPresent) {
    const l = document.createElement('label'); l.className = 'now';
    present = document.createElement('input'); present.type = 'checkbox'; present.checked = !obj[prop];
    l.append(present, 'Present'); row.appendChild(l);
  }
  const lock = () => { const off = !!present?.checked; sel.disabled = yr.disabled = off; if (off) { yr.value = ''; } };
  lock();
  const save = () => {
    if (present?.checked) { if (obj[prop] !== '') { obj[prop] = ''; commit(); refreshHeaders(); } err.textContent = ''; return true; }
    const y = +yr.value;
    if (!/^\d{4}$/.test(yr.value) || y < 1900 || y > maxY) {
      yr.classList.add('bad'); err.textContent = `Enter a 4-digit year from 1900 to ${maxY}.`; return false;
    }
    yr.classList.remove('bad'); err.textContent = '';
    const v = `${y}-${sel.value}`;
    if (v !== obj[prop]) { obj[prop] = v; commit(); refreshHeaders(); }
    return true;
  };
  yr.addEventListener('input', () => {
    yr.value = yr.value.replace(/\D/g, '').slice(0, 4);
    if (yr.value.length === 4) save(); else { yr.classList.remove('bad'); err.textContent = ''; }
  });
  yr.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const y = Math.min(maxY, Math.max(1900, (+yr.value || now.getFullYear()) + (e.key === 'ArrowUp' ? 1 : -1)));
      yr.value = y; save();
    }
    if (e.key === 'Enter') { e.preventDefault(); save(); }
  });
  yr.addEventListener('blur', () => { if (yr.value) save(); });
  yr.addEventListener('focus', () => yr.select());
  sel.addEventListener('change', () => { if (yr.value) save(); else yr.focus(); });
  present?.addEventListener('change', () => { lock(); if (!present.checked) { yr.value = now.getFullYear(); sel.value = String(now.getMonth() + 1).padStart(2, '0'); yr.focus(); } save(); });
  w.append(row, err);
  return w;
}

function renderEditor() {
  const E = $('#editor');
  if (E.hidden) return;
  const scroll = E.querySelector('.body')?.scrollTop || 0;
  headers = [];
  const d = S.data;
  E.innerHTML = `<header><b>Edit data</b><button class="ghost" id="eClose">Done</button></header>
    <div class="tabs">${['profile', 'homes', 'trips', 'moments'].map(t => `<button data-t="${t}" class="${S.etab === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    <div class="body"></div>
    <div class="foot"><span class="note">Edits save in this browser automatically. To publish them, download data.json and replace the file in the repo.</span></div>`;
  E.querySelector('#eClose').onclick = () => { E.hidden = true; };
  E.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { S.etab = b.dataset.t; renderEditor(); });
  const body = E.querySelector('.body'), foot = E.querySelector('.foot');
  foot.append(
    btn('Download data.json', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 1)], { type: 'application/json' })); a.download = 'data.json'; a.click(); }),
    btn('Import JSON', () => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.json,application/json';
      i.onchange = async () => { try { const j = JSON.parse(await i.files[0].text()); if (!j.homes || !j.trips) throw 0; S.data = j; commit(); renderEditor(); } catch (e) { alert('That file is not a valid life map data file.'); } }; i.click(); }),
    btn('Reset to published data', () => { if (confirm('Discard your local edits and reload the published data?')) { try { localStorage.removeItem(STORE); } catch (e) {} S.data = JSON.parse(JSON.stringify(S.base)); commit(); renderEditor(); } }, 'sm danger'));

  if (S.etab === 'profile') {
    const c = document.createElement('div'); c.className = 'card'; const bd = document.createElement('div'); bd.className = 'bd';
    bd.append(fld('Name', d.profile, 'name'), ymField('Born', d.profile, 'birth'), fld('Title', d.profile, 'title', { full: true }));
    c.appendChild(bd); body.appendChild(c);
  }
  if (S.etab === 'homes') {
    body.appendChild(btn('+ Add home', () => { const h = { id: 'h' + Date.now(), city: 'New home', country: '', lat: 0, lng: 0, start: ymStr(NOW_M), end: '', note: '', media: [] }; d.homes.push(h); S.expanded.add(h.id); S.focusNew = h.id; commit(); renderEditor(); }));
    [...d.homes].sort((a, b) => ym(a.start) - ym(b.start)).forEach(h => body.appendChild(card(h.id, () => `${h.city}, ${h.country}`, () => `${h.start ? fmtM(ym(h.start)) : '?'} to ${h.end ? fmtM(ym(h.end)) : 'now'}`, bd => {
      bd.append(fld('City', h, 'city', { rerender: 1 }), fld('Country', h, 'country', { rerender: 1 }),
        ymField('Moved in', h, 'start'), ymField('Moved out', h, 'end', { allowPresent: true }));
      coordRow(bd, h, () => `${h.city}, ${h.country}`);
      bd.append(fld('Note', h, 'note', { area: 1, full: 1 }),
        fld('Photos and video (one per line: photo | url | caption)', h, 'media', { area: 1, full: 1, get: o => mediaToText(o.media), set: (o, v) => o.media = textToMedia(v) }));
      const r = document.createElement('div'); r.className = 'full';
      r.appendChild(btn('Delete home', () => { if (d.homes.length > 1 && confirm('Delete this home?')) { d.homes.splice(d.homes.indexOf(h), 1); commit(); renderEditor(); } }, 'sm danger'));
      bd.appendChild(r);
    })));
  }
  if (S.etab === 'trips') {
    const top = document.createElement('div');
    const q = document.createElement('input'); q.className = 'search'; q.placeholder = 'Filter by city, country or year'; q.value = S.efilter;
    q.oninput = () => { S.efilter = q.value; const pos = q.selectionStart; renderEditor(); const nq = $('#editor .search'); nq.focus(); nq.setSelectionRange(pos, pos); };
    top.append(q, btn('+ Add trip', () => { const t = { id: 't' + Date.now(), city: 'New trip', country: '', lat: 0, lng: 0, start: ymStr(S.t), note: '', places: [] }; d.trips.push(t); S.expanded.add(t.id); S.focusNew = t.id; S.efilter = ''; commit(); renderEditor(); }));
    body.appendChild(top);
    const f = S.efilter.toLowerCase();
    [...d.trips].sort((a, b) => ym(b.start) - ym(a.start))
      .filter(t => !f || `${t.city} ${t.country} ${t.start}`.toLowerCase().includes(f))
      .forEach(t => body.appendChild(card(t.id, () => `${t.city}, ${t.country}`, () => fmtM(ym(t.start)), bd => {
        bd.append(fld('City', t, 'city', { rerender: 1 }), fld('Country', t, 'country', { rerender: 1 }), ymField('When', t, 'start'), document.createElement('span'));
        coordRow(bd, t, () => `${t.city}, ${t.country}`);
        bd.append(fld('Trip note', t, 'note', { area: 1, full: 1 }));
        const sub = document.createElement('div'); sub.className = 'sub-list';
        sub.appendChild(Object.assign(document.createElement('div'), { className: 'fld', textContent: 'Places visited (pins appear when you zoom in)' }));
        (t.places = t.places || []).forEach((p, i) => {
          const pid = t.id + ':' + i;
          sub.appendChild(card(pid, () => p.name || 'Place', () => '', pb => {
            pb.append(fld('Name', p, 'name', { full: 1, rerender: 1 }));
            coordRow(pb, p, () => `${p.name}, ${t.city}, ${t.country}`);
            pb.append(fld('Note', p, 'note', { area: 1, full: 1 }),
              fld('Photos and video (one per line: photo | url | caption)', p, 'media', { area: 1, full: 1, get: o => mediaToText(o.media), set: (o, v) => o.media = textToMedia(v) }));
            const r = document.createElement('div'); r.className = 'full';
            r.appendChild(btn('Delete place', () => { t.places.splice(i, 1); commit(); renderEditor(); }, 'sm danger'));
            pb.appendChild(r);
          }));
        });
        sub.appendChild(btn('+ Add place', () => { t.places.push({ name: 'New place', lat: t.lat, lng: t.lng, note: '', media: [] }); S.expanded.add(t.id + ':' + (t.places.length - 1)); S.focusNew = t.id + ':' + (t.places.length - 1); commit(); renderEditor(); }));
        bd.appendChild(sub);
        const r = document.createElement('div'); r.className = 'full';
        r.appendChild(btn('Delete trip', () => { if (confirm('Delete this trip?')) { d.trips.splice(d.trips.indexOf(t), 1); commit(); renderEditor(); } }, 'sm danger'));
        bd.appendChild(r);
      })));
  }
  if (S.etab === 'moments') {
    d.moments = d.moments || [];
    body.appendChild(btn('+ Add key moment', () => { const h = D.homeAt(S.t); const m = { id: 'm' + Date.now(), date: ymStr(S.t), title: 'New moment', city: h.city, lat: h.lat, lng: h.lng, note: '' }; d.moments.push(m); S.expanded.add(m.id); S.focusNew = m.id; commit(); renderEditor(); }));
    [...d.moments].sort((a, b) => ym(b.date) - ym(a.date)).forEach(m => body.appendChild(card(m.id, () => m.title, () => fmtM(ym(m.date)), bd => {
      bd.append(fld('Title', m, 'title', { full: 1, rerender: 1 }), ymField('When', m, 'date'), fld('City', m, 'city'));
      coordRow(bd, m, () => m.city);
      bd.append(fld('Note', m, 'note', { area: 1, full: 1 }));
      const r = document.createElement('div'); r.className = 'full';
      r.appendChild(btn('Delete moment', () => { d.moments.splice(d.moments.indexOf(m), 1); commit(); renderEditor(); }, 'sm danger'));
      bd.appendChild(r);
    })));
  }
  E.querySelector('.body').scrollTop = scroll;
}

/* ---------- tooltip ---------- */
const tipEl = $('#tip');
function tip(e, html) { tipEl.innerHTML = html; tipEl.hidden = false; moveTip(e); }
function moveTip(e) { const x = Math.min(e.clientX + 12, innerWidth - tipEl.offsetWidth - 8); tipEl.style.left = x + 'px'; tipEl.style.top = (e.clientY - 34) + 'px'; }
function hideTip() { tipEl.hidden = true; }

/* ---------- boot ---------- */
async function init() {
  const [world, base] = await Promise.all([d3.json(WORLD), d3.json('data.json')]);
  S.land = topojson.feature(world, world.objects.countries);
  S.fitLand = { type: 'FeatureCollection', features: S.land.features.filter(f => f.id !== '010') };
  S.base = base;
  let local = null; try { local = JSON.parse(localStorage.getItem(STORE)); } catch (e) {}
  S.data = local && local.homes ? local : JSON.parse(JSON.stringify(base));
  S.theme = 'night';   // night sky is the default look
  try { if (localStorage.getItem(THEME_KEY) === 'day') S.theme = 'day'; } catch (e) {}
  { const th = new URLSearchParams(location.hash.slice(1)).get('theme'); if (th) S.theme = th === 'night' ? 'night' : 'day'; }
  derive();
  S.t = D.end;
  const hp = new URLSearchParams(location.hash.slice(1));
  S.attract = !hp.has('t') && !hp.has('sel') && (!hp.get('mode') || hp.get('mode') === 'map');
  readHash();
  $('#pTitle').value = S.data.profile.title || '';
  renderHeader();

  document.querySelectorAll('.modes button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $('#playBtn').onclick = () => S.playing ? pause() : play();
  document.querySelectorAll('.zoomBtns button').forEach(b => b.onclick = () => {
    const z = b.dataset.z;
    if (z === 'fit') svg.transition().duration(700).call(zoom.transform, d3.zoomIdentity);
    else svg.transition().duration(300).call(zoom.scaleBy, z === 'in' ? 2 : .5);
  });
  // settings menu: the gear toggles; Print, Edit and Share unfurl below it
  const settings = $('#settings'), menuBtns = [...document.querySelectorAll('#settingsMenu .iconbtn')];
  const setMenu = open => {
    settings.classList.toggle('open', open);
    $('#gearBtn').setAttribute('aria-expanded', open);
    $('#settingsMenu').setAttribute('aria-hidden', !open);
    menuBtns.forEach(b => b.tabIndex = open ? 0 : -1);
  };
  $('#gearBtn').onclick = () => setMenu(!settings.classList.contains('open'));
  addEventListener('keydown', e => { if (e.key === 'Escape' && settings.classList.contains('open') && $('#editor').hidden) { setMenu(false); $('#gearBtn').focus(); } });
  $('#printBtnM').onclick = () => { setMenu(false); setMode('print'); };
  $('#shareBtn').onclick = async () => {
    writeHash();
    const b = $('#shareBtn');
    try { await navigator.clipboard.writeText(location.href); b.classList.add('done'); b.title = 'Link copied'; setTimeout(() => { b.classList.remove('done'); b.title = 'Copy share link'; }, 1600); }
    catch (e) { prompt('Copy this link', location.href); }
  };
  $('#editBtn').onclick = () => { setMenu(false); $('#editor').hidden = false; renderEditor(); };
  setTheme(S.theme, false);
  $('#themeBtn').onclick = () => setTheme(S.theme === 'night' ? 'day' : 'night');
  ['#pVisual', '#pSize', '#pTitle'].forEach(s => $(s).addEventListener('input', renderPoster));
  $('#printBtn').onclick = () => window.print();
  // first interaction ends the ambient loop and resets to the start
  document.addEventListener('pointerdown', stopAttract, true);
  document.addEventListener('keydown', stopAttract, true);
  addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || S.mode === 'print' || !$('#editor').hidden) return;
    if (e.code === 'Space' && e.target.tagName !== 'BUTTON') { e.preventDefault(); S.playing ? pause() : play(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {   // step a month; Shift steps a year
      e.preventDefault(); pause();
      S.t = Math.max(D.birth, Math.min(D.end, S.t + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 12 : 1)));
      syncTime(); update(); writeHash();
    }
  });

  // jump to a year: type it into the readout and press Enter, or nudge with the arrow keys
  const yj = $('#yearJump');
  const goYear = y => { pause(); S.t = Math.max(D.birth, Math.min(D.end, y * 12 + (S.t % 12))); syncTime(); update(); writeHash(); };
  let justFocused = false;
  const applyYear = () => {
    if (/^\d{4}$/.test(yj.value)) { goYear(+yj.value); yj.value = Math.floor(S.t / 12); }
    else { yj.classList.add('bad'); setTimeout(() => { yj.classList.remove('bad'); yj.value = Math.floor(S.t / 12); }, 900); }
  };
  yj.addEventListener('focus', () => { pause(); yj.select(); justFocused = true; });
  yj.addEventListener('mouseup', e => { if (justFocused) { e.preventDefault(); justFocused = false; yj.select(); } });
  yj.addEventListener('input', () => { yj.value = yj.value.replace(/\D/g, '').slice(0, 4); yj.classList.remove('bad'); });
  yj.addEventListener('keydown', e => {
    justFocused = false;
    if (e.key === 'Enter') { e.preventDefault(); applyYear(); yj.blur(); }
    else if (e.key === 'Escape') { yj.value = Math.floor(S.t / 12); yj.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); goYear(Math.floor(S.t / 12) + (e.key === 'ArrowUp' ? 1 : -1)); yj.value = Math.floor(S.t / 12); yj.select(); }
  });
  yj.addEventListener('blur', () => { if (yj.value !== String(Math.floor(S.t / 12))) applyYear(); });

  let rt;
  const ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (S.mode === 'print') fitPoster(); else { buildMap(true); buildTimeline(true); } }, 80); });
  ro.observe($('#mapWrap')); ro.observe($('#timeline')); ro.observe($('#posterStage'));

  setMode(S.mode);
  if (S.attract) { S.t = attractStart(); play(); }
  const focusSel = () => {
    if (!S.sel || S.mode === 'print') return;
    S.afterBuild = () => {
      const o = S.sel?.type === 'dest' ? D.dests.find(x => x.key === S.sel.key) : D.homes.find(h => h.id === S.sel?.id);
      if (!o) return;
      const pl = S.sel.place && o.places?.find(p => p.name === S.sel.place);
      if (S.mode === 'locations' || pl) zoomTo((pl || o).lng, (pl || o).lat, pl ? 400 : 40);
    };
  };
  focusSel();
  // a deep link pasted into the same tab only changes the hash: apply it without a reload
  addEventListener('hashchange', () => {
    const hash = location.hash;   // read before pause() rewrites it
    S.attract = false; if (S.playing) { S.playing = false; $('#playBtn').textContent = '▶'; } clearFlights();
    S.sel = null; S.t = D.end; S.zt = d3.zoomIdentity;
    const th = S.theme; readHash(hash); syncTime();
    if (th !== S.theme) { setTheme(S.theme, false); derive(); renderHeader(); }
    setMode(S.mode); focusSel();
  });
}
window.__pushlife = { S, get D() { return D; } };   // read-only hook for QA scripts
init().catch(err => { console.error(err); document.body.insertAdjacentHTML('beforeend', `<p style="padding:20px">Could not load the map data. ${esc(err.message)}</p>`); });
})();
