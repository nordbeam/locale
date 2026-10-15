import type { ProjectReport } from './report.js';

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

/** JSON inside a script element must not contain `</script>` or a line separator that older parsers reject. */
const lineSeparator = String.fromCharCode(0x2028), paragraphSeparator = String.fromCharCode(0x2029);
const embed = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').split(lineSeparator).join('\\u2028').split(paragraphSeparator).join('\\u2029');

const styles = String.raw`
:root {
  color-scheme: light dark;
  --bg: #f4f4f1; --panel: #ffffff; --raised: #fafaf8; --text: #18181b; --muted: #5f5f69; --faint: #8e8e98;
  --border: #e2e2dd; --line: #ecece7; --soft: #f0f0ec; --cell: #e8e8e3;
  --accent: #4353d1; --accent-soft: #eaedfc;
  --translated: #1f9d68; --same: #c98a06; --blank: #e0631f; --missing: #df3f45; --unused: #7653d6;
  --translated-soft: #e2f4eb; --same-soft: #fbf0d6; --blank-soft: #fde7da; --missing-soft: #fce3e4; --unused-soft: #eee8fb;
  --shadow: 0 1px 2px rgba(16, 16, 20, .05);
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0b0d; --panel: #141417; --raised: #19191d; --text: #ececef; --muted: #a1a1ab; --faint: #6c6c76;
    --border: #26262c; --line: #1f1f24; --soft: #1e1e23; --cell: #24242a;
    --accent: #8b9cff; --accent-soft: rgba(139, 156, 255, .14);
    --translated: #3ccf8e; --same: #f0bf4c; --blank: #ff8b4a; --missing: #ff6b70; --unused: #a68bff;
    --translated-soft: rgba(60, 207, 142, .13); --same-soft: rgba(240, 191, 76, .13); --blank-soft: rgba(255, 139, 74, .13); --missing-soft: rgba(255, 107, 112, .13); --unused-soft: rgba(166, 139, 255, .14);
    --shadow: none;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.wrap { max-width: 1280px; margin: 0 auto; padding-left: 28px; padding-right: 28px; }
code, .code { font-family: var(--mono); font-size: 12.5px; }

/* Header and section navigation */
.hero { background: var(--panel); border-bottom: 1px solid var(--border); }
.hero .wrap { display: flex; flex-wrap: wrap; gap: 18px 32px; align-items: flex-end; justify-content: space-between; padding-top: 30px; padding-bottom: 24px; }
.eyebrow { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.logo { width: 16px; height: 16px; border-radius: 5px; background: linear-gradient(135deg, var(--accent), var(--unused)); }
h1 { margin: 0; font-size: 30px; font-weight: 650; line-height: 1.15; letter-spacing: -.025em; overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 10px 0 0; color: var(--muted); font-size: 13px; }
.meta b { color: var(--text); font-weight: 550; }
.pills { display: flex; flex-wrap: wrap; gap: 8px; }
.pill { display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--border); background: var(--raised); color: var(--muted); font-size: 12.5px; font-weight: 500; white-space: nowrap; }
.pill.good { color: var(--translated); background: var(--translated-soft); border-color: transparent; }
.pill.warn { color: var(--same); background: var(--same-soft); border-color: transparent; }
.pill.bad { color: var(--missing); background: var(--missing-soft); border-color: transparent; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.nav { position: sticky; top: 0; z-index: 10; background: var(--bg); background: color-mix(in srgb, var(--bg) 85%, transparent); -webkit-backdrop-filter: saturate(1.4) blur(10px); backdrop-filter: saturate(1.4) blur(10px); border-bottom: 1px solid var(--border); }
.nav .wrap { display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; padding-top: 7px; padding-bottom: 7px; }
.nav .wrap::-webkit-scrollbar { display: none; }
.nav a { flex: none; padding: 5px 10px; border-radius: 7px; color: var(--muted); font-size: 13px; text-decoration: none; }
.nav a:hover { color: var(--text); background: var(--soft); }
.nav a.active { color: var(--text); background: var(--soft); font-weight: 550; }

/* Layout */
main.wrap { display: grid; gap: 20px; padding-top: 24px; padding-bottom: 48px; }
main section[id] { scroll-margin-top: 64px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 500px), 1fr)); gap: 20px; }
.card { min-width: 0; padding: 20px 22px 22px; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow); }
.card-head { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; }
.card-head > div:first-child { flex: 1 1 280px; min-width: 0; }
h2 { margin: 0; font-size: 15px; font-weight: 620; letter-spacing: -.01em; }
h3 { margin: 22px 0 8px; font-size: 11.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.lede { margin: 4px 0 0; max-width: 72ch; color: var(--muted); font-size: 13px; }
.note { margin: 14px 0 0; color: var(--muted); font-size: 12.5px; }
.empty { margin: 0; color: var(--muted); font-size: 13px; }
.link { padding: 0; border: 0; background: none; color: var(--accent); font-size: inherit; cursor: pointer; text-align: left; }
.link:hover { text-decoration: underline; }
.link.plain { color: inherit; }

/* Summary */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(175px, 1fr)); gap: 12px; }
.kpi { min-width: 0; padding: 16px 18px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); }
.kpi .label { color: var(--muted); font-size: 12.5px; font-weight: 500; }
.kpi .value { margin-top: 6px; font-size: 28px; font-weight: 650; line-height: 1.15; letter-spacing: -.025em; font-variant-numeric: tabular-nums; }
.kpi .sub { margin-top: 6px; color: var(--faint); font-size: 12.5px; overflow-wrap: anywhere; }
.kpi .meter { display: flex; height: 4px; margin-top: 12px; overflow: hidden; border-radius: 2px; background: var(--soft); }
.kpi .meter span { display: block; height: 100%; }
.kpi.good .value { color: var(--translated); } .kpi.warn .value { color: var(--same); } .kpi.bad .value { color: var(--missing); }

/* Bar charts: one grid per chart, so every track starts at the same x */
.bars { display: grid; grid-template-columns: minmax(0, max-content) minmax(80px, 1fr) max-content; gap: 10px 16px; align-items: center; }
.bars > .bar-row { display: contents; }
.bars .label { max-width: 220px; overflow: hidden; font-size: 13px; white-space: nowrap; text-overflow: ellipsis; }
.bars .label.code { font-weight: 600; }
.bars .value { font-size: 13px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.bars .value b { font-weight: 600; }
.bars .value small { margin-left: 8px; color: var(--muted); font-size: 12px; }
.bars .group { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 12px; border-top: 1px solid var(--line); }
.bars .group:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.track { display: flex; height: 10px; overflow: hidden; border-radius: 999px; background: var(--soft); }
.track.thick { height: 14px; }
.track > span, .track > button { display: block; height: 100%; margin: 0; padding: 0; border: 0; }
.track > button { cursor: pointer; }
.track > button:hover { filter: brightness(1.12); }
.fill { border-radius: 999px; background: var(--accent); }
.fill.dim { opacity: .5; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 16px; color: var(--muted); font-size: 12.5px; }
.legend > span { display: inline-flex; align-items: center; gap: 7px; }
.legend b { color: var(--text); font-weight: 550; font-variant-numeric: tabular-nums; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; flex: none; }
.s-translated { background: var(--translated); } .s-same { background: var(--same); } .s-blank { background: var(--blank); } .s-missing { background: var(--missing); }
.s-unused { background: var(--unused); } .s-used { background: var(--accent); }

/* Namespaces treemap */
.seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 9px; background: var(--soft); }
.seg button { padding: 5px 11px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font-size: 12.5px; font-weight: 500; cursor: pointer; }
.seg button:hover { color: var(--text); }
.seg button[aria-pressed="true"] { background: var(--panel); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, .14); }
.crumbs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 22px; margin: -6px 0 12px; color: var(--muted); font-size: 13px; }
.treemap-box { position: relative; }
svg.treemap { display: block; width: 100%; height: auto; color: var(--text); }
svg.treemap rect { stroke: transparent; stroke-width: 1.5; cursor: pointer; }
svg.treemap rect:hover, svg.treemap rect:focus-visible { stroke: var(--text); outline: none; }
svg.treemap text { pointer-events: none; font-family: var(--sans); }
.tip { position: absolute; z-index: 5; min-width: 190px; max-width: 300px; padding: 10px 12px; border-radius: 10px; background: var(--text); color: var(--bg); font-size: 12.5px; line-height: 1.5; box-shadow: 0 8px 28px rgba(0, 0, 0, .28); pointer-events: none; }
.tip .name { margin-bottom: 4px; font-family: var(--mono); font-weight: 600; overflow-wrap: anywhere; }
.tip .row { display: flex; justify-content: space-between; gap: 18px; font-variant-numeric: tabular-nums; }
.tip .row span:first-child, .tip .hint { opacity: .65; }
.tip .hint { margin-top: 4px; }
.scale { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 14px; color: var(--muted); font-size: 12.5px; }
.scale .ramp { width: 140px; height: 8px; border-radius: 4px; }

/* Scopes */
.scope { padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--raised); }
.scope + .scope { margin-top: 12px; }
.scope-head { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between; }
.scope-head > span { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.scope-name { font-family: var(--mono); font-size: 14px; font-weight: 650; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 12px; margin: 14px 0; }
.stat-num { font-size: 21px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.stat-label { color: var(--muted); font-size: 12px; }
.stat-label .good { color: var(--translated); font-weight: 550; }
.chip { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 6px; background: var(--soft); color: var(--muted); font-size: 12px; font-weight: 500; white-space: nowrap; }
.chip.accent { background: var(--accent-soft); color: var(--accent); }
.chip.unused { background: var(--unused-soft); color: var(--unused); }

/* Source usage */
.usage-top { display: flex; flex-wrap: wrap; gap: 18px 28px; align-items: center; }
.usage-top svg { flex: none; width: 116px; height: 116px; }
.figures { display: grid; gap: 6px; }
.figure { display: flex; align-items: center; gap: 9px; padding: 0; border: 0; background: none; color: var(--muted); font-size: 13px; text-align: left; }
.figure b { min-width: 5ch; color: var(--text); font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; }
button.figure { cursor: pointer; }
button.figure:hover span { color: var(--accent); text-decoration: underline; }
.usage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 8px 40px; align-items: start; }
.usage-grid h3:first-child { margin-top: 0; }
.files { display: grid; gap: 3px; margin: 0; padding: 0; list-style: none; }
.files li { display: flex; justify-content: space-between; gap: 14px; padding: 5px 10px; border-radius: 7px; font-size: 12.5px; background: linear-gradient(to right, var(--accent-soft) var(--w, 0%), transparent var(--w, 0%)); }
.files .path { min-width: 0; overflow: hidden; font-family: var(--mono); white-space: nowrap; text-overflow: ellipsis; }
.files .count { color: var(--muted); font-variant-numeric: tabular-nums; }
.callout { margin-top: 16px; padding: 11px 14px; border-radius: 10px; background: var(--soft); color: var(--muted); font-size: 12.5px; }
.callout.bad { background: var(--missing-soft); color: var(--text); }
.callout strong { display: block; margin-bottom: 6px; color: var(--missing); font-size: 13px; }
.callout ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.callout li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 14px; }

/* Diagnostics */
.ok-state { display: flex; align-items: center; gap: 14px; }
.ok-state .icon { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border-radius: 50%; background: var(--translated-soft); color: var(--translated); }
.ok-state b { display: block; font-weight: 600; }
details.diag { border: 1px solid var(--border); border-radius: 10px; background: var(--raised); }
details.diag + details.diag { margin-top: 8px; }
details.diag summary { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 11px 14px; cursor: pointer; list-style: none; }
details.diag summary::-webkit-details-marker { display: none; }
details.diag summary::after { content: ""; width: 7px; height: 7px; margin-left: auto; border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted); transform: rotate(45deg); transition: transform .15s; }
details.diag[open] summary::after { transform: rotate(-135deg); }
details.diag ul { display: grid; gap: 6px; margin: 0; padding: 0 14px 14px 34px; font-size: 13px; }
details.diag li { overflow-wrap: anywhere; }
.muted { color: var(--muted); }

/* Message explorer */
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
.search { position: relative; flex: 1 1 260px; min-width: 0; }
.search svg { position: absolute; top: 50%; left: 11px; width: 15px; height: 15px; color: var(--faint); transform: translateY(-50%); pointer-events: none; }
.toolbar input, .toolbar select { height: 34px; min-width: 0; border: 1px solid var(--border); border-radius: 8px; background-color: var(--raised); color: var(--text); font: inherit; font-size: 13px; }
.toolbar input { width: 100%; padding: 0 12px 0 33px; }
.toolbar input:focus, .toolbar select:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
.toolbar select { padding: 0 30px 0 11px; -webkit-appearance: none; appearance: none; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238e8e98' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 11px center; background-size: 10px 6px; }
.filter { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 6px 0 10px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 12.5px; }
.filter button { width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: none; color: inherit; cursor: pointer; }
.filter button:hover { background: var(--accent-soft); }
.count { margin-left: auto; color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.table-wrap { max-height: min(72vh, 780px); overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
th { position: sticky; top: 0; z-index: 1; padding: 9px 14px; border-bottom: 1px solid var(--border); background: var(--raised); color: var(--muted); font-size: 12px; font-weight: 600; text-align: left; white-space: nowrap; }
td { padding: 9px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
th.locale, td.locale { width: 1%; white-space: nowrap; }
td.used { width: 1%; color: var(--muted); white-space: nowrap; }
tr.msg { cursor: pointer; }
tr.msg:hover td, tr.msg[aria-expanded="true"] td { background: var(--soft); }
tr.msg[aria-expanded="true"] td { border-bottom-color: transparent; }
.mid { font-family: var(--mono); font-size: 12.5px; font-weight: 550; overflow-wrap: anywhere; }
.mtext { display: -webkit-box; margin-top: 2px; overflow: hidden; color: var(--muted); overflow-wrap: anywhere; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
.st { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; white-space: nowrap; }
.st i { width: 8px; height: 8px; flex: none; border-radius: 50%; }
.st.translated i { background: var(--translated); }
.st.same { color: var(--same); } .st.same i { background: var(--same); }
.st.blank { color: var(--blank); } .st.blank i { background: var(--blank); }
.st.missing { color: var(--missing); } .st.missing i { background: var(--missing); }
.st + .st { margin-left: 8px; }
.features { display: flex; flex-wrap: wrap; gap: 4px; }
tr.detail td { padding: 2px 14px 16px; background: var(--soft); }
.detail dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 20px; margin: 0; font-size: 13px; }
.detail dt { color: var(--muted); }
.detail dd { margin: 0; overflow-wrap: anywhere; }
.pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; color: var(--muted); font-size: 12.5px; }
.btn { height: 32px; padding: 0 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--raised); font-size: 13px; font-weight: 500; cursor: pointer; }
.btn:hover { background: var(--soft); }
footer.wrap { padding-bottom: 40px; color: var(--faint); font-size: 12.5px; }

@media (max-width: 640px) {
  .wrap { padding-left: 16px; padding-right: 16px; }
  .hero .wrap { padding-top: 22px; padding-bottom: 18px; }
  h1 { font-size: 24px; }
  main.wrap { gap: 16px; padding-top: 16px; }
  .card { padding: 16px; }
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .kpi { padding: 14px; }
  .kpi .value { font-size: 23px; }
  .bars { grid-template-columns: minmax(0, max-content) minmax(60px, 1fr); }
  .bars .value { grid-column: 2; margin-top: -6px; text-align: left; }
  .count { width: 100%; margin-left: 0; }
}
`;

