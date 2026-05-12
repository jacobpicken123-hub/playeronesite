/* ============================================
   APEX — F1 Season Creator
   Aesthetic: Pit-wall telemetry × motorsport editorial
   ============================================ */

:root {
  /* Surface — F1.com style: cool, deep, slightly blue-tinted */
  --bg: #0f0f17;
  --bg-warm: #131320;
  --bg-elev: #181826;
  --bg-card: #1a1a28;
  --bg-card-hi: #22222f;
  --bg-input: #0d0d14;
  --border: #2a2a38;
  --border-hi: #3a3a4a;
  --border-dim: #1f1f2c;

  /* Text */
  --text: #ffffff;
  --text-soft: #d8d8de;
  --text-dim: #8e8e99;
  --text-muted: #5e5e69;

  /* Accents — F1 racing palette */
  --red: #e10600;
  --red-hot: #ff1f1a;
  --red-deep: #a30400;
  --gold: #d4a857;
  --gold-glow: #f0c878;
  --silver: #c8c8cc;
  --bronze: #cd7f32;

  /* Sector / live timing colours */
  --sec-purple: #c084fc;
  --sec-green:  #34d399;
  --sec-yellow: #fbbf24;
  --sec-blue:   #60a5fa;

  /* Type — Titillium Web for display, F1's website font family */
  --f-display: 'Titillium Web', 'Arial Narrow', sans-serif;
  --f-serif:   'Instrument Serif', 'Times New Roman', serif;
  --f-mono:    'JetBrains Mono', ui-monospace, Menlo, monospace;
  --f-body:    'Titillium Web', system-ui, -apple-system, sans-serif;

  /* Geometry */
  --radius: 4px;
  --radius-lg: 8px;

  /* Motion */
  --ease: cubic-bezier(.2, .8, .2, 1);
}

/* ---------- reset ---------- */
*, *::before, *::after { box-sizing: border-box; }
* { margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--f-body);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
button, input, select, textarea { font: inherit; color: inherit; }
button { background: none; border: none; cursor: pointer; }
input, select, textarea { background: none; border: none; outline: none; }
a { color: inherit; text-decoration: none; }

/* ---------- chequered strip ---------- */
.chequer-strip {
  height: 6px;
  background-image:
    linear-gradient(45deg, #fff 25%, transparent 25%),
    linear-gradient(-45deg, #fff 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #fff 75%),
    linear-gradient(-45deg, transparent 75%, #fff 75%);
  background-size: 12px 12px;
  background-position: 0 0, 0 6px, 6px -6px, -6px 0;
  background-color: #000;
  position: sticky;
  top: 0;
  z-index: 50;
  opacity: 0.9;
}

/* ---------- top bar ---------- */
.topbar {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 14px 28px;
  background: var(--bg-warm);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 6px;
  z-index: 40;
  flex-wrap: wrap;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-right: 20px;
  border-right: 1px solid var(--border);
  height: 36px;
}
.brand-mark { color: var(--red); display: flex; }
.brand-text { display: flex; flex-direction: column; line-height: 1; }
.brand-name {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 24px;
  letter-spacing: 0.04em;
  color: var(--text);
}
.brand-tag {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.25em;
  color: var(--text-dim);
  margin-top: 4px;
}

.topbar-selectors {
  display: flex;
  gap: 12px;
  align-items: center;
  flex: 1;
  flex-wrap: wrap;
}
.topbar-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.selector {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.selector-label {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.2em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.selector select,
.selector .selector-button {
  background: var(--bg-input);
  border: 1px solid var(--border-hi);
  border-radius: 999px;
  padding: 8px 32px 8px 16px;
  font-family: var(--f-display);
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  letter-spacing: 0;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23ffffff' stroke-width='1.5' fill='none' stroke-linecap='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 14px center;
  min-width: 220px;
  transition: border-color 0.15s var(--ease);
}
.selector select:hover,
.selector .selector-button:hover { border-color: var(--border-hi); }
.selector select:focus { border-color: var(--red); }

/* ---------- tabs ---------- */
.tabs {
  display: flex;
  gap: 0;
  padding: 0 28px;
  background: var(--bg-warm);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 84px;
  z-index: 30;
  flex-wrap: wrap;
}
.tabs:empty { display: none; }
.tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 20px;
  font-family: var(--f-display);
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0;
  text-transform: none;
  color: var(--text-dim);
  border-bottom: none;
  transition: color 0.15s var(--ease);
  white-space: nowrap;
  position: relative;
  background: transparent;
  border: none;
  cursor: pointer;
}
.tab:hover { color: var(--text); }
.tab.active {
  color: var(--text);
  font-weight: 700;
}
.tab.active::after {
  content: "";
  position: absolute;
  left: 20px; right: 20px; bottom: -1px;
  height: 3px;
  background: var(--red);
  border-radius: 2px 2px 0 0;
}
.tab-num {
  font-family: var(--f-mono);
  font-size: 10px;
  font-weight: 500;
  color: var(--text-muted);
  letter-spacing: 0.05em;
  display: none; /* F1.com style: no numbering */
}
.tab.active .tab-num { color: var(--red); }

/* ---------- main ---------- */
main {
  flex: 1;
  padding: 32px 28px 80px;
  max-width: 1400px;
  width: 100%;
  margin: 0 auto;
}

/* ---------- footer ---------- */
.footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 28px;
  border-top: 1px solid var(--border);
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  background: var(--bg-warm);
}

/* ---------- buttons ---------- */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 18px;
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border: 1px solid var(--border-hi);
  border-radius: 999px;
  background: var(--bg-card);
  color: var(--text);
  cursor: pointer;
  transition: all 0.15s var(--ease);
}
.btn:hover { background: var(--bg-card-hi); border-color: var(--text-dim); }
.btn-primary {
  background: var(--red);
  border-color: var(--red);
  color: #fff;
}
.btn-primary:hover {
  background: var(--red-hot);
  border-color: var(--red-hot);
}
.btn-ghost {
  background: transparent;
  border-color: var(--border-hi);
}
.btn-ghost:hover { border-color: var(--text-dim); background: var(--bg-card); }
.btn-danger {
  border-color: var(--red-deep);
  color: var(--red-hot);
}
.btn-danger:hover {
  background: var(--red);
  color: #fff;
  border-color: var(--red);
}
.btn-sm { padding: 6px 12px; font-size: 10px; }
.btn-icon {
  padding: 7px;
  border-radius: 999px;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* ---------- generic UI ---------- */
.section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 24px;
  gap: 24px;
  flex-wrap: wrap;
}
.section-title {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 56px;
  letter-spacing: -0.005em;
  text-transform: uppercase;
  line-height: 0.95;
  color: var(--text);
}
.section-title .accent { color: var(--red); }
.section-sub {
  font-family: var(--f-mono);
  font-size: 11px;
  letter-spacing: 0.2em;
  color: var(--text-dim);
  text-transform: uppercase;
  margin-top: 6px;
}
.section-italic {
  font-family: var(--f-body);
  font-style: normal;
  font-weight: 400;
  font-size: 15px;
  color: var(--text-dim);
  margin-top: 12px;
  max-width: 640px;
  line-height: 1.5;
  letter-spacing: 0;
}

.eyebrow {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.25em;
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.eyebrow::before {
  content: "";
  width: 18px;
  height: 1px;
  background: var(--red);
}

.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  transition: border-color 0.15s var(--ease);
}
.card-hover:hover { border-color: var(--border-hi); }

.divider {
  height: 1px;
  background: var(--border);
  margin: 24px 0;
}
.divider-thick { height: 2px; background: var(--text); margin: 24px 0; }

/* form bits */
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
}
.field label {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.2em;
  color: var(--text-dim);
  text-transform: uppercase;
}
.field input[type="text"],
.field input[type="number"],
.field input[type="date"],
.field select,
.field textarea {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  font-family: var(--f-body);
  font-size: 14px;
  color: var(--text);
  transition: border-color 0.15s var(--ease);
}
.field input:focus,
.field select:focus,
.field textarea:focus { border-color: var(--red); }
.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.field-row-3 { grid-template-columns: 1fr 1fr 1fr; }
.field-help {
  font-family: var(--f-mono);
  font-size: 10px;
  color: var(--text-muted);
  letter-spacing: 0.05em;
}
input[type="color"] {
  width: 48px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: transparent;
  cursor: pointer;
  padding: 2px;
}

/* ============================================
   HOME / EMPTY STATE
   ============================================ */
.home {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 48px;
  align-items: start;
  padding-top: 24px;
}
.home-hero h1 {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: clamp(56px, 7vw, 96px);
  line-height: 0.9;
  letter-spacing: -0.02em;
  text-transform: uppercase;
  margin-bottom: 16px;
}
.home-hero h1 .red { color: var(--red); }
.home-hero h1 .italic {
  font-family: var(--f-serif);
  font-style: italic;
  text-transform: none;
  font-weight: 400;
  letter-spacing: 0;
  display: block;
  font-size: 0.65em;
  color: var(--text-soft);
  line-height: 1;
  margin-top: 8px;
}
.home-hero p.lede {
  font-family: var(--f-serif);
  font-size: 22px;
  line-height: 1.4;
  color: var(--text-soft);
  margin-bottom: 32px;
  max-width: 560px;
}
.home-hero .pillars {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 32px;
}
.pillar {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  background: rgba(20,20,22,0.4);
}
.pillar-num {
  font-family: var(--f-mono);
  font-size: 10px;
  color: var(--red);
  letter-spacing: 0.2em;
  margin-bottom: 8px;
}
.pillar h3 {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 18px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  margin-bottom: 4px;
}
.pillar p {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.5;
}

.home-saves {
  border-left: 1px solid var(--border);
  padding-left: 48px;
}
.home-saves-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 16px;
}
.home-saves-head h2 {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 28px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.save-list { display: flex; flex-direction: column; gap: 10px; }
.save-card {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.15s var(--ease);
}
.save-card:hover {
  border-color: var(--red);
  background: var(--bg-card-hi);
  transform: translateX(2px);
}
.save-card-id {
  font-family: var(--f-mono);
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0.1em;
}
.save-card-name {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 22px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.save-card-meta {
  font-family: var(--f-mono);
  font-size: 11px;
  color: var(--text-dim);
  letter-spacing: 0.05em;
  margin-top: 4px;
}
.save-card-stats {
  display: flex;
  gap: 16px;
  font-family: var(--f-mono);
  font-size: 11px;
}
.save-stat {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.save-stat-num {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 24px;
  color: var(--text);
  line-height: 1;
}
.save-stat-lbl {
  font-size: 9px;
  letter-spacing: 0.2em;
  color: var(--text-muted);
  text-transform: uppercase;
  margin-top: 2px;
}

.empty-state {
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  padding: 32px;
  text-align: center;
  color: var(--text-dim);
}
.empty-state-icon {
  font-family: var(--f-display);
  font-size: 48px;
  color: var(--text-muted);
  font-weight: 900;
  letter-spacing: 0.1em;
}

/* ============================================
   DASHBOARD
   ============================================ */
.dash-hero {
  display: grid;
  grid-template-columns: 1.5fr 1fr;
  gap: 24px;
  margin-bottom: 32px;
}
.dash-hero-main {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 32px;
  position: relative;
  overflow: hidden;
}
.dash-hero-main::before { display: none; }
.dash-hero-year {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 96px;
  line-height: 0.9;
  letter-spacing: -0.01em;
  color: var(--text);
}
.dash-hero-year .slash { color: var(--red); }
.dash-hero-name {
  font-family: var(--f-display);
  font-style: normal;
  font-weight: 600;
  font-size: 22px;
  text-transform: uppercase;
  letter-spacing: 0;
  color: var(--text-dim);
  margin-top: 12px;
}
.dash-hero-progress {
  margin-top: 24px;
  display: flex;
  gap: 24px;
  align-items: flex-end;
}
.progress-track {
  flex: 1;
  height: 6px;
  background: var(--border-dim);
  border-radius: 3px;
  overflow: hidden;
  position: relative;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--red) 0%, var(--red-hot) 100%);
  transition: width 0.4s var(--ease);
  position: relative;
}
.progress-fill::after {
  content: "";
  position: absolute;
  right: -6px; top: -2px;
  width: 10px; height: 10px;
  background: var(--red-hot);
  border-radius: 50%;
  box-shadow: 0 0 12px var(--red-hot);
}
.progress-pct {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 32px;
  line-height: 1;
}
.progress-pct .small { font-size: 16px; color: var(--text-dim); }

.dash-stats {
  display: grid;
  grid-template-rows: 1fr 1fr;
  gap: 24px;
}
.dash-stat-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  position: relative;
  overflow: hidden;
}
.dash-stat-card.leader::before {
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 100% 0%, rgba(212,168,87,0.12), transparent 60%);
  pointer-events: none;
}
.dash-stat-num {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 56px;
  line-height: 1;
  letter-spacing: -0.02em;
}
.dash-stat-name {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 16px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-top: 4px;
}
.dash-stat-context {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.15em;
  color: var(--text-muted);
  text-transform: uppercase;
}