const script = String.raw`
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('report-data').textContent);
  var SVG = 'http://www.w3.org/2000/svg';
  var nf = new Intl.NumberFormat('en');
  var sum = data.summary, project = data.project, usage = data.usage;
  var others = data.locales.filter(function (l) { return !l.base; });
  var otherNames = others.map(function (l) { return l.locale; });
  var base = data.locales.filter(function (l) { return l.base; })[0];
  var statusLabel = { translated: 'Translated', same: 'Same as base', blank: 'Blank', missing: 'Missing' };
  var featureLabel = { plain: 'Plain text', arguments: 'With arguments', plural: 'Plural', ordinal: 'Ordinal', select: 'Select', number: 'Number format', date: 'Date or time', tags: 'Rich text tags' };
  var frameworkLabel = { next: 'Next.js', '@tanstack/react-start': 'TanStack Start', vite: 'Vite', 'vite-react': 'Vite', react: 'React', vue: 'Vue', svelte: 'Svelte', 'solid-js': 'Solid' };

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) for (var key in props) {
      var value = props[key];
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.slice(0, 2) === 'on') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    el.append(child instanceof Node ? child : String(child));
  }
  function s(tag, attrs) {
    var el = document.createElementNS(SVG, tag);
    for (var key in attrs) el.setAttribute(key, String(attrs[key]));
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c != null) el.append(c instanceof Node ? c : String(c)); }
    return el;
  }
  function n(value) { return nf.format(value); }
  function pct(value) {
    var p = value * 100;
    if (p > 99.9 && p < 100) return '99.9%';
    if (p > 0 && p < 0.1) return '<0.1%';
    return (Math.round(p * 10) / 10) + '%';
  }
  function bytes(value) {
    if (value < 1000) return value + ' B';
    if (value < 1e6) return (value / 1000).toFixed(1) + ' kB';
    return (value / 1e6).toFixed(2) + ' MB';
  }
  function plural(count, word, words) { return n(count) + ' ' + (count === 1 ? word : (words || word + 's')); }
  function fill(id) { var el = document.getElementById(id); el.textContent = ''; return el; }
  function clip(text, max) { return text.length > max ? text.slice(0, Math.max(1, max - 1)) + '…' : text; }
  function icon(path, size) {
    return s('svg', { viewBox: '0 0 16 16', width: size || 16, height: size || 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, s('path', { d: path }));
  }

  // Header
  document.getElementById('title').textContent = project.name || 'Translation report';
  var when = new Date(data.generatedAt), whenText;
  try { whenText = when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { whenText = when.toLocaleString(); }
  var meta = fill('meta');
  [['Base locale', project.baseLocale], ['Catalogs', project.catalogs + '/'], ['Output', project.outDir + '/'], ['Generated', whenText]].forEach(function (item) {
    meta.append(h('span', null, item[0] + ' ', h('b', null, item[1])));
  });
  var badges = fill('badges');
  var output = {
    fresh: ['good', 'Output up to date', 'The generated modules match the catalogs.'],
    stale: ['warn', 'Output out of date', 'The catalogs changed since the last generation. Run nordbeam-locale generate.'],
    modified: ['bad', 'Output edited by hand', 'A generated file was changed. Move the change into the catalog and regenerate.'],
    missing: ['warn', 'Output not generated', 'Run nordbeam-locale generate to create ' + project.outDir + '/.']
  }[sum.freshness] || ['', 'Output state unknown', ''];
  badges.append(h('span', { class: 'pill ' + output[0], title: output[2] }, h('span', { class: 'dot' }), output[1]));
  var shownFrameworks = {};
  project.frameworks.forEach(function (f) {
    var label = frameworkLabel[f] || f;
    if (shownFrameworks[label]) return;
    shownFrameworks[label] = true;
    badges.append(h('span', { class: 'pill' }, label));
  });

  // Summary
  var kpis = fill('overview');
  function kpi(label, value, sub, tone, meter) {
    var card = h('div', { class: 'kpi' + (tone ? ' ' + tone : '') }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub));
    if (meter) {
      var bar = h('div', { class: 'meter', 'aria-hidden': 'true' });
      meter.forEach(function (part) { if (part[0] > 0) bar.append(h('span', { style: 'width:' + (part[0] * 100) + '%;background:var(' + part[1] + ')' })); });
      card.append(bar);
    }
    kpis.append(card);
  }
  var sameTotal = others.reduce(function (a, l) { return a + l.same; }, 0);
  var problems = sum.errors + usage.unknown.length;
  var scanned = usage.sourceFiles > 0, referenced = usage.used + usage.unused.length || 1;
  kpi('Messages', n(sum.messages), plural(data.namespaces.length, 'namespace') + (sum.notes ? ' · ' + plural(sum.notes, 'note') : ''));
  kpi('Locales', n(sum.locales), data.locales.map(function (l) { return l.locale + (l.base ? ' (base)' : ''); }).join(', ') || 'none');
  kpi('Translated', others.length ? pct(sum.coverage) : '—',
    !others.length ? 'Only the base locale' : sum.untranslated ? plural(sum.untranslated, 'gap') + ' in ' + plural(others.length, 'locale') : 'No gaps' + (sameTotal ? ' · ' + n(sameTotal) + ' same as base' : ''),
    others.length ? (sum.coverage >= 0.995 ? 'good' : sum.coverage >= 0.9 ? 'warn' : 'bad') : '',
    others.length ? [[sum.coverage, '--translated']] : null);
  kpi('Unused', scanned ? n(sum.unused) : '—',
    scanned ? pct(sum.unused / Math.max(1, sum.messages)) + ' of messages · ' + plural(usage.sourceFiles, 'file') + ' scanned' : 'No source files found', '',
    scanned ? [[usage.used / referenced, '--accent'], [usage.unused.length / referenced, '--unused']] : null);
  var problemParts = [];
  if (sum.errors) problemParts.push(plural(sum.errors, 'catalog error'));
  if (usage.unknown.length) problemParts.push(plural(usage.unknown.length, 'unknown ID'));
  if (sum.warnings) problemParts.push(plural(sum.warnings, 'warning'));
  kpi('Problems', n(problems), problemParts.join(' · ') || 'No errors or warnings', problems ? 'bad' : 'good');
  kpi('Catalog download', sum.catalog ? bytes(sum.catalog.brotli) : '—', sum.catalog ? 'Full ' + project.baseLocale + ' catalog, brotli · ' + bytes(sum.catalog.raw) + ' raw' : 'Needs catalogs that compile');

  // Explorer state, shared with the charts that filter it.
  var state = { query: '', show: 'all', locale: '', feature: '', namespace: '', limit: 100 };
  function focusExplorer(patch) {
    for (var key in patch) state[key] = patch[key];
    state.limit = 100;
    syncControls();
    renderTable();
    var target = document.getElementById('explorer');
    if (target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function barRow(label, track, value, title) {
    return h('div', { class: 'bar-row' }, h('div', { class: 'label', title: title || null }, label), track, h('div', { class: 'value' }, value));
  }

  // Coverage
  (function () {
    var root = fill('coverage-chart'), legend = fill('coverage-legend');
    if (!others.length) {
      root.append(h('p', { class: 'empty' }, 'Only the base locale exists. Add a catalog such as ' + project.catalogs + '/fr.json to track translations.'));
      legend.hidden = true;
      return;
    }
    var keys = ['translated', 'same', 'blank', 'missing'], totals = { translated: 0, same: 0, blank: 0, missing: 0 };
    var grid = h('div', { class: 'bars' });
    others.slice().sort(function (a, b) { return a.coverage - b.coverage || (a.locale < b.locale ? -1 : 1); }).forEach(function (l) {
      var total = sum.messages || 1;
      var track = h('div', { class: 'track thick', role: 'group', 'aria-label': l.locale + ': ' + pct(l.coverage) + ' translated' });
      keys.forEach(function (key) {
        totals[key] += l[key];
        if (!l[key]) return;
        track.append(h('button', { type: 'button', class: 's-' + key, style: 'width:' + (l[key] / total * 100) + '%', title: l.locale + ' · ' + statusLabel[key] + ': ' + n(l[key]) + '. Click to list them.',
          onclick: function () { focusExplorer({ show: key === 'translated' ? 'all' : key, locale: l.locale }); } }));
      });
      var detail = [];
      if (l.missing) detail.push(n(l.missing) + ' missing');
      if (l.blank) detail.push(n(l.blank) + ' blank');
      if (l.same) detail.push(n(l.same) + ' same as base');
      if (l.extra) detail.push(n(l.extra) + ' not in base');
      var row = barRow(l.locale, track, [h('b', null, pct(l.coverage)), detail.length ? h('small', null, detail.join(' · ')) : null], l.file);
      row.firstChild.classList.add('code');
      grid.append(row);
    });
    root.append(grid);
    keys.forEach(function (key) {
      if (key !== 'translated' && !totals[key]) return;
      legend.append(h('span', null, h('i', { class: 'swatch s-' + key }), statusLabel[key], h('b', null, n(totals[key]))));
    });
  })();

  // Download sizes
  (function () {
    var root = fill('sizes-chart');
    if (!data.sizes.available) { root.append(h('p', { class: 'empty' }, data.sizes.reason || 'Generated sizes are unavailable.')); return; }
    var max = 0;
    data.locales.forEach(function (l) { if (l.module) max = Math.max(max, l.module.brotli); });
    data.scopes.forEach(function (sc) { for (var k in sc.sizes || {}) max = Math.max(max, sc.sizes[k].brotli); });
    function row(label, size, dim) {
      return barRow(label, h('div', { class: 'track' }, h('span', { class: 'fill' + (dim ? ' dim' : ''), style: 'width:' + (size.brotli / (max || 1) * 100) + '%' })),
        [h('b', null, bytes(size.brotli)), h('small', null, 'gzip ' + bytes(size.gzip))], bytes(size.raw) + ' raw · ' + bytes(size.gzip) + ' gzip · ' + bytes(size.brotli) + ' brotli');
    }
    var grid = h('div', { class: 'bars' });
    data.locales.forEach(function (l) {
      if (!l.module) return;
      grid.append(h('div', { class: 'group' }, h('span', { class: 'code', style: 'font-weight:650' }, l.locale), l.base ? h('span', { class: 'chip' }, 'base') : null));
      grid.append(row('Full catalog', l.module, false));
      data.scopes.forEach(function (sc) { if (sc.sizes && sc.sizes[l.locale]) grid.append(row('Scope ' + sc.name, sc.sizes[l.locale], true)); });
    });
    root.append(grid);
    if (data.sizes.shared) root.append(h('p', { class: 'note' }, 'Plus a shared literals module of ' + bytes(data.sizes.shared.brotli) + ' (brotli), loaded once for every locale.'));
  })();

  // Scopes
  (function () {
    var root = fill('scopes-list');
    if (!data.scopes.length) {
      root.append(h('p', { class: 'empty' }, 'No scopes configured. A scope is a smaller catalog for part of the app, such as public pages. It can list message IDs or be computed from the files it covers.'));
      return;
    }
    function stat(value, label) { return h('div', null, h('div', { class: 'stat-num' }, value), h('div', { class: 'stat-label' }, label)); }
    data.scopes.forEach(function (sc) {
      var kind = sc.kind === 'modules'
        ? h('span', { class: 'chip accent', title: (sc.modules || []).join('\n') }, 'computed from ' + plural((sc.modules || []).length, 'glob'))
        : h('span', { class: 'chip' }, 'IDs and patterns');
      var size = sc.sizes && sc.sizes[project.baseLocale], full = base && base.module;
      var saving = size && full && full.brotli > size.brotli ? h('span', { class: 'good' }, ' · ' + pct(1 - size.brotli / full.brotli) + ' smaller') : null;
      root.append(h('div', { class: 'scope' },
        h('div', { class: 'scope-head' }, h('span', null, h('span', { class: 'scope-name' }, sc.name), kind),
          h('button', { type: 'button', class: 'link', onclick: function () { focusExplorer({ show: 'scope:' + sc.name }); } }, 'List its messages →')),
        h('div', { class: 'stats' }, stat(n(sc.messages), 'messages'), stat(pct(sc.share), 'of the catalog'),
          size ? stat(bytes(size.brotli), [project.baseLocale + ' download', saving]) : null),
        h('div', { class: 'track', title: pct(sc.share) + ' of the base catalog' }, h('span', { class: 'fill', style: 'width:' + (sc.share * 100) + '%' }))));
    });
  })();

  // Namespaces treemap
  var modes = {
    gaps: { color: '--missing', word: 'untranslated', ratio: function (ns) { return ns.untranslated / Math.max(1, ns.messages * Math.max(1, others.length)); },
      calm: others.length ? 'No namespace has untranslated messages.' : 'Only the base locale exists, so nothing is untranslated.' },
    unused: { color: '--unused', word: 'unused', ratio: function (ns) { return ns.unused / Math.max(1, ns.messages); },
      calm: scanned ? 'Every namespace is fully referenced in source.' : 'No source files were scanned, so unused messages are unknown.' },
    size: { color: '--accent', word: '', ratio: function () { return 0; }, calm: '' }
  };
  var treemapMode = sum.untranslated ? 'gaps' : scanned && usage.unused.length ? 'unused' : 'size', treemapRoot = '';
  function cellFill(ns) {
    if (treemapMode === 'size' || ns.other) return 'color-mix(in srgb, var(--accent) 22%, var(--cell))';
    var ratio = modes[treemapMode].ratio(ns);
    if (!ratio) return 'var(--cell)';
    return 'color-mix(in srgb, var(' + modes[treemapMode].color + ') ' + Math.round(20 + Math.min(1, ratio / 0.5) * 65) + '%, var(--cell))';
  }
  function squarify(items, x, y, w, h) {
    var out = [], total = 0;
    items.forEach(function (i) { total += i.value; });
    if (!total) return out;
    var scale = (w * h) / total, rest = items.map(function (i) { return { item: i, area: i.value * scale }; }), row = [];
    function worst(r, side) {
      var sumA = 0, max = 0, min = Infinity;
      r.forEach(function (c) { sumA += c.area; max = Math.max(max, c.area); min = Math.min(min, c.area); });
      return Math.max(side * side * max / (sumA * sumA), (sumA * sumA) / (side * side * min));
    }
    function layout(r) {
      var sumA = 0;
      r.forEach(function (c) { sumA += c.area; });
      if (w >= h) { var cw = sumA / h, cy = y; r.forEach(function (c) { var ch = c.area / cw; out.push({ item: c.item, x: x, y: cy, w: cw, h: ch }); cy += ch; }); x += cw; w -= cw; }
      else { var rh = sumA / w, cx = x; r.forEach(function (c) { var cw2 = c.area / rh; out.push({ item: c.item, x: cx, y: y, w: cw2, h: rh }); cx += cw2; }); y += rh; h -= rh; }
    }
    while (rest.length) {
      var side = Math.min(w, h), next = rest[0];
      if (!row.length || worst(row.concat([next]), side) <= worst(row, side)) { row.push(next); rest.shift(); }
      else { layout(row); row = []; }
    }
    if (row.length) layout(row);
    return out;
  }
  var treemapWidth = 0;
  function renderTreemap() {
    var box = fill('treemap'), crumbs = fill('treemap-crumbs'), scale = fill('treemap-scale');
    var nodes = data.namespaces;
    crumbs.hidden = !treemapRoot;
    if (treemapRoot) {
      var parent = data.namespaces.filter(function (ns) { return ns.name === treemapRoot; })[0];
      crumbs.append(h('button', { type: 'button', class: 'link', onclick: function () { treemapRoot = ''; renderTreemap(); } }, 'All namespaces'), ' / ', h('code', null, treemapRoot),
        h('span', { style: 'flex:1' }), h('button', { type: 'button', class: 'link', onclick: function () { focusExplorer({ namespace: treemapRoot }); } }, 'List its messages →'));
      nodes = parent && parent.children.length ? parent.children : parent ? [parent] : [];
      var direct = parent ? parent.messages - parent.children.reduce(function (a, c) { return a + c.messages; }, 0) : 0;
      if (parent && direct > 0 && parent.children.length) nodes = nodes.concat([{ name: treemapRoot + ' (direct)', messages: direct, unused: 0, untranslated: 0, children: [], direct: true }]);
    }
    if (!nodes.length) { box.append(h('p', { class: 'empty' }, 'No messages.')); return; }
    var shown = nodes.slice(0, 60), rest = nodes.slice(60);
    var items = shown.map(function (ns) { return { value: ns.messages, ns: ns }; });
    if (rest.length) {
      var restCount = rest.reduce(function (a, ns) { return a + ns.messages; }, 0);
      items.push({ value: restCount, ns: { name: plural(rest.length, 'more namespace'), messages: restCount, unused: 0, untranslated: 0, children: [], other: true } });
    }
    treemapWidth = box.clientWidth;
    var W = Math.max(300, treemapWidth || 1000), H = Math.round(W < 640 ? W * 0.9 : Math.min(460, W * 0.4));
    var svg = s('svg', { class: 'treemap', viewBox: '0 0 ' + W + ' ' + H, role: 'group', 'aria-label': 'Namespaces by number of messages' });
    var tip = h('div', { class: 'tip', hidden: true });
    function place(event) {
      var bounds = box.getBoundingClientRect(), x = event.clientX - bounds.left + 14, y = event.clientY - bounds.top + 14;
      if (x + tip.offsetWidth > bounds.width) x = Math.max(0, event.clientX - bounds.left - tip.offsetWidth - 14);
      if (y + tip.offsetHeight > bounds.height) y = Math.max(0, event.clientY - bounds.top - tip.offsetHeight - 14);
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }
    squarify(items, 0, 0, W, H).forEach(function (cell) {
      var ns = cell.item.ns;
      var label = ns.name === '' ? '(top level)' : ns.name;
      var short = treemapRoot && label.indexOf(treemapRoot + '.') === 0 ? label.slice(treemapRoot.length + 1) : label;
      var opens = !treemapRoot && ns.children && ns.children.length > 0;
      var rect = s('rect', { x: cell.x + 1, y: cell.y + 1, width: Math.max(0, cell.w - 2), height: Math.max(0, cell.h - 2), rx: 5, style: 'fill:' + cellFill(ns),
        tabindex: ns.other ? -1 : 0, role: ns.other ? 'img' : 'button', 'aria-label': label + ', ' + plural(ns.messages, 'message') });
      rect.addEventListener('mouseenter', function (event) {
        tip.textContent = '';
        tip.append(h('div', { class: 'name' }, label));
        var rows = [['Messages', n(ns.messages) + ' · ' + pct(ns.messages / Math.max(1, sum.messages))]];
        if (!ns.other && !ns.direct) {
          if (others.length) rows.push(['Untranslated', n(ns.untranslated)]);
          if (scanned) rows.push(['Unused', n(ns.unused)]);
          if (ns.children && ns.children.length) rows.push(['Sub-namespaces', n(ns.children.length)]);
        }
        rows.forEach(function (r) { tip.append(h('div', { class: 'row' }, h('span', null, r[0]), h('span', null, r[1]))); });
        if (!ns.other) tip.append(h('div', { class: 'hint' }, opens ? 'Click to open' : 'Click to list its messages'));
        tip.hidden = false;
        place(event);
      });
      rect.addEventListener('mousemove', place);
      rect.addEventListener('mouseleave', function () { tip.hidden = true; });
      function activate() {
        if (ns.other) return;
        tip.hidden = true;
        if (opens) { treemapRoot = ns.name; renderTreemap(); }
        else focusExplorer({ namespace: ns.direct ? treemapRoot : ns.name });
      }
      rect.addEventListener('click', activate);
      rect.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } });
      svg.append(rect);
      if (cell.w > 60 && cell.h > 30) {
        svg.append(s('text', { x: cell.x + 10, y: cell.y + 21, 'font-size': 13, 'font-weight': 600, fill: 'currentColor' }, clip(short, Math.floor((cell.w - 16) / 7.4))));
        if (cell.h > 50) svg.append(s('text', { x: cell.x + 10, y: cell.y + 39, 'font-size': 12, fill: 'currentColor', 'fill-opacity': 0.62 },
          clip(n(ns.messages) + (cell.w > 120 ? ' · ' + pct(ns.messages / Math.max(1, sum.messages)) : ''), Math.floor((cell.w - 16) / 6.6))));
      }
    });
    box.append(svg, tip);
    var mode = modes[treemapMode];
    if (treemapMode === 'size') scale.append(h('span', null, 'Area is the number of messages.'));
    else {
      var any = data.namespaces.some(function (ns) { return mode.ratio(ns) > 0; });
      scale.append(h('span', null, '0%'), h('span', { class: 'ramp', style: 'background:linear-gradient(to right, var(--cell), color-mix(in srgb, var(' + mode.color + ') 85%, var(--cell)))' }),
        h('span', null, '50%+ ' + mode.word));
      if (!any) scale.append(h('span', null, '· ' + mode.calm));
    }
  }
  var modeButtons = document.querySelectorAll('#treemap-mode button');
  function syncModes() { modeButtons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === treemapMode)); }); }
  modeButtons.forEach(function (button) {
    button.addEventListener('click', function () { treemapMode = button.getAttribute('data-mode'); syncModes(); renderTreemap(); });
  });
  syncModes();
  renderTreemap();
  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (document.getElementById('treemap').clientWidth !== treemapWidth) renderTreemap(); }, 150);
  });

  // ICU features
  (function () {
    var root = fill('features-chart');
    var keys = ['plain', 'arguments', 'plural', 'select', 'ordinal', 'number', 'date', 'tags'];
    var present = keys.filter(function (k) { return data.features[k]; }), absent = keys.filter(function (k) { return !data.features[k]; });
    var max = Math.max.apply(null, present.map(function (k) { return data.features[k]; }).concat([1]));
    var grid = h('div', { class: 'bars' });
    present.forEach(function (key) {
      var count = data.features[key];
      grid.append(barRow(h('button', { type: 'button', class: 'link plain', onclick: function () { focusExplorer({ feature: key }); } }, featureLabel[key]),
        h('div', { class: 'track' }, h('span', { class: 'fill', style: 'width:' + (count / max * 100) + '%' })),
        [h('b', null, n(count)), h('small', null, pct(count / Math.max(1, sum.messages)))]));
    });
    root.append(grid);
    if (absent.length) root.append(h('p', { class: 'note' }, 'Not used: ' + absent.map(function (k) { return featureLabel[k].toLowerCase(); }).join(', ') + '.'));
  })();

  // Source usage
  (function () {
    var root = fill('usage-body');
    if (!scanned) { root.append(h('p', { class: 'empty' }, 'No source files found under src/, app/, pages/, components/, lib/ or routes/. Run the report with --source-dir to choose where to look.')); return; }
    var used = usage.used, unused = usage.unused.length, total = Math.max(1, used + unused);
    var r = 48, c = 2 * Math.PI * r;
    var donut = s('svg', { viewBox: '0 0 116 116', role: 'img', 'aria-label': pct(used / total) + ' of messages are referenced in source' },
      s('circle', { cx: 58, cy: 58, r: r, fill: 'none', style: 'stroke:var(--unused)', 'stroke-width': 13 }),
      s('circle', { cx: 58, cy: 58, r: r, fill: 'none', style: 'stroke:var(--accent)', 'stroke-width': 13, 'stroke-dasharray': (used / total * c) + ' ' + c, transform: 'rotate(-90 58 58)' }),
      s('text', { x: 58, y: 58, 'text-anchor': 'middle', 'font-size': 19, 'font-weight': 650, fill: 'currentColor' }, pct(used / total)),
      s('text', { x: 58, y: 75, 'text-anchor': 'middle', 'font-size': 11, fill: 'currentColor', 'fill-opacity': 0.6 }, 'referenced'));
    var left = h('div'), right = h('div');
    root.append(h('div', { class: 'usage-grid' }, left, right));
    left.append(h('div', { class: 'usage-top' }, donut, h('div', { class: 'figures' },
      h('div', { class: 'figure' }, h('i', { class: 'swatch s-used' }), h('b', null, n(used)), h('span', null, 'referenced in source')),
      h(unused ? 'button' : 'div', { type: unused ? 'button' : null, class: 'figure', onclick: unused ? function () { focusExplorer({ show: 'unused' }); } : null },
        h('i', { class: 'swatch s-unused' }), h('b', null, n(unused)), h('span', null, unused ? 'not found · list them' : 'not found')),
      h('div', { class: 'figure' }, h('i', { class: 'swatch', style: 'background:var(--faint)' }), h('b', null, n(usage.sourceFiles)), h('span', null, 'source files scanned')))));
    left.append(h('p', { class: 'note' }, 'The scan counts calls, property chains such as m.home.title, quoted IDs and template-literal patterns. A key assembled any other way at runtime counts as unused.'));
    if (usage.topFiles.length) {
      right.append(h('h3', null, 'Files that use the most messages'));
      var list = h('ul', { class: 'files' }), most = usage.topFiles[0].messages || 1;
      usage.topFiles.slice(0, 8).forEach(function (f) {
        list.append(h('li', { style: '--w:' + (f.messages / most * 100) + '%' }, h('span', { class: 'path', title: f.file }, f.file), h('span', { class: 'count' }, n(f.messages))));
      });
      right.append(list);
    }
    if (usage.copies.length) {
      left.append(h('div', { class: 'callout' }, 'Left out ' + plural(usage.copies.length, 'file') + ' that name most of the catalog, so they read as copies of it rather than uses: ',
        usage.copies.map(function (c, i) { return [i ? ', ' : '', h('code', null, c.file)]; }), '.'));
    }
    if (usage.unknown.length) {
      var unknown = h('ul');
      usage.unknown.slice(0, 20).forEach(function (d) {
        unknown.append(h('li', null, h('span', null, h('code', null, d.messageId || ''), d.hint ? h('span', { class: 'muted' }, ' · ' + d.hint) : null), h('code', { class: 'muted' }, (d.file || '') + (d.line ? ':' + d.line : ''))));
      });
      right.append(h('div', { class: 'callout bad' }, h('strong', null, plural(usage.unknown.length, 'reference') + ' to IDs the catalog lacks'), unknown));
    }
  })();

  // Diagnostics
  (function () {
    var root = fill('diagnostics-body');
    var all = data.diagnostics.errors.map(function (d) { return { d: d, level: 'error' }; }).concat(data.diagnostics.warnings.map(function (d) { return { d: d, level: 'warning' }; }));
    if (!all.length) {
      root.append(h('div', { class: 'ok-state' }, h('span', { class: 'icon' }, icon('M3.5 8.5l3 3 6-7', 18)),
        h('div', null, h('b', null, 'No errors or warnings'), h('span', { class: 'muted' }, 'Every catalog compiles and matches the base locale.'))));
      return;
    }
    var groups = {}, order = [];
    all.forEach(function (item) { var key = item.level + ':' + item.d.code; if (!groups[key]) { groups[key] = []; order.push(key); } groups[key].push(item); });
    order.sort(function (a, b) { return (a[0] === 'e' ? 0 : 1) - (b[0] === 'e' ? 0 : 1) || groups[b].length - groups[a].length; });
    order.forEach(function (key) {
      var items = groups[key], level = items[0].level, code = items[0].d.code;
      var list = h('ul');
      items.slice(0, 50).forEach(function (item) {
        var d = item.d, where = [d.locale, d.file ? d.file + (d.line ? ':' + d.line : '') : ''].filter(Boolean).join(' · ');
        list.append(h('li', null, d.message, where ? h('span', { class: 'muted' }, ' · ' + where) : null, d.hint ? h('div', { class: 'muted' }, d.hint) : null));
      });
      if (items.length > 50) list.append(h('li', { class: 'muted' }, n(items.length - 50) + ' more. Run nordbeam-locale check --only ' + code + ' --limit all.'));
      root.append(h('details', { class: 'diag', open: level === 'error' && order.length < 4 ? true : null },
        h('summary', null, h('span', { class: 'pill ' + (level === 'error' ? 'bad' : 'warn') }, h('span', { class: 'dot' }), level), h('code', null, code), h('span', { class: 'muted' }, plural(items.length, 'occurrence'))), list));
    });
  })();

  // Message explorer
  var search = document.getElementById('q'), show = document.getElementById('show'), localeSelect = document.getElementById('locale'), featureSelect = document.getElementById('feature');
  document.querySelector('.search').prepend(icon('M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM11 11l3.5 3.5'));
  otherNames.forEach(function (l) { localeSelect.append(h('option', { value: l }, l)); });
  if (otherNames.length < 2) localeSelect.hidden = true;
  if (!otherNames.length) ['untranslated', 'missing', 'blank', 'same'].forEach(function (value) { var option = show.querySelector('option[value="' + value + '"]'); if (option) option.remove(); });
  if (!scanned) show.querySelector('option[value="unused"]').remove();
  if (!sum.notes) show.querySelector('option[value="notes"]').remove();
  Object.keys(featureLabel).forEach(function (k) { if (data.features[k]) featureSelect.append(h('option', { value: k }, featureLabel[k])); });
  data.scopes.forEach(function (sc) { show.append(h('option', { value: 'scope:' + sc.name }, 'In scope ' + sc.name)); });
  function syncControls() {
    search.value = state.query; show.value = state.show; localeSelect.value = state.locale; featureSelect.value = state.feature;
    var chip = fill('namespace-chip');
    if (state.namespace) chip.append(h('span', { class: 'filter' }, 'Namespace ', h('code', null, state.namespace),
      h('button', { type: 'button', 'aria-label': 'Clear the namespace filter', onclick: function () { state.namespace = ''; syncControls(); renderTable(); } }, '×')));
  }
  function statusIn(m, wanted) {
    var locales = state.locale ? [state.locale] : otherNames;
    return locales.some(function (l) { var st = m.status[l]; return wanted === 'untranslated' ? st === 'missing' || st === 'blank' : st === wanted; });
  }
  function matches(m) {
    if (state.namespace && m.id !== state.namespace && m.id.indexOf(state.namespace + '.') !== 0) return false;
    if (state.feature === 'plain' ? m.features.length : state.feature && m.features.indexOf(state.feature) < 0) return false;
    switch (state.show) {
      case 'untranslated': if (!statusIn(m, 'untranslated')) return false; break;
      case 'missing': case 'blank': case 'same': if (!statusIn(m, state.show)) return false; break;
      case 'unused': if (!scanned || m.files.length) return false; break;
      case 'notes': if (!m.note) return false; break;
      default: if (state.show.indexOf('scope:') === 0 && m.scopes.indexOf(state.show.slice(6)) < 0) return false;
    }
    if (state.query) {
      var q = state.query.toLowerCase();
      if (m.id.toLowerCase().indexOf(q) < 0 && m.text.toLowerCase().indexOf(q) < 0) return false;
    }
    return true;
  }
  var perLocale = otherNames.length <= 5;
  var head = document.getElementById('table-head');
  head.append(h('th', null, 'Message'));
  if (perLocale) otherNames.forEach(function (l) { head.append(h('th', { class: 'locale' }, l)); });
  else if (otherNames.length) head.append(h('th', { class: 'locale' }, 'Translations'));
  head.append(h('th', null, 'Used in'), h('th', null, 'ICU'));
  function statusBadge(locale, st, labelled) {
    var text = st === 'translated' ? (labelled ? locale : '') : (labelled ? locale + ' ' : '') + statusLabel[st].toLowerCase();
    return h('span', { class: 'st ' + st, title: locale + ': ' + statusLabel[st] }, h('i'), text);
  }
  function renderTable() {
    var body = fill('table-body');
    var rows = data.messages.filter(matches);
    document.getElementById('count').textContent = n(rows.length) + ' of ' + plural(data.messages.length, 'message');
    rows.slice(0, state.limit).forEach(function (m) {
      var tr = h('tr', { class: 'msg', tabindex: 0, 'aria-expanded': 'false' });
      tr.append(h('td', null, h('div', { class: 'mid' }, m.id), h('div', { class: 'mtext', title: m.text }, m.text || '(blank)')));
      if (perLocale) otherNames.forEach(function (l) { tr.append(h('td', { class: 'locale' }, statusBadge(l, m.status[l] || 'missing', false))); });
      else if (otherNames.length) {
        var gaps = otherNames.filter(function (l) { return (m.status[l] || 'missing') !== 'translated'; });
        tr.append(h('td', { class: 'locale' }, gaps.length ? gaps.map(function (l) { return statusBadge(l, m.status[l] || 'missing', true); }) : statusBadge('all', 'translated', true)));
      }
      tr.append(h('td', { class: 'used' }, !scanned ? '—' : m.files.length ? plural(m.files.length, 'file') : h('span', { class: 'chip unused' }, 'unused')));
      tr.append(h('td', null, h('div', { class: 'features' }, m.features.map(function (f) { return h('span', { class: 'chip' }, f); }))));
      var detail = null;
      function toggle() {
        if (detail) { detail.remove(); detail = null; tr.setAttribute('aria-expanded', 'false'); return; }
        var dl = h('dl');
        dl.append(h('dt', null, project.baseLocale), h('dd', null, m.text || '(blank)'));
        if (m.note) dl.append(h('dt', null, 'Note'), h('dd', null, m.note));
        otherNames.forEach(function (l) { var st = m.status[l] || 'missing'; dl.append(h('dt', null, l), h('dd', null, h('span', { class: 'st ' + st }, h('i'), statusLabel[st]))); });
        if (m.scopes.length) dl.append(h('dt', null, 'Scopes'), h('dd', null, m.scopes.join(', ')));
        dl.append(h('dt', null, 'Source'), h('dd', null, m.files.length ? m.files.map(function (f) { return h('div', null, h('code', null, f)); }) : scanned ? 'No reference found by the static scan.' : 'No source files scanned.'));
        detail = h('tr', { class: 'detail' }, h('td', { colspan: tr.children.length }, dl));
        tr.after(detail);
        tr.setAttribute('aria-expanded', 'true');
      }
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      body.append(tr);
    });
    if (!rows.length) body.append(h('tr', null, h('td', { colspan: head.children.length, class: 'muted', style: 'padding:24px 14px;text-align:center' }, 'No messages match these filters.')));
    var more = document.getElementById('more');
    more.hidden = rows.length <= state.limit;
    more.textContent = 'Show ' + n(Math.min(100, rows.length - state.limit)) + ' more';
    document.getElementById('shown').textContent = rows.length ? 'Showing ' + n(Math.min(rows.length, state.limit)) + ' of ' + n(rows.length) : '';
  }
  search.addEventListener('input', function () { state.query = search.value.trim(); state.limit = 100; renderTable(); });
  show.addEventListener('change', function () { state.show = show.value; state.limit = 100; renderTable(); });
  localeSelect.addEventListener('change', function () { state.locale = localeSelect.value; state.limit = 100; renderTable(); });
  featureSelect.addEventListener('change', function () { state.feature = featureSelect.value; state.limit = 100; renderTable(); });
  document.getElementById('more').addEventListener('click', function () { state.limit += 100; renderTable(); });
  syncControls();
  renderTable();

  // Highlight the section under the navigation bar.
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav a'));
  var sections = navLinks.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); });
  var marking = false;
  function markSection() {
    marking = false;
    var current = 0;
    sections.forEach(function (el, i) { if (el && el.getBoundingClientRect().top <= 96) current = i; });
    if (window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = sections.length - 1;
    navLinks.forEach(function (a, i) { a.classList.toggle('active', i === current); });
  }
  window.addEventListener('scroll', function () { if (!marking) { marking = true; requestAnimationFrame(markSection); } }, { passive: true });
  markSection();
  document.getElementById('footer').textContent = 'Generated by nordbeam-locale ' + data.tool.version + ' on ' + whenText + '. The data is embedded in this file, and the page loads nothing from the network.';
})();
`;