/* dashboard grid */
.dash-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  margin-top: 32px;
}
.dash-block { }
.dash-block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}
.dash-block-title {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 20px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.dash-block-link {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.15em;
  color: var(--text-dim);
  text-transform: uppercase;
}
.dash-block-link:hover { color: var(--red); }

.next-race-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 24px;
  position: relative;
}
.next-race-flag {
  font-family: var(--f-mono);
  font-size: 10px;
  color: var(--red);
  letter-spacing: 0.25em;
  text-transform: uppercase;
  margin-bottom: 8px;
}
.next-race-name {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 32px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  line-height: 1;
}
.next-race-circuit {
  font-family: var(--f-serif);
  font-style: italic;
  font-size: 18px;
  color: var(--text-soft);
  margin-top: 8px;
}
.next-race-meta {
  display: flex;
  gap: 24px;
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px dashed var(--border);
}
.next-race-meta-item .lbl {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.2em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.next-race-meta-item .val {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 16px;
  margin-top: 2px;
}

/* ============================================
   DRIVER / TEAM CARDS
   ============================================ */
.grid-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

.driver-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  position: relative;
  transition: all 0.2s var(--ease);
}
.driver-card:hover {
  border-color: var(--border-hi);
  transform: translateY(-2px);
}
.driver-stripe {
  height: 4px;
  background: var(--team-color, var(--red));
}
.driver-card-body { padding: 18px; }
.driver-num {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 64px;
  line-height: 0.85;
  letter-spacing: -0.04em;
  color: var(--team-color, var(--text));
  -webkit-text-stroke: 0;
  position: absolute;
  top: 12px;
  right: 16px;
  opacity: 0.85;
}
.driver-name {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 20px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  line-height: 1.1;
  max-width: 60%;
}
.driver-name .first {
  display: block;
  font-weight: 500;
  font-size: 14px;
  color: var(--text-dim);
  letter-spacing: 0.06em;
}
.driver-team {
  font-family: var(--f-mono);
  font-size: 11px;
  color: var(--text-dim);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-top: 12px;
}
.driver-flag {
  position: absolute;
  bottom: 16px;
  right: 16px;
  font-family: var(--f-mono);
  font-size: 11px;
  letter-spacing: 0.15em;
  color: var(--text-muted);
}
.driver-stats-row {
  display: flex;
  gap: 16px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.driver-stat {
  display: flex;
  flex-direction: column;
}
.driver-stat-num {
  font-family: var(--f-mono);
  font-weight: 600;
  font-size: 16px;
  color: var(--text);
}
.driver-stat-lbl {
  font-family: var(--f-mono);
  font-size: 9px;
  color: var(--text-muted);
  letter-spacing: 0.15em;
  text-transform: uppercase;
  margin-top: 2px;
}
.driver-card-actions {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s var(--ease);
}
.driver-card:hover .driver-card-actions { opacity: 1; }

/* team cards */
.team-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  transition: all 0.2s var(--ease);
  position: relative;
}
.team-card:hover { border-color: var(--border-hi); }
.team-stripe {
  height: 50px;
  background: var(--team-color);
  position: relative;
  display: flex;
  align-items: center;
  padding: 0 20px;
}
.team-stripe::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, rgba(0,0,0,0.2), transparent 60%);
}
.team-short {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 32px;
  letter-spacing: 0.06em;
  color: rgba(255,255,255,0.95);
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
  position: relative;
  z-index: 1;
}
.team-card-body { padding: 18px; }
.team-name {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 18px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.team-country {
  font-family: var(--f-mono);
  font-size: 10px;
  color: var(--text-dim);
  letter-spacing: 0.15em;
  margin-top: 4px;
}
.team-drivers-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.team-driver-row {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.team-driver-num {
  font-family: var(--f-mono);
  font-weight: 600;
  color: var(--team-color);
  font-size: 13px;
}
.team-driver-name { font-weight: 500; }
.team-driver-pts {
  font-family: var(--f-mono);
  color: var(--text-dim);
  font-size: 11px;
}
.team-card-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s var(--ease);
  z-index: 3;
}
.team-card:hover .team-card-actions { opacity: 1; }

/* ============================================
   CALENDAR
   ============================================ */
.race-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.race-row {
  display: grid;
  grid-template-columns: 60px 1fr 200px 120px 80px auto;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.15s var(--ease);
  position: relative;
}
.race-row:hover {
  border-color: var(--border-hi);
  background: var(--bg-card-hi);
}
.race-row.completed::before {
  content: "";
  position: absolute;
  left: 0; top: 50%;
  width: 3px; height: 60%;
  background: var(--sec-green);
  transform: translateY(-50%);
}
.race-row.next::before {
  content: "";
  position: absolute;
  left: 0; top: 50%;
  width: 3px; height: 60%;
  background: var(--red);
  transform: translateY(-50%);
}
.race-round {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 28px;
  color: var(--text-muted);
  text-align: center;
  line-height: 1;
}
.race-row.completed .race-round { color: var(--sec-green); }
.race-row.next .race-round { color: var(--red); }
.race-info { min-width: 0; }
.race-info .name {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 18px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.race-info .circuit {
  font-family: var(--f-serif);
  font-style: italic;
  font-size: 13px;
  color: var(--text-dim);
}
.race-winner {
  font-family: var(--f-mono);
  font-size: 12px;
  color: var(--text);
}
.race-winner .lbl {
  font-size: 9px;
  color: var(--text-muted);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 2px;
}
.race-date {
  font-family: var(--f-mono);
  font-size: 11px;
  color: var(--text-dim);
  letter-spacing: 0.05em;
}
.race-flags { display: flex; gap: 4px; }
.race-flag {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.15em;
  padding: 3px 6px;
  border: 1px solid var(--border-hi);
  border-radius: 2px;
  color: var(--text-dim);
  text-transform: uppercase;
}
.race-flag.sprint { color: var(--sec-yellow); border-color: var(--sec-yellow); }
.race-flag.done   { color: var(--sec-green); border-color: var(--sec-green); }
.race-actions {
  display: flex;
  gap: 4px;
}

/* ============================================
   STANDINGS TABLE
   ============================================ */
.standings-tabs {
  display: flex;
  gap: 0;
  margin-bottom: 24px;
  border-bottom: 1px solid var(--border);
}
.standings-tab {
  padding: 12px 20px;
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-dim);
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.standings-tab.active {
  color: var(--text);
  border-bottom-color: var(--red);
}

.standings-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--f-display);
  font-size: 13px;
}
.standings-table thead th {
  text-align: left;
  padding: 14px 16px;
  font-family: var(--f-display);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  text-transform: uppercase;
  border-bottom: 1px solid var(--border);
}
.standings-table thead th.num,
.standings-table tbody td.num { text-align: right; }
.standings-table tbody tr {
  border-bottom: 1px solid var(--border-dim);
  transition: background 0.1s var(--ease);
}
.standings-table tbody tr:hover { background: rgba(255,255,255,0.02); }
.standings-table tbody td {
  padding: 16px;
  font-size: 13px;
  font-family: var(--f-display);
  font-weight: 500;
}
.pos-cell {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 16px;
  width: 60px;
  color: var(--text);
}
.standings-row.p1 .pos-cell { color: var(--gold); }
.standings-row.p2 .pos-cell { color: var(--silver); }
.standings-row.p3 .pos-cell { color: var(--bronze); }
.standings-row.p1 td:first-of-type { box-shadow: inset 3px 0 0 var(--gold); }
.standings-row.p2 td:first-of-type { box-shadow: inset 3px 0 0 var(--silver); }
.standings-row.p3 td:first-of-type { box-shadow: inset 3px 0 0 var(--bronze); }

.driver-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}
.driver-cell-num {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 14px;
  color: var(--driver-color, var(--text-dim));
  width: 28px;
}
.driver-cell-name {
  font-family: var(--f-body);
  font-weight: 600;
  font-size: 13px;
}
.driver-cell-team {
  font-family: var(--f-mono);
  font-size: 10px;
  color: var(--text-muted);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.team-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--f-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.team-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--team-color);
}
.points-cell {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 20px;
  text-align: right;
}
.gap-cell {
  font-family: var(--f-mono);
  color: var(--text-muted);
  font-size: 11px;
  text-align: right;
}

/* ============================================
   RACE RESULTS / EDITOR
   ============================================ */
.race-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 32px;
  flex-wrap: wrap;
}
.race-header-left { display: flex; align-items: center; gap: 24px; }
.race-back-btn {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.2em;
  color: var(--text-dim);
  text-transform: uppercase;
}
.race-back-btn:hover { color: var(--red); }
.race-round-big {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 96px;
  line-height: 0.85;
  color: var(--red);
  -webkit-text-stroke: 1px var(--red);
}
.race-round-big.muted { color: transparent; }
.race-title-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.race-title-block .name {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 56px;
  line-height: 0.95;
  letter-spacing: -0.01em;
  text-transform: uppercase;
}
.race-title-block .circuit {
  font-family: var(--f-serif);
  font-style: italic;
  font-size: 22px;
  color: var(--text-soft);
}
.race-meta-strip {
  display: flex;
  gap: 32px;
  padding: 16px 20px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 24px;
  align-items: center;
}
.race-meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.race-meta-item .lbl {
  font-family: var(--f-mono);
  font-size: 9px;
  color: var(--text-muted);
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
.race-meta-item .val {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.04em;
}

.results-editor {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0;
  overflow: hidden;
}
.results-editor-head {
  display: grid;
  grid-template-columns: 60px 1fr 80px 80px 80px;
  gap: 12px;
  padding: 12px 20px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.2em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.result-row {
  display: grid;
  grid-template-columns: 60px 1fr 80px 80px 80px;
  gap: 12px;
  align-items: center;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border-dim);
  transition: background 0.1s var(--ease);
}
.result-row:hover { background: rgba(255,255,255,0.02); }
.result-row:last-child { border-bottom: none; }
.result-pos-input {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px;
  font-family: var(--f-mono);
  font-weight: 600;
  text-align: center;
  width: 100%;
  color: var(--text);
}
.result-pos-input:focus { border-color: var(--red); }
.result-driver {
  display: flex;
  align-items: center;
  gap: 12px;
}
.result-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.15em;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 2px;
  cursor: pointer;
  text-transform: uppercase;
  color: var(--text-muted);
  background: transparent;
  transition: all 0.1s var(--ease);
}
.result-toggle:hover { border-color: var(--border-hi); color: var(--text); }
.result-toggle.on.fl { background: var(--sec-purple); color: #1a0a2e; border-color: var(--sec-purple); }
.result-toggle.on.pole { background: var(--sec-yellow); color: #2a1a00; border-color: var(--sec-yellow); }
.result-toggle.on.dnf { background: var(--red); color: #fff; border-color: var(--red); }

.results-editor-foot {
  padding: 16px 20px;
  background: var(--bg-elev);
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.results-help {
  font-family: var(--f-mono);
  font-size: 10px;
  color: var(--text-muted);
  letter-spacing: 0.05em;
}

/* completed race readout */
.race-readout-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 32px;
}
.podium {
  display: grid;
  grid-template-columns: 1fr 1.2fr 1fr;
  align-items: end;
  gap: 8px;
  margin-bottom: 24px;
}
.podium-step {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 12px;
  text-align: center;
  position: relative;
}
.podium-step.p1 {
  border-color: var(--gold);
  background: linear-gradient(180deg, rgba(212,168,87,0.12), var(--bg-card));
  min-height: 200px;
}
.podium-step.p2 {
  border-color: var(--silver);
  background: linear-gradient(180deg, rgba(200,200,204,0.08), var(--bg-card));
  min-height: 170px;
}
.podium-step.p3 {
  border-color: var(--bronze);
  background: linear-gradient(180deg, rgba(205,127,50,0.10), var(--bg-card));
  min-height: 145px;
}
.podium-pos {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 64px;
  line-height: 0.8;
  letter-spacing: -0.04em;
}
.podium-step.p1 .podium-pos { color: var(--gold); }
.podium-step.p2 .podium-pos { color: var(--silver); }
.podium-step.p3 .podium-pos { color: var(--bronze); }
.podium-name {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 14px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  margin-top: 8px;
  line-height: 1.1;
}
.podium-team {
  font-family: var(--f-mono);
  font-size: 10px;
  color: var(--text-dim);
  letter-spacing: 0.1em;
  margin-top: 4px;
  text-transform: uppercase;
}

/* ============================================
   RECORDS
   ============================================ */
.records-hero {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  margin-bottom: 32px;
}
.record-feature {
  background: linear-gradient(135deg, var(--bg-card), var(--bg-elev));
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 28px;
  position: relative;
  overflow: hidden;
}
.record-feature::after {
  content: "";
  position: absolute;
  top: -40px; right: -40px;
  width: 160px; height: 160px;
  background: radial-gradient(circle, rgba(212,168,87,0.12), transparent 70%);
}
.record-feature .eyebrow { color: var(--gold); }
.record-feature .eyebrow::before { background: var(--gold); }
.record-feature-num {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 88px;
  line-height: 0.85;
  letter-spacing: -0.02em;
  color: var(--gold);
}
.record-feature-name {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 24px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-top: 8px;
}
.record-feature-cat {
  font-family: var(--f-serif);
  font-style: italic;
  font-size: 18px;
  color: var(--text-soft);
  margin-top: 4px;
}

.records-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}
.record-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
}
.record-card-title {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 16px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.record-card-title .badge {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.15em;
  color: var(--text-muted);
  border: 1px solid var(--border);
  padding: 2px 6px;
  border-radius: 2px;
}
.record-list { display: flex; flex-direction: column; gap: 8px; }
.record-row {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-dim);
}
.record-row:last-child { border-bottom: none; }
.record-row .rank {
  font-family: var(--f-mono);
  font-size: 11px;
  color: var(--text-muted);
}
.record-row.first .rank { color: var(--gold); font-weight: 700; }
.record-row .name {
  font-family: var(--f-body);
  font-weight: 500;
  font-size: 13px;
}
.record-row .name .ctx {
  display: block;
  font-family: var(--f-mono);
  font-size: 10px;
  color: var(--text-muted);
  letter-spacing: 0.05em;
  margin-top: 2px;
}
.record-row .val {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 18px;
}
.record-row.first .val { color: var(--gold); }

/* ============================================
   MODAL
   ============================================ */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.7);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  animation: fade 0.2s var(--ease);
}
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
.modal {
  background: var(--bg-elev);
  border: 1px solid var(--border-hi);
  border-radius: var(--radius);
  width: 100%;
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
  position: relative;
  animation: rise 0.25s var(--ease);
}
@keyframes rise { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.modal-head {
  padding: 20px 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: sticky;
  top: 0;
  background: var(--bg-elev);
  z-index: 1;
}
.modal-title {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 22px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.modal-title .accent { color: var(--red); }
.modal-close {
  width: 32px; height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius);
  color: var(--text-dim);
  font-size: 18px;
}
.modal-close:hover { background: var(--bg-card); color: var(--text); }
.modal-body { padding: 24px; }
.modal-foot {
  padding: 16px 24px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* confirm modal */
.modal.confirm { max-width: 440px; }
.modal.confirm .modal-body p { color: var(--text-soft); line-height: 1.5; }

/* ============================================
   TOAST
   ============================================ */
#toast-root {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  background: var(--bg-elev);
  border: 1px solid var(--border-hi);
  border-left: 3px solid var(--red);
  border-radius: var(--radius);
  padding: 12px 18px;
  font-family: var(--f-mono);
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--text);
  min-width: 240px;
  animation: slide 0.3s var(--ease);
  pointer-events: auto;
}
.toast.success { border-left-color: var(--sec-green); }
.toast.warn { border-left-color: var(--sec-yellow); }
.toast.error { border-left-color: var(--red); }
.toast.fading { animation: fadeOut 0.3s var(--ease) forwards; }
@keyframes slide { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes fadeOut { to { transform: translateX(20px); opacity: 0; } }

/* ============================================
   MISC
   ============================================ */
.empty {
  text-align: center;
  padding: 64px 24px;
  color: var(--text-dim);
}
.empty-headline {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 56px;
  letter-spacing: -0.01em;
  text-transform: uppercase;
  color: var(--text);
  margin-bottom: 8px;
}
.empty-sub {
  font-family: var(--f-serif);
  font-style: italic;
  font-size: 18px;
  color: var(--text-soft);
  max-width: 480px;
  margin: 0 auto 24px;
}

.tag {
  display: inline-flex;
  align-items: center;
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  padding: 3px 7px;
  border: 1px solid var(--border-hi);
  border-radius: 2px;
  color: var(--text-dim);
}
.tag.gold { color: var(--gold); border-color: var(--gold); }
.tag.red { color: var(--red); border-color: var(--red); }

/* responsive */
@media (max-width: 980px) {
  .home { grid-template-columns: 1fr; }
  .home-saves { border-left: none; padding-left: 0; border-top: 1px solid var(--border); padding-top: 32px; }
  .dash-hero { grid-template-columns: 1fr; }
  .dash-grid { grid-template-columns: 1fr; }
  .records-hero { grid-template-columns: 1fr; }
  .race-row {
    grid-template-columns: 50px 1fr auto;
    grid-template-rows: auto auto;
  }
  .race-row .race-winner,
  .race-row .race-date { grid-column: 2 / -1; }
  .results-editor-head, .result-row {
    grid-template-columns: 50px 1fr 60px 60px 60px;
    gap: 8px;
    padding: 10px 12px;
  }
  .section-title { font-size: 36px; }
  .race-title-block .name { font-size: 36px; }
  .race-round-big { font-size: 56px; }
}

/* selection */
::selection { background: var(--red); color: #fff; }

/* scrollbar */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: var(--bg-warm); }
::-webkit-scrollbar-thumb { background: var(--border-hi); border-radius: 5px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

/* ============================================
   DRIVER PHOTOS / TEAM LOGOS / PRESETS
   ============================================ */
.driver-photo {
  position: absolute;
  left: 14px;
  bottom: 14px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--bg-elev) center/cover no-repeat;
  border: 2px solid var(--team-color, var(--border-hi));
  z-index: 1;
}
.driver-photo-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 18px;
  color: var(--team-color, var(--text-dim));
  letter-spacing: -0.02em;
  text-transform: uppercase;
}
.driver-card.has-photo .driver-card-body { padding-left: 84px; min-height: 96px; }
.driver-card.has-photo .driver-name { max-width: 55%; }

.team-logo {
  width: 36px;
  height: 36px;
  border-radius: 4px;
  background: rgba(0,0,0,0.25) center/contain no-repeat;
  flex-shrink: 0;
  border: 1px solid rgba(255,255,255,0.15);
}
.team-stripe-with-logo {
  height: 64px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  position: relative;
}
.team-stripe-with-logo::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, rgba(0,0,0,0.25), transparent 60%);
  pointer-events: none;
}
.team-stripe-with-logo .team-short {
  font-size: 28px;
  position: relative;
  z-index: 1;
}

/* photo upload field */
.photo-upload {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 12px;
  align-items: center;
  padding: 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.photo-preview {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--bg-card) center/cover no-repeat;
  border: 1px solid var(--border-hi);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 18px;
  color: var(--text-muted);
}
.photo-preview.logo { border-radius: 6px; }
.photo-controls {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.photo-controls input[type="text"] {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 8px;
  font-family: var(--f-mono);
  font-size: 11px;
  color: var(--text);
  min-width: 0;
}
.photo-controls input[type="text"]:focus { border-color: var(--red); }
.photo-controls-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.photo-file-btn {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 10px;
  letter-spacing: 0.15em;
  padding: 5px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-hi);
  border-radius: 2px;
  cursor: pointer;
  color: var(--text);
  text-transform: uppercase;
  white-space: nowrap;
}
.photo-file-btn:hover { background: var(--bg-card-hi); }
.photo-clear-btn {
  font-family: var(--f-mono);
  font-size: 10px;
  color: var(--text-muted);
  padding: 4px 8px;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}