/** A self-contained HTML page for the report: inline styles, script and data, no network requests. */
export function renderReportPage(report: ProjectReport): string {
  const title = `${report.project.name ?? 'Project'} · translation report`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="nordbeam-locale ${escapeHtml(report.tool.version)}">
<title>${escapeHtml(title)}</title>
<style>${styles}</style>
</head>
<body>
<header class="hero"><div class="wrap">
  <div><p class="eyebrow"><span class="logo" aria-hidden="true"></span>Translation report</p><h1 id="title">${escapeHtml(report.project.name ?? 'Translation report')}</h1><p class="meta" id="meta"></p></div>
  <div class="pills" id="badges"></div>
</div></header>
<nav class="nav" aria-label="Sections"><div class="wrap">
  <a href="#overview">Overview</a><a href="#coverage">Coverage</a><a href="#namespaces">Namespaces</a><a href="#sizes">Downloads</a><a href="#scopes">Scopes</a><a href="#usage">Usage</a><a href="#features">ICU</a><a href="#diagnostics">Diagnostics</a><a href="#explorer">Messages</a>
</div></nav>
<main class="wrap">
  <section class="kpis" id="overview" aria-label="Summary"></section>
  <section class="card" id="coverage">
    <div class="card-head"><div><h2>Translation coverage</h2><p class="lede">Each locale against the base catalog. Click a segment to list those messages.</p></div></div>
    <div id="coverage-chart"></div>
    <div class="legend" id="coverage-legend"></div>
  </section>
  <section class="card" id="namespaces">
    <div class="card-head"><div><h2>Namespaces</h2><p class="lede">Area is the number of messages, and color the share that is untranslated or unused. Click a namespace to open it.</p></div>
      <div class="seg" id="treemap-mode" role="group" aria-label="Color namespaces by"><button type="button" data-mode="gaps">Untranslated</button><button type="button" data-mode="unused">Unused</button><button type="button" data-mode="size">Size only</button></div>
    </div>
    <div class="crumbs" id="treemap-crumbs"></div>
    <div class="treemap-box" id="treemap"></div>
    <div class="scale" id="treemap-scale"></div>
  </section>
  <div class="grid2">
    <section class="card" id="sizes"><div class="card-head"><div><h2>What each locale downloads</h2><p class="lede">The generated module that loadLocale fetches, compressed with brotli, before your bundler adds anything. Hover a row for the raw size.</p></div></div><div id="sizes-chart"></div></section>
    <section class="card" id="scopes"><div class="card-head"><div><h2>Scopes</h2><p class="lede">Smaller catalogs for parts of the app, and what they save.</p></div></div><div id="scopes-list"></div></section>
  </div>
  <section class="card" id="usage"><div class="card-head"><div><h2>Source usage</h2><p class="lede">Which messages the code references, found by a static scan.</p></div></div><div id="usage-body"></div></section>
  <div class="grid2">
    <section class="card" id="features"><div class="card-head"><div><h2>ICU features</h2><p class="lede">Messages in the base catalog by what they use. Click a feature to list its messages.</p></div></div><div id="features-chart"></div></section>
    <section class="card" id="diagnostics"><div class="card-head"><div><h2>Diagnostics</h2><p class="lede">What nordbeam-locale check reports for the catalogs.</p></div></div><div id="diagnostics-body"></div></section>
  </div>
  <section class="card" id="explorer">
    <div class="card-head"><div><h2>Messages</h2><p class="lede">Every message in the base catalog. Click a row for its details.</p></div></div>
    <div class="toolbar">
      <label class="search"><input id="q" type="search" placeholder="Search IDs and base text" aria-label="Search messages" autocomplete="off"></label>
      <select id="show" aria-label="Show"><option value="all">All messages</option><option value="untranslated">Untranslated</option><option value="missing">Missing</option><option value="blank">Blank</option><option value="same">Same as base text</option><option value="unused">Unused</option><option value="notes">With notes</option></select>
      <select id="locale" aria-label="Locale"><option value="">Any locale</option></select>
      <select id="feature" aria-label="ICU feature"><option value="">Any ICU feature</option></select>
      <span id="namespace-chip"></span>
      <span class="count" id="count"></span>
    </div>
    <div class="table-wrap"><table><thead><tr id="table-head"></tr></thead><tbody id="table-body"></tbody></table></div>
    <div class="pager"><span id="shown"></span><button type="button" class="btn" id="more" hidden>Show more</button></div>
  </section>
</main>
<footer class="wrap" id="footer"></footer>
<script type="application/json" id="report-data">${embed(report)}</script>
<script>${script}</script>
</body>
</html>
`;
}