.photo-clear-btn:hover { color: var(--red); }

/* preset search modal */
.modal.wide { max-width: 760px; }
.preset-search-bar {
  display: flex;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  position: sticky;
  top: 0;
  z-index: 1;
}
.preset-search-bar input {
  flex: 1;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 9px 12px;
  font-family: var(--f-body);
  font-size: 14px;
  color: var(--text);
}
.preset-search-bar input:focus { border-color: var(--red); }
.preset-filters {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-warm);
}
.preset-filter {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.15em;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 2px;
  cursor: pointer;
  color: var(--text-dim);
  background: transparent;
  text-transform: uppercase;
}
.preset-filter:hover { color: var(--text); border-color: var(--border-hi); }
.preset-filter.active { background: var(--red); color: #fff; border-color: var(--red); }

.preset-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  padding: 16px 20px;
  max-height: 480px;
  overflow-y: auto;
}
.preset-row {
  display: grid;
  grid-template-columns: 38px 32px 1fr auto 26px auto;
  gap: 10px;
  align-items: center;
  padding: 8px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.12s var(--ease);
}
.preset-row:hover {
  border-color: var(--red);
  background: var(--bg-card-hi);
}
.preset-row.added {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Portrait shown as the first cell of every preset row */
.preset-portrait {
  width: 38px; height: 38px;
  border-radius: 50%;
  background: var(--bg-elev) center/cover no-repeat;
  border: 2px solid var(--border-hi);
  flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--f-display); font-weight: 900; font-size: 11px;
  color: var(--text-dim);
}
.preset-portrait-fallback {
  background: var(--bg-card);
}

/* Inline edit (✎) button next to preset row */
.preset-edit-btn {
  width: 26px; height: 26px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  padding: 0;
  transition: all 0.12s var(--ease);
}
.preset-edit-btn:hover {
  color: var(--red); border-color: var(--red);
  background: rgba(225,6,0,0.08);
}

/* Small badges next to a preset name to flag custom or edited state */
.preset-badge {
  display: inline-block;
  font-family: var(--f-mono);
  font-size: 8px;
  letter-spacing: 0.18em;
  padding: 2px 5px;
  border-radius: 2px;
  vertical-align: middle;
  margin-left: 6px;
  font-weight: 600;
  text-transform: uppercase;
}
.preset-badge.custom { color: var(--sec-green); border: 1px solid var(--sec-green); }
.preset-badge.edited { color: var(--sec-yellow); border: 1px solid var(--sec-yellow); }

/* Photo upload widget reused in preset editor */
.photo-upload {
  display: flex;
  gap: 12px;
  align-items: center;
}
.photo-upload .photo-preview {
  width: 80px; height: 80px;
  border-radius: 50%;
  background: var(--bg-elev) center/cover no-repeat;
  border: 2px solid var(--border-hi);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.preset-num {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 18px;
  color: var(--red);
  text-align: center;
}
.preset-name {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  line-height: 1.1;
}
.preset-meta {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.15em;
  color: var(--text-muted);
  margin-top: 2px;
  text-transform: uppercase;
}
.preset-flag {
  font-family: var(--f-mono);
  font-size: 10px;
  color: var(--text-dim);
  letter-spacing: 0.1em;
}
.preset-add-btn {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 9px;
  letter-spacing: 0.18em;
  padding: 5px 9px;
  background: var(--red);
  color: #fff;
  border-radius: 2px;
  text-transform: uppercase;
  border: 1px solid var(--red);
  cursor: pointer;
  flex-shrink: 0;
}
.preset-row.added .preset-add-btn {
  background: transparent;
  color: var(--sec-green);
  border-color: var(--sec-green);
  pointer-events: none;
}

.preset-empty {
  grid-column: 1 / -1;
  padding: 32px;
  text-align: center;
  color: var(--text-muted);
  font-family: var(--f-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
}

/* points-system pill on dashboard */
.points-system-tag {
  display: inline-block;
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  padding: 3px 8px;
  border: 1px solid var(--border-hi);
  border-radius: 2px;
  color: var(--text-dim);
  text-transform: uppercase;
  margin-top: 8px;
}

/* DSQ / DNS / championship-DSQ states */
.btn-icon.active-dsq { color: var(--red); border-color: var(--red); background: rgba(225,6,0,0.08); }
.driver-card.champ-dsq, .team-card.champ-dsq { opacity: 0.45; filter: grayscale(0.6); }
.driver-card.champ-dsq::after, .team-card.champ-dsq::after {
  content: 'DSQ';
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%) rotate(-15deg);
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 56px;
  color: var(--red);
  border: 4px solid var(--red);
  padding: 6px 18px;
  letter-spacing: 0.1em;
  pointer-events: none;
  background: rgba(11,11,13,0.6);
}
.result-row.champ-dsq { opacity: 0.5; }
.result-toggle.dsq.on { background: var(--red); color: #fff; border-color: var(--red); }
.result-toggle.dns.on { background: var(--text-muted); color: #fff; border-color: var(--text-muted); }

/* Premade season library */
.season-library {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  padding: 16px 20px;
  max-height: 540px;
  overflow-y: auto;
}
.season-lib-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  cursor: pointer;
  transition: all 0.12s var(--ease);
  position: relative;
}
.season-lib-card:hover { border-color: var(--red); background: var(--bg-card-hi); transform: translateY(-2px); }
.season-lib-year {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 36px;
  letter-spacing: -0.02em;
  line-height: 1;
  color: var(--text);
}
.season-lib-year .accent { color: var(--red); }
.season-lib-name {
  font-family: var(--f-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--text-dim);
  text-transform: uppercase;
  margin-top: 6px;
}
.season-lib-meta {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  margin-top: 10px;
  text-transform: uppercase;
}
.season-lib-champ {
  font-family: var(--f-body);
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  margin-top: 8px;
}
.season-lib-champ .crown { color: var(--gold); margin-right: 4px; }

/* Records click-through */
.records-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.record-tile {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px;
  cursor: pointer;
  transition: all 0.12s var(--ease);
}
.record-tile:hover { border-color: var(--red); background: var(--bg-card-hi); }
.record-tile-label {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.record-tile-leader {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 20px;
  letter-spacing: 0.01em;
  margin-top: 10px;
  text-transform: uppercase;
}
.record-tile-value {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 36px;
  color: var(--red);
  letter-spacing: -0.02em;
  line-height: 1;
}
.record-tile-empty { color: var(--text-muted); font-style: italic; }
.record-tile-empty-mark {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 28px;
  color: var(--text-dim);
  line-height: 1;
  margin-bottom: 6px;
  letter-spacing: -0.04em;
}
.record-tile-empty-label {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
  font-style: normal;
}
.record-tile-cta {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.2em;
  color: var(--red);
  text-transform: uppercase;
  margin-top: 12px;
}

.record-detail-list {
  max-height: 540px;
  overflow-y: auto;
}
.record-detail-row {
  display: grid;
  grid-template-columns: 40px 1fr 90px;
  gap: 12px;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}
.record-detail-row:hover { background: var(--bg-card-hi); }
.record-detail-rank {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 18px;
  color: var(--text);
}
.record-detail-rank.gold   { color: var(--gold); }
.record-detail-rank.silver { color: var(--silver); }
.record-detail-rank.bronze { color: var(--bronze); }
.record-detail-name {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.record-detail-meta {
  font-family: var(--f-mono);
  font-size: 10px;
  color: var(--text-muted);
  letter-spacing: 0.1em;
  margin-top: 2px;
}
.record-detail-value {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 22px;
  color: var(--red);
  text-align: right;
}

/* Settings toggle row for pole/FL bonus controls */
.settings-toggle-row {
  display: grid;
  grid-template-columns: 22px 1fr 70px;
  gap: 12px;
  align-items: center;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-card);
  margin-bottom: 8px;
  cursor: pointer;
}
.settings-toggle-row input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--red);
  margin: 0;
}
.settings-toggle-text {
  min-width: 0;
}
.settings-toggle-title {
  font-family: var(--f-body);
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
}
.settings-toggle-sub {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-top: 2px;
}
.settings-num {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 8px;
  font-family: var(--f-mono);
  font-size: 13px;
  color: var(--text);
  text-align: center;
}
.settings-num:focus { border-color: var(--red); outline: none; }

/* Qualifying results section in race editor */
.quali-grid {
  display: grid;
  grid-template-columns: 60px 1fr 90px;
  gap: 0;
}
.quali-grid .results-editor-head {
  display: grid;
  grid-template-columns: 60px 1fr 90px !important;
}
.quali-row {
  display: grid;
  grid-template-columns: 60px 1fr 90px;
  gap: 12px;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-soft);
}
.quali-row:last-child { border-bottom: none; }
.quali-time {
  font-family: var(--f-mono);
  font-size: 12px;
  color: var(--text-dim);
  text-align: right;
}
.quali-time input {
  width: 90px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 5px 7px;
  font-family: var(--f-mono);
  font-size: 11px;
  color: var(--text);
  text-align: center;
}

/* Driver season-stats table */
.season-stats-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--f-mono);
  font-size: 11px;
}
.season-stats-table th {
  text-align: left;
  padding: 10px 8px;
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
  text-transform: uppercase;
  white-space: nowrap;
}
.season-stats-table td {
  padding: 9px 8px;
  border-bottom: 1px solid var(--border-soft);
  white-space: nowrap;
}
.season-stats-table tr:hover td { background: var(--bg-card-hi); cursor: pointer; }
.season-stats-driver {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text);
}
.season-stats-num {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 14px;
  color: var(--text);
  text-align: right;
}
.season-stats-num.zero { color: var(--text-muted); }

/* Driver race-by-race grid for season stats detail */
.race-by-race {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(54px, 1fr));
  gap: 4px;
  margin-top: 12px;
}
.race-cell {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 6px 4px;
  text-align: center;
  position: relative;
}
.race-cell-round {
  font-family: var(--f-mono);
  font-size: 8px;
  letter-spacing: 0.1em;
  color: var(--text-muted);
}
.race-cell-pos {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 18px;
  letter-spacing: -0.02em;
  margin-top: 1px;
  color: var(--text);
}
.race-cell-pos.gold   { color: var(--gold); }
.race-cell-pos.silver { color: var(--silver); }
.race-cell-pos.bronze { color: var(--bronze); }
.race-cell-pos.dnf    { color: var(--red); font-size: 14px; padding-top: 4px; }
.race-cell-pos.dsq    { color: var(--red); font-size: 14px; padding-top: 4px; }
.race-cell-pos.dns    { color: var(--text-muted); font-size: 14px; padding-top: 4px; }
.race-cell.has-pole::after,
.race-cell.has-fl::after {
  content: "";
  position: absolute;
  top: 3px; right: 3px;
  width: 6px; height: 6px; border-radius: 50%;
}
.race-cell.has-pole::after { background: var(--sec-yellow); }
.race-cell.has-fl::after { background: var(--sec-purple); right: 11px; }

/* Head-to-head comparison */
.h2h-pickers {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 16px;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.h2h-vs {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 30px;
  color: var(--red);
}
.h2h-pickers select {
  width: 100%;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
  font-family: var(--f-body);
  font-size: 13px;
  color: var(--text);
}
.h2h-stats {
  padding: 16px 20px;
  display: grid;
  grid-template-rows: auto;
  gap: 8px;
}
.h2h-row {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 12px;
}
.h2h-label {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
  text-align: center;
  padding: 0 8px;
  white-space: nowrap;
}
.h2h-bar {
  position: relative;
  height: 28px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 3px;
  overflow: hidden;
}
.h2h-bar.left  { transform: scaleX(-1); }
.h2h-bar-fill  {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, var(--red), rgba(225,6,0,0.4));
}
.h2h-bar-fill.right { background: linear-gradient(90deg, var(--sec-blue), rgba(96,165,250,0.4)); }
.h2h-bar-val {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 14px;
  color: var(--text);
  padding: 0 10px;
}
.h2h-bar.left .h2h-bar-val { transform: scaleX(-1); }
.h2h-bar.left .h2h-bar-val { justify-content: flex-end; }
.h2h-bar.right .h2h-bar-val { justify-content: flex-end; }
.h2h-driver-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.h2h-driver-head.right { flex-direction: row-reverse; text-align: right; }
.h2h-portrait {
  width: 48px; height: 48px; border-radius: 50%;
  background: var(--bg-card) center/cover no-repeat;
  border: 2px solid var(--team-color, var(--border-hi));
  flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--f-display); font-weight: 900; font-size: 14px;
  color: var(--team-color, var(--text-dim));
}
.h2h-driver-name {
  font-family: var(--f-display); font-weight: 700;
  font-size: 14px; text-transform: uppercase; letter-spacing: 0.02em;
}
.h2h-driver-team {
  font-family: var(--f-mono); font-size: 10px;
  color: var(--text-muted); letter-spacing: 0.1em;
}
.h2h-headline {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 16px;
  padding: 12px 20px 16px;
  align-items: end;
}
.h2h-score-big {
  font-family: var(--f-display); font-weight: 900;
  font-size: 48px; line-height: 1;
  letter-spacing: -0.02em;
}
.h2h-score-big.right { text-align: right; }
.h2h-score-big.lead { color: var(--red); }
/* Stat-leader card grid (top of Stats page — uses team livery colour as accent) */
.stat-leader-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-top: 24px;
}
@media (max-width: 1180px) { .stat-leader-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 880px)  { .stat-leader-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 540px)  { .stat-leader-grid { grid-template-columns: 1fr; } }

.stat-leader-card {
  --accent: var(--red);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 18px 14px;
  position: relative;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.15s var(--ease), border-color 0.15s var(--ease);
}
.stat-leader-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}
.stat-leader-card.stat-leader-empty {
  opacity: 0.4;
  cursor: default;
}
.stat-leader-card.stat-leader-empty:hover { transform: none; }

.stat-leader-bar {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  background: var(--accent);
}

.stat-leader-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}
.stat-leader-icon {
  font-size: 16px;
  color: var(--text-dim);
  filter: grayscale(0.4);
}
.stat-leader-title {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 13px;
  color: var(--text);
  letter-spacing: 0;
}

.stat-leader-body {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 14px;
  align-items: center;
  margin-bottom: 12px;
  min-height: 80px;
}
.stat-leader-portrait {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  background: var(--bg-elev) center/cover no-repeat;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 22px;
  color: var(--text-dim);
  position: relative;
  z-index: 1;
}
.stat-leader-team-mark {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--bg-card) center/contain no-repeat;
  border: 2px solid var(--bg-warm);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 9px;
  color: var(--accent);
  z-index: 2;
  letter-spacing: 0;
}
.stat-leader-name {
  font-family: var(--f-display);
  font-weight: 600;
  font-size: 17px;
  letter-spacing: 0;
  line-height: 1.1;
  color: var(--text);
}
.stat-leader-name .last {
  color: var(--accent);
  font-weight: 900;
  text-transform: uppercase;
  margin-left: 4px;
}
.stat-leader-team {
  font-family: var(--f-body);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-dim);
  margin-top: 4px;
}
.stat-leader-country {
  font-family: var(--f-body);
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 3px;
}

.stat-leader-bignum {
  background: linear-gradient(135deg,
    color-mix(in srgb, var(--accent) 22%, transparent),
    color-mix(in srgb, var(--accent) 6%, transparent));
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-radius: 6px;
  padding: 11px 14px;
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 10px;
}
.stat-leader-bignum-num {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 26px;
  color: var(--accent);
  letter-spacing: -0.02em;
  line-height: 1;
}
.stat-leader-empty .stat-leader-bignum-num {
  color: var(--text-muted);
}
.stat-leader-bignum-unit {
  font-family: var(--f-body);
  font-weight: 500;
  font-size: 13px;
  color: var(--text);
}

.stat-leader-foot {
  display: flex;
  gap: 16px;
  font-family: var(--f-mono);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.stat-leader-foot b {
  color: var(--text);
  font-family: var(--f-display);
  font-weight: 700;
  margin-left: 3px;
}

/* Standings / readout portrait */
.standings-portrait {
  width: 32px; height: 32px; border-radius: 50%;
  border: 1.5px solid var(--team-color, var(--border-hi));
  background: var(--bg-elev) center/cover no-repeat;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--f-display); font-weight: 900; font-size: 11px;
  color: var(--team-color, var(--text-dim));
  flex-shrink: 0;
}
.podium-portrait {
  width: 64px; height: 64px; border-radius: 50%;
  border: 3px solid currentColor;
  background: var(--bg-card) center/cover no-repeat;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--f-display); font-weight: 900; font-size: 18px;
  margin: 0 auto 12px;
}

/* Independent quali/sprint save buttons */
.quali-save-row, .sprint-save-row {
  display: flex;
  justify-content: flex-end;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-warm);
}

/* Import paste modal */
.import-paste-area {
  width: 100%;
  min-height: 240px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  font-family: var(--f-mono);
  font-size: 12px;
  color: var(--text);
  line-height: 1.6;
  resize: vertical;
}
.import-paste-area:focus { border-color: var(--red); outline: none; }
.import-help {
  font-family: var(--f-mono);
  font-size: 10px;
  color: var(--text-muted);
  letter-spacing: 0.05em;
  line-height: 1.6;
  padding: 10px 14px;
  background: var(--bg-warm);
  border-radius: var(--radius);
  margin-top: 8px;
}
.import-help b { color: var(--text-dim); font-family: var(--f-mono); }
.import-preview {
  background: var(--bg-warm);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-top: 12px;
  font-family: var(--f-mono);
  font-size: 11px;
  color: var(--text-dim);
  max-height: 220px;
  overflow-y: auto;
}
.import-preview-row {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  gap: 10px;
  padding: 4px 0;
  align-items: center;
}
.import-preview-row.matched { color: var(--text); }
.import-preview-row.unmatched { color: var(--red); }
.import-preview-row .pos {
  font-family: var(--f-display);
  font-weight: 800;
  text-align: right;
}
.import-preview-row .status {
  font-size: 9px;
  letter-spacing: 0.15em;
  padding: 2px 6px;
  border-radius: 2px;
  border: 1px solid currentColor;
}

/* =====================================================
   F1.COM-STYLE RESULTS TABLE — used by Calendar tab
   Dark, restrained, table-driven with country-flag pills
   + team-color marks. Mirrors f1.com/en/results layout.
   ===================================================== */
.f1-results-head { margin-bottom: 18px; }
.f1-round-strip {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px 6px 6px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.f1-round-pill {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 11px;
  letter-spacing: 0.05em;
  color: #fff;
  background: var(--red);
  padding: 4px 10px;
  border-radius: 999px;
}
.f1-round-pill.upcoming { background: var(--text-dim); }
.f1-round-meta {
  font-family: var(--f-display);
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0;
  color: var(--text-soft);
  text-transform: uppercase;
}

.f1-page-title {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 56px;
  letter-spacing: -0.005em;
  text-transform: uppercase;
  color: var(--text);
  margin: 6px 0 28px;
  line-height: 1;
}
@media (max-width: 720px) { .f1-page-title { font-size: 36px; } }

.f1-filter-strip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 22px;
  flex-wrap: wrap;
}
.f1-filter {
  background: transparent;
  border: none;
  font-family: var(--f-display);
  font-weight: 600;
  font-size: 15px;
  color: var(--text-dim);
  padding: 14px 18px;
  cursor: pointer;
  position: relative;
  letter-spacing: 0;
  transition: color 0.12s var(--ease);
}
.f1-filter:first-child { padding-left: 0; }
.f1-filter:hover { color: var(--text); }
.f1-filter.active {
  color: var(--text);
  font-weight: 700;
}
.f1-filter.active::after {
  content: "";
  position: absolute;
  left: 18px; right: 18px; bottom: -1px;
  height: 3px;
  background: var(--red);
  border-radius: 2px 2px 0 0;
}
.f1-filter:first-child.active::after { left: 0; }
.f1-progress-meta {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
}

/* Solid card panel, exactly like F1.com results table */
.f1-table-shell {
  background: #1f1f2c;
  border: 1px solid #2a2a38;
  border-radius: 12px;
  padding: 28px 32px;
  margin-bottom: 32px;
  overflow-x: auto;
}
@media (max-width: 720px) { .f1-table-shell { padding: 18px; } }

.f1-table {
  width: 100%;
  min-width: 760px;
}

/* Default 7-column races table */
.f1-table-head, .f1-table-row {
  display: grid;
  grid-template-columns: 2fr 110px 1.6fr 1.4fr 80px 130px 100px;
  gap: 18px;
  align-items: center;
}
.f1-driver-table .f1-table-head, .f1-driver-table .f1-table-row {
  grid-template-columns: 70px 2fr 200px 1.6fr 90px 80px;
}
.f1-team-table .f1-table-head, .f1-team-table .f1-table-row {
  grid-template-columns: 70px 2fr 200px 90px 80px;
}

.f1-table-head {
  font-family: var(--f-display);
  font-weight: 600;
  font-size: 12px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0 0 14px 0;
  border-bottom: 1px solid #2a2a38;
}
.f1-table-head .num,
.f1-table-row .f1-num { text-align: right; }

.f1-table-row {
  padding: 16px 0;
  border-bottom: 1px solid #25252f;
  cursor: pointer;
  transition: background 0.12s var(--ease);
  position: relative;
}
.f1-table-row:last-child { border-bottom: none; }
.f1-table-row:hover { background: rgba(255,255,255,0.02); }
.f1-table-row.pending { opacity: 0.6; }

.f1-flag-pill {
  font-size: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 26px;
  text-align: center;
  flex-shrink: 0;
  line-height: 1;
}
.f1-flag-pill span { line-height: 1; }

.f1-gp {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.f1-gp-name {
  font-family: var(--f-display);
  font-weight: 600;
  font-size: 14px;
  color: var(--text);
  letter-spacing: 0;
  text-transform: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.f1-date {
  font-family: var(--f-display);
  font-weight: 500;
  font-size: 13px;
  color: var(--text-soft);
  letter-spacing: 0;
}

.f1-winner, .f1-team {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-family: var(--f-display);
  font-weight: 500;
  font-size: 13px;
  color: var(--text);
}
.f1-winner-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.f1-team-mark {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--red);
  border: 2px solid rgba(255,255,255,0.08);
}
.f1-team-mark.large { width: 22px; height: 22px; }

.f1-num {
  font-family: var(--f-display);
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  letter-spacing: 0;
}
.f1-num.pos {
  font-weight: 700;
  font-size: 15px;
  text-align: left;
}
.f1-num.pts {
  font-weight: 800;
  font-size: 16px;
}

.f1-portrait {
  width: 36px; height: 36px;
  border-radius: 50%;
  background: var(--bg-elev) center/cover no-repeat;
  border: 2px solid var(--border-hi);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 11px;
  color: var(--text-dim);
  flex-shrink: 0;
}

.f1-row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
}
.f1-row-btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s var(--ease);
  padding: 0;
}
.f1-table-row:hover .f1-row-btn {
  border-color: var(--border-hi);
}
.f1-row-btn:hover {
  color: var(--text);
  background: var(--bg-card-hi);
  border-color: var(--text-dim);
}
.f1-row-btn.danger:hover {
  color: var(--red);
  border-color: var(--red);
}
.f1-tag {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 9px;
  letter-spacing: 0.1em;
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-dim);
  border: 1px solid var(--border-hi);
}
.f1-tag.sprint {
  color: var(--sec-yellow);
  border-color: var(--sec-yellow);
  background: rgba(251, 191, 36, 0.08);
}
.f1-tag.dsq {
  color: var(--red);
  border-color: var(--red);
  background: rgba(225, 6, 0, 0.08);
}

/* =====================================================
   RECORDS — portraits/logos on tiles + detail rows
   ===================================================== */
.record-tile {
  --accent: var(--red);
  position: relative;
  overflow: hidden;
}
.record-tile-bar {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  background: var(--accent);
}
.record-tile-leader-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 14px;
}
.record-portrait {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 2px solid var(--border-hi);
  background: var(--bg-elev) center/cover no-repeat;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 14px;
  color: var(--text-dim);
  flex-shrink: 0;
}
.record-portrait.empty {
  opacity: 0.3;
}
.record-tile-leader-text { flex: 1; min-width: 0; }
.record-tile-leader-text .record-tile-value { margin-top: 0; }
.record-tile-leader-text .record-tile-leader { margin-top: 2px; }
.record-detail-portrait {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 2px solid var(--border-hi);
  background: var(--bg-elev) center/cover no-repeat;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 11px;
  color: var(--text-dim);
  flex-shrink: 0;
}
.record-detail-row {
  display: grid;
  grid-template-columns: 40px 36px 1fr auto;
  gap: 14px;
  align-items: center;
}

/* =====================================================
   TEAM LOGO — used in standings tables
   ===================================================== */
.team-logo {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid var(--border-hi);
  background: var(--bg-elev) center/cover no-repeat;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 9px;
  color: var(--text-dim);
  vertical-align: middle;
  flex-shrink: 0;
}
.team-logo.small {
  width: 20px;
  height: 20px;
  font-size: 7px;
  margin-right: 4px;
}

/* =====================================================
   TRACK FLAG PICKER (race edit modal)
   ===================================================== */
.track-flag-row {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 10px 0 4px;
}
.track-flag-preview {
  width: 60px;
  height: 40px;
  border-radius: var(--radius);
  border: 1px solid var(--border-hi);
  background: var(--bg-elev) center/cover no-repeat;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.track-flag-preview.emoji { font-size: 24px; }

/* The little flag image rendered inline in tables (replaces emoji when present) */
.race-flag-img {
  display: inline-block;
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  border-radius: 2px;
  border: 1px solid rgba(255,255,255,0.1);
  vertical-align: middle;
}

/* =====================================================
   STATS · CHARTS view
   ===================================================== */
.charts-section {
  margin-top: 16px;
}
.charts-section-head {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.charts-section-head .dash-block-title { flex: 1; }
.charts-help {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.chart-svg {
  width: 100%;
  height: auto;
  display: block;
}
.charts-driver-select {
  background: var(--bg-input);
  border: 1px solid var(--border-hi);
  border-radius: 999px;
  padding: 8px 32px 8px 16px;
  font-family: var(--f-display);
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23ffffff' stroke-width='1.5' fill='none' stroke-linecap='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 14px center;
  min-width: 240px;
}

/* Last-5 grid: small driver cards each with five colour-coded result cells */
.last5-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.last5-card {
  --accent: var(--red);
  display: flex;
  gap: 12px;
  align-items: center;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  position: relative;
  overflow: hidden;
}
.last5-card::before {
  content: "";
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
  background: var(--accent);
}
.last5-portrait {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  background: var(--bg-elev) center/cover no-repeat;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 11px;
  color: var(--text-dim);
  flex-shrink: 0;
}
.last5-body { flex: 1; min-width: 0; }
.last5-name {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 13px;
  color: var(--text);
  text-transform: uppercase;
  letter-spacing: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.last5-team {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  text-transform: uppercase;
  margin: 1px 0 6px;
}
.last5-cells {
  display: flex;
  gap: 4px;
}
.last5-cell {
  width: 36px;
  height: 22px;
  border-radius: 3px;
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-elev);
  color: var(--text-dim);
  border: 1px solid var(--border-dim);
}
.last5-cell.gold   { background: rgba(212,168,87,0.18);  color: var(--gold);   border-color: rgba(212,168,87,0.35); }
.last5-cell.silver { background: rgba(200,200,204,0.12); color: var(--silver); border-color: rgba(200,200,204,0.3); }
.last5-cell.bronze { background: rgba(205,127,50,0.18);  color: var(--bronze); border-color: rgba(205,127,50,0.35); }
.last5-cell.pts    { background: rgba(96,165,250,0.10);  color: var(--sec-blue); border-color: rgba(96,165,250,0.25); }
.last5-cell.plain  { background: var(--bg-elev); color: var(--text); }
.last5-cell.dnf    { background: rgba(225,6,0,0.14); color: var(--red); border-color: rgba(225,6,0,0.35); }
.last5-cell.dsq    { background: rgba(225,6,0,0.14); color: var(--red); border-color: rgba(225,6,0,0.35); }
.last5-cell.dns    { color: var(--text-muted); }
.last5-cell.empty  { color: var(--text-muted); opacity: 0.45; }

/* Distribution bar */
.dist-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dist-row {
  display: grid;
  grid-template-columns: 180px 1fr 50px;
  gap: 14px;
  align-items: center;
}
.dist-name {
  font-family: var(--f-display);
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dist-bar {
  display: flex;
  height: 22px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--bg-elev);
  border: 1px solid var(--border-dim);
}
.dist-seg { transition: filter 0.15s var(--ease); cursor: pointer; }
.dist-seg:hover { filter: brightness(1.25); }
.dist-seg.wins    { background: var(--gold); }
.dist-seg.podiums { background: var(--silver); }
.dist-seg.top10   { background: var(--sec-blue); }
.dist-seg.other   { background: #4a4a55; }
.dist-seg.dnf     { background: var(--red); }
.dist-seg.dsq     { background: var(--red-deep); }
.dist-seg.dns     { background: var(--text-muted); }
.dist-total {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 13px;
  color: var(--text);
  text-align: right;
}
.dist-legend {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.15em;
  color: var(--text-dim);
  text-transform: uppercase;
}
.dist-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.dist-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
}
.dist-swatch.wins    { background: var(--gold); }
.dist-swatch.podiums { background: var(--silver); }
.dist-swatch.top10   { background: var(--sec-blue); }
.dist-swatch.other   { background: #4a4a55; }
.dist-swatch.dnf     { background: var(--red); }
.dist-swatch.dsq     { background: var(--red-deep); }
.dist-swatch.dns     { background: var(--text-muted); }

/* =====================================================
   DASHBOARD — leader cards with photo/logo
   ===================================================== */
.dash-leader-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.dash-leader-portrait {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 2px solid var(--border-hi);
  background: var(--bg-elev) center/cover no-repeat;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 14px;
  color: var(--text-dim);
  flex-shrink: 0;
}

/* =====================================================
   PER-RACE DRIVER STANDINGS MATRIX (Calendar > Drivers)
   ===================================================== */
.f1-matrix-shell {
  background: #1f1f2c;
  border: 1px solid #2a2a38;
  border-radius: 12px;
  padding: 18px 22px 22px;
  overflow: hidden;
  margin-bottom: 32px;
}
.f1-matrix-scroll {
  overflow-x: auto;
  margin: 0 -22px;
  padding: 0 22px;
}
.f1-matrix {
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
  min-width: 900px;
}
.f1-matrix th, .f1-matrix td {
  padding: 10px 8px;
  text-align: left;
  vertical-align: middle;
  border-bottom: 1px solid #25252f;
}
.f1-matrix thead th {
  font-family: var(--f-display);
  font-weight: 600;
  font-size: 11px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 2px solid #2a2a38;
  background: var(--bg-warm);
  position: sticky;
  top: 0;
  z-index: 2;
}
.f1-matrix th.f1-matrix-rank,
.f1-matrix td.f1-matrix-rank {
  width: 28px;
  text-align: center;
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 13px;
  color: var(--text-dim);
}
.f1-matrix th.f1-matrix-driver {
  width: 220px;
  position: sticky;
  left: 0;
  z-index: 3;
  background: var(--bg-warm);
}
.f1-matrix td.f1-matrix-driver {
  width: 220px;
  position: sticky;
  left: 0;
  z-index: 1;
  background: #1f1f2c;
}
.f1-matrix-row:hover td.f1-matrix-driver { background: #25252f; }
.f1-matrix th.f1-matrix-team {
  width: 160px;
}
.f1-matrix td.f1-matrix-team {
  width: 160px;
  font-family: var(--f-display);
  font-weight: 500;
  font-size: 12px;
  color: var(--text-soft);
}
.f1-matrix td.f1-matrix-team .team-logo,
.f1-matrix td.f1-matrix-team .team-dot {
  vertical-align: middle;
  margin-right: 4px;
}

/* Round column header — flag + R-XX + country code stacked */
.f1-matrix th.f1-matrix-round {
  width: 60px;
  min-width: 60px;
  text-align: center;
  padding: 8px 4px;
  vertical-align: bottom;
}
.f1-matrix-flag {
  font-size: 22px;
  line-height: 1;
  margin-bottom: 4px;
}
.f1-matrix-round-num {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 11px;
  color: var(--text);
  letter-spacing: 0.02em;
}
.f1-matrix-round-code {
  font-family: var(--f-mono);
  font-size: 9px;
  color: var(--text-muted);
  letter-spacing: 0.08em;
  margin-top: 2px;
}

.f1-matrix-row { transition: background 0.12s var(--ease); cursor: pointer; }
.f1-matrix-row:hover td { background: #25252f; }

.f1-matrix-driver-cell {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
}
.f1-matrix-driver-name {
  font-family: var(--f-display);
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.f1-matrix-driver-meta {
  font-family: var(--f-mono);
  font-size: 10px;
  color: var(--text-muted);
  letter-spacing: 0.05em;
  margin-top: 2px;
}

/* Each result cell: a coloured pill */
.f1-matrix-cell {
  width: 56px;
  text-align: center;
  padding: 10px 4px;
  position: relative;
}

/* Number-only result with no pill/box.
   Colour conveys position; decorations layer on top (pole "P", FL underline). */
.mx-cell {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0;
  position: relative;
  display: inline-block;
  padding: 0 1px;
}

.mx-cell.mx-gold   { color: var(--gold);   font-weight: 800; }
.mx-cell.mx-silver { color: var(--silver); font-weight: 800; }   /* P2 — silver */
.mx-cell.mx-bronze { color: var(--bronze); font-weight: 800; }   /* P3 — bronze */
.mx-cell.mx-white  { color: var(--text); }                       /* P4–P10 — full white */
.mx-cell.mx-out    { color: var(--text); font-weight: 500; opacity: 0.45; }  /* P11+ — same hue, lower opacity */
.mx-cell.mx-dnf    { color: var(--red); font-weight: 700; font-size: 11px; letter-spacing: 0.06em; }
.mx-cell.mx-dsq    { color: var(--red); font-weight: 700; font-size: 11px; letter-spacing: 0.06em; }
.mx-cell.mx-dns    { color: var(--text-muted); font-style: italic; font-size: 11px; letter-spacing: 0.06em; }
.mx-cell.empty     { color: var(--text-muted); opacity: 0.4; font-weight: 400; }

/* Fastest lap — purple underline beneath the position number */
.mx-cell[data-fl="1"] {
  text-decoration: underline;
  text-decoration-color: #c084fc;
  text-decoration-thickness: 2px;
  text-underline-offset: 4px;
}

/* Pole superscript — small blue "P" next to the position */
.mx-pole {
  position: absolute;
  top: -2px;
  right: -10px;
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 9px;
  color: var(--sec-blue);
  letter-spacing: 0;
}

/* Sprint result superscript — sits just outside the cell, smaller and coloured */
.mx-sprint {
  position: relative;
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 9px;
  margin-left: 4px;
  top: -5px;
  letter-spacing: 0;
}
.mx-sprint.spr-gold   { color: var(--gold); }
.mx-sprint.spr-silver { color: var(--silver); }
.mx-sprint.spr-bronze { color: var(--bronze); }
.mx-sprint.spr-pts    { color: var(--sec-blue); }
.mx-sprint.spr-out    { color: var(--text-muted); }
.mx-sprint.dnf,.mx-sprint.dsq,.mx-sprint.dns { color: var(--red); font-size: 8px; letter-spacing: 0.05em; }
.mx-sprint.dns { color: var(--text-muted); }

/* Round-header tweak — flag + country code only (drop the R-XX line for tighter columns) */
.f1-matrix-round-num { display: none; }

/* Legend uses inline coloured number examples now */
.f1-matrix-legend b {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 13px;
  margin-right: 4px;
  display: inline-block;
  min-width: 14px;
  text-align: center;
}
.f1-matrix-legend b.mx-gold   { color: var(--gold); font-weight: 800; }
.f1-matrix-legend b.mx-silver { color: var(--silver); font-weight: 800; }
.f1-matrix-legend b.mx-bronze { color: var(--bronze); font-weight: 800; }
.f1-matrix-legend b.mx-white  { color: var(--text); }
.f1-matrix-legend b.mx-out    { color: var(--text); opacity: 0.45; }
.f1-matrix-legend b.mx-dnf    { color: var(--red); font-size: 10px; letter-spacing: 0.06em; }

.f1-matrix th.f1-matrix-pts,
.f1-matrix td.f1-matrix-pts {
  width: 60px;
  text-align: right;
  padding: 10px 14px 10px 8px;
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 15px;
  color: var(--text);
  border-right: 2px solid #2a2a38;
}
.f1-matrix thead th.f1-matrix-pts {
  background: var(--bg-warm);
}
.f1-matrix tbody td.f1-matrix-pts {
  background: #1f1f2c;
}
.f1-matrix-row:hover td.f1-matrix-pts { background: #25252f; }

.f1-matrix-legend {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  padding: 14px 0 0;
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.15em;
  color: var(--text-dim);
  text-transform: uppercase;
  border-top: 1px solid #25252f;
  margin-top: 14px;
}
.f1-matrix-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

/* Sprint badge in track preset rows */
.preset-badge.sprint {
  color: var(--sec-yellow);
  border: 1px solid var(--sec-yellow);
}

/* Country code field with live flag emoji preview */
.country-input {
  position: relative;
  display: flex;
  align-items: stretch;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-input);
  overflow: hidden;
}
.country-input:focus-within {
  border-color: var(--red);
}
.country-input .country-flag-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  font-size: 20px;
  background: var(--bg-elev);
  border-right: 1px solid var(--border);
  flex-shrink: 0;
  line-height: 1;
}
.country-input input {
  border: none;
  background: transparent;
  padding: 10px 12px;
  flex: 1;
  font-family: var(--f-mono);
  font-size: 13px;
  letter-spacing: 0.1em;
  color: var(--text);
  outline: none;
  min-width: 0;
}

/* =====================================================
   ROSTER BUNDLES — Class of X modal styling
   ===================================================== */
.rc-row {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 18px;
  margin-bottom: 10px;
  background: var(--bg-card);
  transition: border-color 0.12s var(--ease);
}
.rc-row:hover { border-color: var(--border-hi); }
.rc-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
}
.rc-name {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 18px;
  letter-spacing: -0.01em;
  color: var(--text);
}
.rc-meta {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.rc-note {
  font-family: var(--f-body);
  font-size: 13px;
  font-style: italic;
  color: var(--text-soft);
  margin-bottom: 12px;
}
.rc-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 14px;
}
.rc-chip {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1.5px solid var(--border-hi);
  background: var(--bg-elev) center/cover no-repeat;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 10px;
  flex-shrink: 0;
}
.rc-chip.rc-more {
  background: transparent;
  border-style: dashed;
  color: var(--text-muted);
  font-size: 10px;
  letter-spacing: 0.05em;
}
.rc-actions {
  display: flex;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--border-dim);
}
.rc-actions .btn {
  font-size: 10px;
  padding: 6px 10px;
  letter-spacing: 0.12em;
}

/* =====================================================
   SIGN-IN SCREEN + CLOUD UI
   ===================================================== */
.signin-screen {
  min-height: 70vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 60px 24px;
}
.signin-card {
  width: 100%;
  max-width: 440px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 40px 36px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.4);
}
.signin-head {
  text-align: center;
  margin-bottom: 28px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border-dim);
}
.signin-title {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 36px;
  letter-spacing: -0.02em;
  color: var(--text);
  margin: 0 0 8px;
}
.signin-title .accent { color: var(--red); }
.signin-sub {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.2em;
  color: var(--text-muted);
  text-transform: uppercase;
  margin: 0;
}
.signin-form .field {
  margin-bottom: 14px;
}
.signin-form label {
  display: block;
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 6px;
}
.field-help-inline {
  color: var(--text-fade);
  font-size: 9px;
  letter-spacing: 0.1em;
  margin-left: 6px;
  text-transform: none;
}
.signin-form input {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  font-family: var(--f-body);
  font-size: 14px;
  color: var(--text);
  outline: none;
  transition: border-color 0.12s var(--ease);
}
.signin-form input:focus { border-color: var(--red); }
.signin-actions {
  display: flex;
  gap: 8px;
  margin: 18px 0 14px;
}
.signin-actions .btn { flex: 1; }
.signin-divider {
  text-align: center;
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.25em;
  color: var(--text-muted);
  margin: 18px 0 12px;
  position: relative;
  text-transform: uppercase;
}
.signin-divider::before,
.signin-divider::after {
  content: '';
  position: absolute;
  top: 50%; width: 40%; height: 1px;
  background: var(--border-dim);
}
.signin-divider::before { left: 0; }
.signin-divider::after  { right: 0; }
.btn-full { width: 100%; margin-bottom: 8px; }
.signin-msg {
  min-height: 22px;
  margin-top: 12px;
  font-family: var(--f-mono);
  font-size: 12px;
  letter-spacing: 0.04em;
  text-align: center;
}
.signin-msg.tone-info    { color: var(--text-soft); }
.signin-msg.tone-success { color: var(--green); }
.signin-msg.tone-error   { color: var(--red); }
.signin-foot {
  margin-top: 28px;
  padding-top: 18px;
  border-top: 1px solid var(--border-dim);
  text-align: center;
  font-family: var(--f-body);
  font-size: 11px;
  color: var(--text-muted);
}

/* Share modal */
.share-link-row {
  margin-bottom: 18px;
  padding: 14px;
  background: var(--bg-elev);
  border-radius: var(--radius);
  border: 1px solid var(--border-dim);
}
.share-link-row label {
  display: block;
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 8px;
}
.share-link-box {
  display: flex;
  gap: 8px;
  align-items: center;
}
.share-link-box input {
  flex: 1;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  font-family: var(--f-mono);
  font-size: 12px;
  color: var(--text);
  outline: none;
}
.members-list {
  margin-top: 18px;
}
.members-head {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-dim);
  margin-bottom: 10px;
}
.member-row {
  display: flex;
  gap: 12px;
  padding: 8px 0;
  font-family: var(--f-mono);
  font-size: 12px;
}
.member-role {
  display: inline-block;
  padding: 2px 8px;
  background: var(--bg-elev);
  border: 1px solid var(--border-dim);
  border-radius: 3px;
  font-size: 9px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--text-soft);
}
.member-id { color: var(--text-soft); }

/* Account modal */
.account-info { display: flex; flex-direction: column; gap: 10px; }
.account-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-dim);
}
.account-row:last-child { border-bottom: none; }
.account-row .lbl {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.account-row .val {
  font-family: var(--f-body);
  font-size: 13px;
  color: var(--text);
}
.account-row .val.mono { font-family: var(--f-mono); font-size: 11px; }
.account-row .val.accent { color: var(--green); font-family: var(--f-mono); font-size: 11px; letter-spacing: 0.15em; }

/* =====================================================
   FEATURE PACK 1: UI STYLES (#1-#12)
   ===================================================== */

/* Topbar presence (feature #3) */
.presence-slot {
  display: inline-flex;
  gap: 4px;
  margin-right: 4px;
  align-items: center;
}
.presence-dot {
  width: 28px; height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--f-mono);
  font-weight: 700;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: white;
  text-shadow: 0 1px 2px rgba(0,0,0,0.4);
  border: 2px solid var(--bg);
  box-shadow: 0 0 0 1px var(--border);
  transition: transform 0.18s var(--ease);
}
.presence-dot:hover { transform: scale(1.12); }

/* Share modal — sections (#1, #2, #11) */
.share-section { margin-bottom: 26px; }
.share-section:last-child { margin-bottom: 0; }
.share-section-head {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-dim);
  margin-bottom: 12px;
}
.share-invite-row {
  display: flex; gap: 10px; align-items: center;
}
.share-role-toggle {
  display: flex; gap: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.share-role-toggle .btn {
  border-radius: 0;
  border: none;
  padding: 8px 14px;
  font-size: 10px;
}
.share-role-toggle .btn.active {
  background: var(--red);
  color: white;
}

/* Members list */
.members-list .member-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-elev);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius);
  margin-bottom: 6px;
}
.member-name {
  font-family: var(--f-body);
  font-size: 14px;
  font-weight: 600;
  flex: 1;
}
.member-role {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  padding: 3px 8px;
  background: var(--bg);
  border: 1px solid var(--border-dim);
  border-radius: 3px;
  text-transform: uppercase;
}
.member-role.role-owner   { color: var(--gold); border-color: var(--gold); }
.member-role.role-editor  { color: var(--sec-blue); }
.member-role.role-viewer  { color: var(--text-muted); }
.member-role-select {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  padding: 4px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
  cursor: pointer;
}
.btn-icon-x {
  width: 26px; height: 26px;
  border-radius: 50%;
  background: transparent;
  border: 1px solid var(--border-dim);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  display: inline-flex; align-items: center; justify-content: center;
  transition: all 0.12s var(--ease);
}
.btn-icon-x:hover {
  background: var(--red);
  border-color: var(--red);
  color: white;
}
.empty-row {
  padding: 16px;
  text-align: center;
  color: var(--text-muted);
  font-family: var(--f-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
}

/* Edit stamp (feature #4) */
.edit-stamp {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  text-transform: uppercase;
  margin-top: 6px;
  opacity: 0.6;
}

/* Bulk import preview (feature #5) */
.bulk-preview-grid {
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius);
  background: var(--bg-elev);
}
.bulk-preview-row {
  display: grid;
  grid-template-columns: 50px 1fr 100px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-dim);
  align-items: center;
}
.bulk-preview-row:last-child { border-bottom: none; }
.bulk-preview-num {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 16px;
  color: var(--text-soft);
}
.bulk-preview-name {
  font-family: var(--f-body);
  font-size: 13px;
}
.bulk-preview-flag {
  font-family: var(--f-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-align: right;
}

/* Predictions modal (feature #7) */
.pred-race-row {
  display: grid;
  grid-template-columns: 50px 1fr 200px;
  gap: 10px;
  padding: 8px 4px;
  align-items: center;
  border-bottom: 1px solid var(--border-dim);
}
.pred-race-num {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 14px;
  color: var(--text-soft);
}
.pred-race-name {
  font-family: var(--f-body);
  font-size: 13px;
}
.pred-winner {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text);
}
.pred-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--f-mono);
}
.pred-table th, .pred-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border-dim);
  font-size: 12px;
}
.pred-table th {
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.pred-champ td {
  background: linear-gradient(90deg, rgba(212,168,87,0.15), transparent);
  color: var(--gold);
  font-weight: 700;
}

/* Race timeline (feature #10) */
.race-timeline {
  display: flex;
  align-items: flex-start;
  gap: 0;
  padding: 24px 0;
  margin: 20px 0 30px;
  border-top: 1px solid var(--border-dim);
  border-bottom: 1px solid var(--border-dim);
  overflow-x: auto;
}
.race-timeline-step {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
  padding: 0 20px;
  position: relative;
}
.race-timeline-connector {
  position: absolute;
  left: -10px;
  top: 50%;
  width: 20px;
  height: 2px;
  background: var(--border);
}
.race-timeline-icon {
  width: 44px; height: 44px;
  border-radius: 50%;
  background: var(--bg-elev);
  border: 2px solid var(--ts-color, var(--border-hi));
  display: flex; align-items: center; justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
}
.race-timeline-title {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 2px;
}
.race-timeline-highlight {
  font-family: var(--f-body);
  font-size: 14px;
  color: var(--text);
}
.race-timeline-sub {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-top: 2px;
}

/* Driver comparison grid (feature #12) */
.cmp-grid {
  display: grid;
  grid-template-columns: 1fr 2fr 1fr;
  gap: 24px;
  align-items: start;
}
.cmp-col {
  text-align: center;
  padding: 20px;
  background: var(--bg-elev);
  border-radius: var(--radius);
}
.cmp-name {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 22px;
  line-height: 1.1;
  margin-bottom: 6px;
}
.cmp-sub {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.15em;
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 12px;
}
.cmp-flag {
  font-size: 18px;
  font-family: var(--f-mono);
  letter-spacing: 0.1em;
}
.cmp-mid { display: flex; flex-direction: column; gap: 4px; }
.cmp-row {
  display: grid;
  grid-template-columns: 1fr 100px 1fr;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  background: var(--bg-elev);
  border-radius: var(--radius);
}
.cmp-val {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 22px;
  text-align: center;
  color: var(--text-soft);
}
.cmp-val.win { color: var(--green); }
.cmp-val.lose { color: var(--text-muted); }
.cmp-lbl {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-muted);
  text-align: center;
}

/* Public read-only view (feature #11) */
.public-view {
  max-width: 1100px;
  margin: 0 auto;
  padding: 40px 24px 80px;
}
.public-head {
  text-align: center;
  margin-bottom: 36px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border-dim);
}
.public-eyebrow {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.25em;
  color: var(--red);
  margin-bottom: 8px;
  text-transform: uppercase;
}
.public-title {
  font-family: var(--f-display);
  font-weight: 900;
  font-size: 48px;
  letter-spacing: -0.02em;
  margin: 0;
}
.public-sub {
  font-family: var(--f-serif);
  font-style: italic;
  font-size: 14px;
  color: var(--text-muted);
  margin-top: 8px;
}
.public-section {
  margin-bottom: 40px;
}
.public-section-title {
  font-family: var(--f-mono);
  font-size: 11px;
  letter-spacing: 0.2em;
  color: var(--text-muted);
  text-transform: uppercase;
  margin: 0 0 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-dim);
}
.public-table {
  width: 100%;
  border-collapse: collapse;
}
.public-table th, .public-table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border-dim);
  font-size: 13px;
}
.public-table th {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.public-champ td {
  background: linear-gradient(90deg, rgba(212,168,87,0.15), transparent);
  color: var(--gold);
}
.public-calendar { display: flex; flex-direction: column; gap: 4px; }
.public-race-row {
  display: grid;
  grid-template-columns: 60px 1fr 220px;
  gap: 14px;
  align-items: center;
  padding: 12px 14px;
  background: var(--bg-elev);
  border-radius: var(--radius);
}
.public-race-row.pending { opacity: 0.6; }
.public-race-num {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 16px;
  color: var(--text-soft);
}
.public-race-name { font-family: var(--f-body); font-size: 14px; font-weight: 600; }
.public-race-circuit { font-family: var(--f-mono); font-size: 10px; color: var(--text-muted); letter-spacing: 0.1em; margin-top: 2px; }
.public-race-winner { font-family: var(--f-body); font-size: 13px; text-align: right; }
.public-roster {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}
.public-driver-card {
  display: flex; align-items: center; gap: 14px;
  padding: 12px 14px;
  background: var(--bg-elev);
  border-left: 4px solid var(--team-color);
  border-radius: var(--radius);
}
.public-driver-num {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 24px;
  color: var(--team-color);
}
.public-driver-name { font-family: var(--f-body); font-size: 14px; font-weight: 600; }
.public-driver-team { font-family: var(--f-mono); font-size: 10px; color: var(--text-muted); letter-spacing: 0.06em; margin-top: 2px; }
.public-foot {
  margin-top: 60px;
  padding-top: 24px;
  border-top: 1px solid var(--border-dim);
  text-align: center;
  font-family: var(--f-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.public-foot a { color: var(--red); text-decoration: none; }
.public-foot a:hover { text-decoration: underline; }

/* =====================================================
   RACE EDITOR — Session tabs (Qualifying / Sprint / Race)
   Replaces the old stacked-section layout with a tabbed view.
   ===================================================== */
.race-session-tabs {
  display: flex;
  gap: 0;
  margin: 8px 0 22px;
  border-bottom: 1px solid var(--border);
}
.race-session-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 14px 16px;
  background: transparent;
  border: none;
  border-bottom: 3px solid transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  transition: all 0.15s var(--ease);
  position: relative;
}
.race-session-tab:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.02);
}
.race-session-tab.active {
  color: var(--text);
  border-bottom-color: var(--red);
  background: linear-gradient(180deg, rgba(225, 6, 0, 0.04), transparent);
}
.race-session-tab-icon {
  font-size: 16px;
  line-height: 1;
}
.race-session-tab-label {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 13px;
}
.race-session-tab-status {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  padding: 3px 8px;
  border-radius: 3px;
  background: var(--bg-elev);
  border: 1px solid var(--border-dim);
  color: var(--text-muted);
}
.race-session-tab-status.done {
  color: var(--green, #10b981);
  border-color: var(--green, #10b981);
  background: rgba(16, 185, 129, 0.06);
}
.race-session-panel.hidden { display: none; }
.race-session-panel { animation: race-panel-fade 0.18s var(--ease); }
@keyframes race-panel-fade {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
@media (max-width: 720px) {
  .race-session-tab { padding: 10px 8px; gap: 6px; font-size: 11px; }
  .race-session-tab-status { display: none; }
}

/* =====================================================
   STORAGE USAGE UI (Account modal)
   ===================================================== */
.storage-summary { margin-bottom: 18px; }
.storage-meter {
  width: 100%;
  height: 8px;
  background: var(--bg);
  border: 1px solid var(--border-dim);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 8px;
}
.storage-bar {
  height: 100%;
  transition: width 0.4s var(--ease);
  border-radius: 4px;
}
.storage-amount {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.storage-used {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 20px;
  color: var(--text);
}
.storage-budget {
  font-family: var(--f-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.storage-breakdown {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 16px;
}
.storage-cat {
  padding: 12px 14px;
  background: var(--bg-elev);
  border-radius: var(--radius);
  border: 1px solid var(--border-dim);
}
.storage-cat-label {
  font-family: var(--f-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 6px;
}
.storage-cat-val {
  font-family: var(--f-mono);
  font-size: 12px;
  color: var(--text);
}
.storage-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}
.storage-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-dim);
  font-family: var(--f-mono);
  font-size: 11px;
}
.storage-row:last-child { border-bottom: none; }
.storage-row .lbl { color: var(--text-muted); letter-spacing: 0.08em; text-transform: uppercase; }
.storage-row .val { color: var(--text); }

.storage-warning {
  margin-top: 14px;
  padding: 14px 16px;
  background: rgba(245, 158, 11, 0.07);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: var(--radius);
}
.storage-warning-head {
  font-family: var(--f-display);
  font-weight: 800;
  font-size: 13px;
  color: #f59e0b;
  margin-bottom: 6px;
}
.storage-warning-body {
  font-family: var(--f-body);
  font-size: 12px;
  color: var(--text-soft);
  line-height: 1.5;
}
.storage-ok {
  margin-top: 14px;
  padding: 10px 14px;
  background: rgba(16, 185, 129, 0.06);
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: var(--radius);
  font-family: var(--f-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--green, #10b981);
}
