import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Papa from "papaparse";
import {
  ResponsiveContainer,
  AreaChart, Area,
  BarChart, Bar,
  LineChart, Line,
  PieChart, Pie,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell, LabelList, ReferenceLine, Brush,
} from "recharts";
import "./App.css";

// ─── Constants ────────────────────────────────────────────────────────────────

const SEV_MAP   = { 1: "Sev 1", 2: "Sev 2", 3: "Sev 3", 4: "Sev 4" };
const SEV_COLOR = { 1: "#dc2626",  2: "#f97316", 3: "#eab308", 4: "#94a3b8" };
const STATE_MAP   = { 1: "New", 2: "Acknowledge", 3: "On-Hold", 4: "Resolved", 5: "Closed", 6: "Canceled" };
const STATE_COLOR = { 1: "#38bdf8", 2: "#f97316",    3: "#d97706",  4: "#22c55e",  5: "#4b5563", 6: "#dc2626" };


// Module-level severity helpers (used by both Dashboard and TableView)
const SEV_COLOR_BY_LABEL = Object.fromEntries(
  Object.entries(SEV_MAP).map(([k, v]) => [v, SEV_COLOR[k]])
);
const normSevLabel = (val) => {
  if (val == null) return null;
  if (SEV_MAP[val]) return SEV_MAP[val];
  if (typeof val === "string") return val;
  return null;
};

// Olive → sage gradient (left = deep olive, right = pale sage)
const TOOLTIP_COLORS = [
  "#38bdf8","#22c55e","#f97316","#a78bfa","#eab308",
  "#ec4899","#14b8a6","#f43f5e","#fb923c","#818cf8",
];

const RETRO_PALETTE = [
  "#e9f5db","#dcebca","#cfe1b9","#c2d5aa",
  "#b5c99a","#a6b98b","#97a97c","#849669",
  "#728359","#606f49",
];
const RETRO_PALETTE_REV = [...RETRO_PALETTE].reverse();

const PIE_COLORS = [
  "#8c1515","#9c1818","#a82000","#b83000","#c84800",
  "#d86000","#e07800","#e89000","#f0a800","#f5b830",
  "#ddd5b5","#7accc8","#48b8b0","#1a9090","#107878",
  "#0d4a5a","#1d6070","#2a8080","#60c0b8","#0a1a28",
];

const PERIODS = [
  { key: "day",   label: "Day"   },
  { key: "week",  label: "Week"  },
  { key: "month", label: "Month" },
];

// ─── Tooltip positioning helper ──────────────────────────────────────────────
// Returns {x,y} clamped so the tooltip stays fully within the viewport.
// Prefers right-of-anchor; flips left if it would overflow the right edge.
function getTooltipXY(anchorRect, tooltipW = 510, tooltipH = 340) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 10;
  const pad = 8;

  // Horizontal: try right of anchor first, flip left if needed
  let x = anchorRect.right + gap;
  if (x + tooltipW > vw - pad) {
    x = anchorRect.left - tooltipW - gap;
  }
  x = Math.max(pad, Math.min(x, vw - tooltipW - pad));

  // Vertical: align to anchor top, shift up if overflows bottom
  let y = anchorRect.top;
  if (y + tooltipH > vh - pad) {
    y = vh - tooltipH - pad;
  }
  y = Math.max(pad, y);

  return { x, y };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getBucket(dateStr, period) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  if (period === "day")   return d.toISOString().slice(0, 10);
  if (period === "month") return d.toISOString().slice(0, 7);
  if (period === "year")  return String(d.getFullYear());
  if (period === "week") {
    const tmp = new Date(d);
    tmp.setDate(tmp.getDate() - tmp.getDay());
    return tmp.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

function formatBucket(bucket, period) {
  if (!bucket) return "";
  if (period === "month") {
    const [y, m] = bucket.split("-");
    return new Date(y, m - 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  }
  return bucket;
}

// ─── Sorted pie legend ───────────────────────────────────────────────────────

function SortedPieLegend({ payload, filteredLength }) {
  if (!payload?.length) return null;
  const sorted = [...payload].sort((a, b) => (b.payload.count ?? 0) - (a.payload.count ?? 0));
  return (
    <ul style={{ listStyle:"none", padding:0, margin:0, fontSize:17, lineHeight:"26px", maxWidth:240 }}>
      {sorted.map((entry, i) => {
        const pct = filteredLength ? ((entry.payload.count / filteredLength) * 100).toFixed(1) : "0.0";
        const name = entry.value?.length > 18 ? entry.value.slice(0, 18) + "…" : entry.value;
        return (
          <li key={i} style={{ display:"flex", alignItems:"center", gap:6, whiteSpace:"nowrap" }}>
            <span style={{ width:10, height:10, borderRadius:2, background:entry.color, flexShrink:0 }} />
            <span style={{ color:"#cbd5e1", flex:1, overflow:"hidden", textOverflow:"ellipsis" }}>{name}</span>
            <span style={{ color:"#94a3b8", fontWeight:700, marginLeft:4 }}>{(entry.payload.count ?? 0).toLocaleString()} ({pct}%)</span>
          </li>
        );
      })}
    </ul>
  );
}

// ─── Truncated Y-axis tick ────────────────────────────────────────────────────

// Returns Cell opacity based on whether this row is the pinned selection
const cellOpacity = (panelTitle, rowName, base = 0.75) =>
  panelTitle == null ? base : panelTitle === rowName ? 1 : 0.25;

const makeTick   = (maxChars) => ({ fill:"#cbd5e1", fontSize:12 });
const truncate   = (maxChars) => (value) => {
  const s = value != null ? String(value) : "";
  return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
};

// ─── Date Range Picker ────────────────────────────────────────────────────────

const CAL_MONTHS = ["January","February","March","April","May","June",
                    "July","August","September","October","November","December"];
const CAL_DOW    = ["Su","Mo","Tu","We","Th","Fr","Sa"];

function calCells(year, month) {
  const first = new Date(year, month, 1).getDay();
  const total = new Date(year, month + 1, 0).getDate();
  const cells = Array(first).fill(null);
  for (let d = 1; d <= total; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function isoDate(year, month, day) {
  return `${year}-${String(month + 1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

function todayIso() {
  const d = new Date();
  return isoDate(d.getFullYear(), d.getMonth(), d.getDate());
}

function DateRangePicker({ dateFrom, dateTo, onChange, onClear }) {
  const [open,      setOpen]      = useState(false);
  const [stage,     setStage]     = useState(0);   // 0=idle 1=picking-end
  const [tempFrom,  setTempFrom]  = useState(dateFrom || "");
  const [hover,     setHover]     = useState(null);
  const [leftYear,  setLeftYear]  = useState(() => {
    const d = dateFrom ? new Date(dateFrom) : new Date();
    return d.getFullYear();
  });
  const [leftMonth, setLeftMonth] = useState(() => {
    const d = dateFrom ? new Date(dateFrom) : new Date();
    // show selected month on left, but shift back 1 if it's the last month
    const m = d.getMonth();
    return m === 11 ? 10 : m;
  });

  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setStage(0); } };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Keep tempFrom in sync if prop changes externally
  useEffect(() => { if (!open) setTempFrom(dateFrom || ""); }, [dateFrom, open]);

  const rightYear  = leftMonth === 11 ? leftYear + 1 : leftYear;
  const rightMonth = (leftMonth + 1) % 12;

  const shiftLeft  = () => leftMonth === 0  ? (setLeftMonth(11), setLeftYear(y => y - 1)) : setLeftMonth(m => m - 1);
  const shiftRight = () => leftMonth === 11 ? (setLeftMonth(0),  setLeftYear(y => y + 1)) : setLeftMonth(m => m + 1);

  const today = todayIso();

  const effectiveTo = stage === 1 ? (hover || "") : (dateTo || "");
  const lo = tempFrom && effectiveTo ? (tempFrom <= effectiveTo ? tempFrom : effectiveTo) : null;
  const hi = tempFrom && effectiveTo ? (tempFrom <= effectiveTo ? effectiveTo : tempFrom) : null;

  const handleDayClick = iso => {
    if (stage === 0) {
      setTempFrom(iso);
      setStage(1);
    } else {
      const [from, to] = iso < tempFrom ? [iso, tempFrom] : [tempFrom, iso];
      setStage(0);
      setOpen(false);
      onChange(from, to);
    }
  };

  const applyPreset = (from, to) => { onChange(from, to); setStage(0); setOpen(false); };

  const presets = [
    { label: "Last 24 hrs", fn() {
      const d = new Date(); d.setDate(d.getDate() - 1);
      applyPreset(isoDate(d.getFullYear(), d.getMonth(), d.getDate()), today);
    }},
    { label: "Today", fn() { applyPreset(today, today); } },
    { label: "Last 7 days", fn() {
      const d = new Date(); d.setDate(d.getDate() - 6);
      applyPreset(isoDate(d.getFullYear(), d.getMonth(), d.getDate()), today);
    }},
    { label: "Last 30 days", fn() {
      const d = new Date(); d.setDate(d.getDate() - 29);
      applyPreset(isoDate(d.getFullYear(), d.getMonth(), d.getDate()), today);
    }},
    { label: "Last 90 days", fn() {
      const d = new Date(); d.setDate(d.getDate() - 89);
      applyPreset(isoDate(d.getFullYear(), d.getMonth(), d.getDate()), today);
    }},
    { label: "This month", fn() {
      const d = new Date();
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      applyPreset(isoDate(d.getFullYear(), d.getMonth(), 1),
                  isoDate(last.getFullYear(), last.getMonth(), last.getDate()));
    }},
    { label: "Last month", fn() {
      const d = new Date();
      const f = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const l = new Date(d.getFullYear(), d.getMonth(), 0);
      applyPreset(isoDate(f.getFullYear(), f.getMonth(), 1),
                  isoDate(l.getFullYear(), l.getMonth(), l.getDate()));
    }},
    { label: "This year", fn() {
      const y = new Date().getFullYear();
      applyPreset(`${y}-01-01`, `${y}-12-31`);
    }},
    { label: "Last year", fn() {
      const y = new Date().getFullYear() - 1;
      applyPreset(`${y}-01-01`, `${y}-12-31`);
    }},
  ];

  const renderMonth = (year, month, showPrev, showNext) => {
    const cells = calCells(year, month);
    return (
      <div className="cv-drp-cal">
        <div className="cv-drp-cal-head">
          <button className="cv-drp-nav" onClick={shiftLeft}  style={{ visibility: showPrev ? "visible" : "hidden" }}>‹</button>
          <span className="cv-drp-cal-title">{CAL_MONTHS[month]} {year}</span>
          <button className="cv-drp-nav" onClick={shiftRight} style={{ visibility: showNext ? "visible" : "hidden" }}>›</button>
        </div>
        <div className="cv-drp-grid">
          {CAL_DOW.map(d => <div key={d} className="cv-drp-dow">{d}</div>)}
          {cells.map((day, idx) => {
            if (!day) return <div key={idx} className="cv-drp-empty" />;
            const iso     = isoDate(year, month, day);
            const isStart = iso === (stage === 1 ? tempFrom : dateFrom);
            const isEnd   = iso === (stage === 1 ? (hover || "") : dateTo);
            const inRange = lo && hi && iso > lo && iso < hi;
            let cls = "cv-drp-day";
            if (isStart) cls += " drp-start";
            if (isEnd && iso !== (stage === 1 ? tempFrom : dateFrom)) cls += " drp-end";
            if (inRange) cls += " drp-range";
            if (iso === today) cls += " drp-today";
            return (
              <div key={idx} className={cls}
                onClick={() => handleDayClick(iso)}
                onMouseEnter={() => stage === 1 && setHover(iso)}
                onMouseLeave={() => stage === 1 && setHover(null)}>
                {day}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const triggerLabel = dateFrom && dateTo
    ? `${dateFrom}  →  ${dateTo}`
    : dateFrom ? `From ${dateFrom}`
    : dateTo   ? `To ${dateTo}`
    : "All time";

  return (
    <div className="cv-drp-wrap" ref={ref}>
      <button
        className={`cv-drp-trigger${open ? " drp-open" : ""}${(dateFrom || dateTo) ? " drp-active" : ""}`}
        onClick={() => { setStage(0); setOpen(o => !o); }}>
        <span className="cv-drp-icon">📅</span>
        {triggerLabel}
        <span className="cv-drp-caret">▾</span>
      </button>
      {(dateFrom || dateTo) && (
        <button className="cv-clear-dates" onClick={() => { onClear(); setStage(0); setOpen(false); }}>✕</button>
      )}
      {open && (
        <div className="cv-drp-panel">
          <div className="cv-drp-presets">
            <div className="cv-drp-preset-title">Quick ranges</div>
            {presets.map(p => (
              <button key={p.label} className="cv-drp-preset" onClick={p.fn}>{p.label}</button>
            ))}
          </div>
          <div className="cv-drp-right">
            <div className="cv-drp-cals">
              {renderMonth(leftYear,  leftMonth,  true,  false)}
              {renderMonth(rightYear, rightMonth, false, true)}
            </div>
            {stage === 1
              ? <div className="cv-drp-hint">Now click an end date</div>
              : <div className="cv-drp-hint">Click a start date</div>
            }
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Multi-Select Filter ─────────────────────────────────────────────────────

function MultiSelect({ label, options, selected, onChange, searchable = false }) {
  // selected === null  → no filter (show all), all boxes appear checked
  // selected === []    → nothing checked, 0 results
  // selected === [a,b] → only those items pass
  const [open,   setOpen]   = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open && searchable) setTimeout(() => searchRef.current?.focus(), 30);
    if (!open) setSearch("");
  }, [open, searchable]);

  const isAll  = selected === null;
  const isNone = Array.isArray(selected) && selected.length === 0;
  const visibleOptions = searchable && search.trim()
    ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
    : options;

  const isChecked = opt => isAll || (Array.isArray(selected) && selected.includes(opt));

  const toggle = opt => {
    if (isAll) {
      // Uncheck just this one — keep all others
      onChange(options.filter(o => o !== opt));
    } else if (selected.includes(opt)) {
      const next = selected.filter(o => o !== opt);
      // All remaining checked → collapse to "all"
      onChange(next.length === options.length ? null : next);
    } else {
      const next = [...selected, opt];
      onChange(next.length === options.length ? null : next);
    }
  };

  const triggerLabel = isAll  ? `All ${label}`
    : isNone                  ? `No ${label}`
    : selected.length === 1   ? selected[0]
    :                           `${selected.length} ${label}`;

  const isDirty = !isAll; // show ✕ whenever filter is non-default

  return (
    <div className="cv-ms-wrap" ref={ref}>
      <button
        className={`cv-ms-trigger${open ? " ms-open" : ""}${isDirty ? " ms-active" : ""}`}
        onClick={() => setOpen(o => !o)}>
        {triggerLabel}
        <span className="cv-ms-caret">▾</span>
      </button>
      {isDirty && (
        <button className="cv-clear-dates" onClick={() => { onChange(null); setOpen(false); }}>✕</button>
      )}
      {open && (
        <div className="cv-ms-panel">
          {searchable && (
            <div className="cv-ms-search-wrap">
              <input
                ref={searchRef}
                className="cv-ms-search"
                type="text"
                placeholder={`Search ${label}…`}
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {search && (
                <button className="cv-ms-search-clear" onClick={() => setSearch("")}>✕</button>
              )}
            </div>
          )}
          <div className="cv-ms-actions">
            <button className="cv-ms-action" onClick={() => {
              if (search.trim()) {
                // Select only the visible search results
                const next = visibleOptions.length === options.length ? null : [...visibleOptions];
                onChange(next);
              } else {
                // No search active — reset to show all
                onChange(null);
              }
            }}>Select All</button>
            <button className="cv-ms-action" onClick={() => onChange([])}>Clear All</button>
          </div>
          <div className="cv-ms-list">
            {visibleOptions.length === 0
              ? <div className="cv-ms-empty">No matches</div>
              : visibleOptions.map(opt => {
                  const checked = isChecked(opt);
                  return (
                    <label key={opt} className={`cv-ms-item${checked ? " ms-checked" : ""}`}>
                      <input type="checkbox" checked={checked} onChange={() => toggle(opt)} />
                      <span>{opt}</span>
                    </label>
                  );
                })
            }
          </div>
        </div>
      )}
    </div>
  );
}

// ─── AG Titles % Tooltip ─────────────────────────────────────────────────────


// ─── AG × Severity Tooltip ───────────────────────────────────────────────────

function AgSevTooltip({ active, payload, label, accent = TOOLTIP_COLORS[0] }) {
  if (!active || !payload?.length) return null;
  const filtered = payload.filter(p => p.value > 0);
  const total = filtered.reduce((s, p) => s + (p.value || 0), 0);
  return (
    <div className="cv-tooltip" style={{ border:`2px solid ${accent}` }}>
      <div className="cv-tooltip-label" style={{ color: accent }}>{label}</div>
      {filtered.map((p, i) => {
        const color = TOOLTIP_COLORS[i % TOOLTIP_COLORS.length];
        const pct = total ? ((p.value / total) * 100).toFixed(1) : "0.0";
        return (
          <div key={i} className="cv-tooltip-row">
            <span style={{ color:"#f1f5f9" }}>{p.name}</span>
            <span className="cv-tooltip-val">
              <span style={{ color:"#f1f5f9" }}>{p.value.toLocaleString()}</span>
              <span style={{ color:accent, marginLeft:6 }}>({pct}%)</span>
            </span>
          </div>
        );
      })}
      <div className="cv-tooltip-row" style={{ borderTop:"1px solid rgba(255,255,255,0.12)", marginTop:4, paddingTop:4 }}>
        <span style={{ color:"#f1f5f9" }}>Total</span>
        <span className="cv-tooltip-val" style={{ color:"#f1f5f9" }}>{total.toLocaleString()}</span>
      </div>
    </div>
  );
}

// ─── Assignment Group Tooltip ─────────────────────────────────────────────────

function AssignGroupTooltip({ active, payload, label, accent = TOOLTIP_COLORS[0] }) {
  if (!active || !payload?.length) return null;
  const filtered = payload.filter(p => p.value > 0 && p.dataKey !== "other");
  const total = filtered.reduce((s, p) => s + (p.value || 0), 0);
  return (
    <div className="cv-tooltip" style={{ border:`2px solid ${accent}` }}>
      <div className="cv-tooltip-label" style={{ color: accent }}>{label}</div>
      {filtered.map((p, i) => {
        const color = TOOLTIP_COLORS[i % TOOLTIP_COLORS.length];
        const pct = total ? ((p.value / total) * 100).toFixed(1) : "0.0";
        const titleName = p.payload[`${p.dataKey}_name`] || p.name;
        const truncated = titleName.length > 40 ? titleName.slice(0, 40) + "…" : titleName;
        return (
          <div key={i} className="cv-tooltip-row">
            <span style={{ color:"#f1f5f9", flex:1 }}>{truncated}</span>
            <span className="cv-tooltip-val">
              <span style={{ color:"#f1f5f9" }}>{p.value?.toLocaleString()}</span>
              <span style={{ color:accent, marginLeft:6 }}>({pct}%)</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Shared Tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label, accent = TOOLTIP_COLORS[0] }) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (p.value || 0), 0);
  return (
    <div className="cv-tooltip" style={{ border:`2px solid ${accent}` }}>
      <div className="cv-tooltip-label" style={{ color: accent }}>{label}</div>
      {payload.map((p, i) => {
        const color = TOOLTIP_COLORS[i % TOOLTIP_COLORS.length];
        const pct = total ? ((p.value / total) * 100).toFixed(1) : "0.0";
        return (
          <div key={p.name} className="cv-tooltip-row">
            <span style={{ color:"#f1f5f9" }}>{p.name}</span>
            <span className="cv-tooltip-val">
              <span style={{ color:"#f1f5f9" }}>{p.value?.toLocaleString()}</span>
              <span style={{ color:accent, marginLeft:6 }}>({pct}%)</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Incidents tooltip (with optional annotation) ────────────────────────────

function IncidentsTooltip({ active, payload, label, annotations, annotationKeys, accent = TOOLTIP_COLORS[0], priorLabel = "Prior Period" }) {
  if (!active || !payload?.length) return null;
  const bucket     = payload[0]?.payload?._bucket;
  const annotation = bucket ? annotations?.[bucket] : null;
  const annNum     = annotation && annotationKeys ? annotationKeys.indexOf(bucket) + 1 : null;
  const currentPayload = payload.filter(p => p.dataKey !== "_priorTotal");
  const rawPoint   = payload[0]?.payload ?? {};
  const priorTotal = rawPoint._priorTotal ?? null;
  const priorDate  = rawPoint._priorDate  ?? priorLabel;
  const currentTotal = (currentPayload.find(p => p.dataKey === "Total")?.value) ?? 0;
  // Sev lines only (no Total header line, no rolling avg)
  const sevPayload = currentPayload.filter(p => p.dataKey !== "Total" && p.dataKey !== "_rolling7");
  const rollingEntry = currentPayload.find(p => p.dataKey === "_rolling7");

  // Inline trend badge: compares val vs compareVal (fewer incidents = good = green)
  const trendBadge = (val, compareVal) => {
    if (compareVal == null || compareVal === 0) return null;
    const delta = val - compareVal;
    if (delta === 0) return <span style={{ fontSize:14, color:"#94a3b8", marginLeft:7 }}>—</span>;
    const up    = delta > 0;
    const col   = up ? "#ef4444" : "#22c55e";
    const pct   = Math.abs((delta / compareVal) * 100).toFixed(0);
    return (
      <span style={{ fontSize:14, color:col, marginLeft:7, fontWeight:700, whiteSpace:"nowrap" }}>
        {up ? "↑ +" : "↓ −"}{pct}%
      </span>
    );
  };

  // Shared sev row renderer — same format for both current and prior
  // getCompareVal: optional fn(p) → number to show a trend badge per row
  const renderSevRows = (getVal, denominator, getCompareVal = null) =>
    sevPayload.map(p => {
      const val = getVal(p);
      if (val == null) return null;
      const color      = p.stroke || p.color || "#64748b";
      const pct        = denominator ? ((val / denominator) * 100).toFixed(1) : "0.0";
      const compareVal = getCompareVal ? getCompareVal(p) : null;
      return (
        <div key={p.dataKey} className="cv-tooltip-row" style={{ paddingLeft:10, fontSize:16 }}>
          <span style={{ color }}>{p.name}</span>
          <span className="cv-tooltip-val" style={{ color, fontWeight:700 }}>
            {val.toLocaleString()}
            <span style={{ fontSize:14, marginLeft:5, opacity:0.8 }}>({pct}%)</span>
            {trendBadge(val, compareVal)}
          </span>
        </div>
      );
    });

  return (
    <div className="cv-tooltip" style={{ border:`2px solid ${accent}` }}>
      <div className="cv-tooltip-label" style={{ color:"#ffffff", fontSize:16, display:"flex", alignItems:"center", gap:8 }}>
        {label}
        <svg width="32" height="3" style={{ flexShrink:0 }}>
          <line x1="0" y1="1.5" x2="32" y2="1.5" stroke="#ffffff" strokeWidth="2" strokeDasharray="5 3" />
        </svg>
      </div>

      {/* ── Current period ── */}
      <div style={{ marginTop:4, marginBottom:6 }}>
        <div style={{ color:"#ffffff", fontSize:13, fontWeight:600, letterSpacing:"0.5px", textTransform:"uppercase", opacity:0.7 }}>Total</div>
        <div style={{ color:"#ffffff", fontSize:20, fontWeight:800, display:"flex", alignItems:"center", gap:8, lineHeight:1.2 }}>
          {currentTotal.toLocaleString()}
          {trendBadge(currentTotal, priorTotal)}
        </div>
      </div>
      {renderSevRows(
        p => p.value,
        currentTotal,
        priorTotal != null ? (p => rawPoint[`_prior_${p.dataKey}`] ?? null) : null
      )}
      {rollingEntry && (
        <div className="cv-tooltip-row" style={{ fontSize:16, color:"#39FF14" }}>
          <span>{rollingEntry.name}</span>
          <span className="cv-tooltip-val" style={{ color:"#39FF14", fontWeight:700 }}>
            {rollingEntry.value?.toLocaleString()}
          </span>
        </div>
      )}

      {/* ── Prior period ── */}
      {priorTotal != null && (
        <div style={{ borderTop:"2px solid #ffffff", marginTop:6, paddingTop:6 }}>
          <div style={{ marginBottom:6 }}>
            <div style={{ color:"#60a5fa", fontSize:16, fontWeight:600, letterSpacing:"0.5px", textTransform:"uppercase", opacity:0.85 }}>{priorDate}</div>
            <div style={{ color:"#ffffff", fontSize:13, fontWeight:600, letterSpacing:"0.5px", textTransform:"uppercase", opacity:0.7, marginTop:4 }}>Total</div>
            <div style={{ color:"#ffffff", fontSize:20, fontWeight:800, lineHeight:1.2 }}>
              {priorTotal.toLocaleString()}
            </div>
          </div>
          {renderSevRows(p => rawPoint[`_prior_${p.dataKey}`] ?? null, priorTotal)}
          {currentTotal > 0 && (
            <div style={{ textAlign:"right", fontSize:14, color:"#60a5fa", marginTop:4, opacity:0.85 }}>
              {priorTotal > currentTotal ? "+" : ""}{((priorTotal - currentTotal) / currentTotal * 100).toFixed(0)}% vs current
            </div>
          )}
        </div>
      )}

      {/* ── Annotation ── */}
      {annotation && (
        <div style={{
          borderTop:"1px solid rgba(249,115,22,0.35)", marginTop:7, paddingTop:7,
          color:"#f97316", fontSize:14, fontWeight:600, display:"flex", gap:8, alignItems:"flex-start",
        }}>
          {annNum > 0 && (
            <span style={{
              flexShrink:0, width:26, height:26, borderRadius:"50%",
              background:"#38BDF8", color:"#fff", fontSize:15, fontWeight:800,
              display:"inline-flex", alignItems:"center", justifyContent:"center",
              marginTop:1,
            }}>{annNum}</span>
          )}
          <span>{annotation}</span>
        </div>
      )}
    </div>
  );
}

// ─── Stat Tile ────────────────────────────────────────────────────────────────

function Tile({ label, value, sub, color, valueSize, labelStyle, trend, sparkline, onClick, active }) {
  const [sparkHover, setSparkHover] = useState(null); // { date, v, x, y }

  // Chart constants — must match the LineChart props below
  const SPARK_W = 120; const SPARK_ML = 4; const SPARK_MR = 4;
  const plotW = SPARK_W - SPARK_ML - SPARK_MR;

  const handleSparkMove = (e) => {
    if (!sparkline?.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xInPlot = e.clientX - rect.left - SPARK_ML;
    const idx = Math.max(0, Math.min(sparkline.length - 1,
      Math.round((xInPlot / plotW) * (sparkline.length - 1))
    ));
    const pt = sparkline[idx];
    if (pt) setSparkHover({ date: pt.date, v: pt.v, x: e.clientX, y: e.clientY });
  };

  return (
    <div className="cv-tile"
      onClick={onClick}
      style={{ cursor: onClick ? "pointer" : undefined,
               outline: active ? `2px solid ${color || "#38bdf8"}` : undefined,
               outlineOffset: active ? "2px" : undefined,
               boxShadow: active ? `0 0 12px 2px ${color || "#38bdf8"}44` : undefined }}
    >
      <div className="cv-tile-label" style={labelStyle}>{label}</div>
      <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
        <div className="cv-tile-value" style={{ ...(color ? { color } : {}), ...(valueSize ? { fontSize: valueSize } : {}) }}>
          {typeof value === "number" ? value.toLocaleString() : value}
        </div>
        {trend && (
          <span style={{ fontSize:18, fontWeight:400, color:trend.color }}>
            {trend.icon}{trend.label}
          </span>
        )}
      </div>
      {sparkline?.length > 1 && (
        <div style={{ marginTop:4, cursor:"crosshair" }}
          onMouseMove={handleSparkMove}
          onMouseLeave={() => setSparkHover(null)}>
          <LineChart width={SPARK_W} height={36} data={sparkline} margin={{ top:4, right:SPARK_MR, left:SPARK_ML, bottom:2 }}>
            <Line type="monotone" dataKey="v" stroke={color || "#38bdf8"}
              strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </LineChart>
        </div>
      )}
      {sub && <div className="cv-tile-sub">{sub}</div>}

      {/* Sparkline hover popup — fixed to viewport, above the cursor */}
      {sparkHover && (
        <div style={{
          position:"fixed",
        left: Math.min(sparkHover.x + 14, window.innerWidth  - 180),
        top:  Math.max(8, Math.min(sparkHover.y - 110, window.innerHeight - 90)),
          background:"#1e293b", border:"1px solid rgba(255,255,255,0.18)",
          borderRadius:14, padding:"12px 21px", pointerEvents:"none",
          fontSize:27, lineHeight:"41px", whiteSpace:"nowrap", zIndex:9999,
          boxShadow:"0 6px 24px rgba(0,0,0,0.55)",
        }}>
          <div style={{ color:"#94a3b8" }}>{sparkHover.date}</div>
          <div style={{ color: color || "#38bdf8", fontWeight:700 }}>
            {(sparkHover.v ?? 0).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Upload Zone ──────────────────────────────────────────────────────────────

function UploadZone({ onData }) {
  const [dragging, setDragging] = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);

  const parse = (file) => {
    if (!file) return;
    setLoading(true); setError(null);
    Papa.parse(file, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,

      complete: ({ data, meta }) => {
        setLoading(false);
        if (!data.length) { setError("File parsed but contained no rows."); return; }
        onData(data, meta.fields, file.name);
      },
      error: (err) => { setLoading(false); setError(err.message); },
    });
  };

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false);
    parse(e.dataTransfer.files[0]);
  }, []);

  return (
    <div className="cv-upload-page">
      <div className="cv-upload-brand">
        <span className="cv-brand-radar">RADAR</span>{" "}
        <span className="cv-brand-signal">Signal</span>
        <span className="cv-brand-sep"> | Charts</span>
      </div>
      <div
        className={`cv-drop-zone${dragging ? " dragging" : ""}`}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <div className="cv-drop-icon">{loading ? "⏳" : "📂"}</div>
        <div className="cv-drop-title">{loading ? "Parsing…" : "Drop your CSV here"}</div>
        <div className="cv-drop-sub">or click to browse</div>
        <input type="file" accept=".csv" className="cv-drop-input"
          onChange={e => parse(e.target.files[0])} />
      </div>
      {error && <div className="cv-upload-error">⚠ {error}</div>}
    </div>
  );
}

// ─── Detail Panel ────────────────────────────────────────────────────────────

function DetailPanel({ title, rows, wuNum, onClose, showRowTooltip = false, highlightTop3 = true }) {
  const [hoveredRow, setHoveredRow]   = useState(null);
  const [tooltipPos, setTooltipPos]   = useState({ x: 0, y: 0 });

  const wuUrl = wuNum ? `https://portal.cloudfitgov.cloudfit.software/workunitsv2?workUnitId=${wuNum}` : null;

  const handleMouseMove = (e) => {
    const tipW = 260, tipH = 120;
    const x = e.clientX + 16 + tipW > window.innerWidth  - 8 ? e.clientX - tipW - 8 : e.clientX + 16;
    const y = e.clientY - 12 + tipH > window.innerHeight - 8 ? e.clientY - tipH - 8 : e.clientY - 12;
    setTooltipPos({ x: Math.max(8, x), y: Math.max(8, y) });
  };

  return (
    <div className="cv-detail-panel">
      <div className="cv-detail-header">
        <span className="cv-detail-title" title={title}>
          {title}
        </span>
        <button className="cv-detail-close" onClick={onClose}>✕</button>
      </div>
      {wuUrl && (
        <div className="cv-detail-wu">
          <span className="cv-detail-wu-label">WU #</span>
          <a className="cv-detail-wu-link" href={wuUrl} target="_blank" rel="noreferrer">{wuNum}</a>
        </div>
      )}
      <table className="cv-detail-table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Count</th>
            <th>%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={row.total ? "cv-detail-total" : ""}
              onMouseEnter={showRowTooltip ? () => setHoveredRow(row) : undefined}
              onMouseLeave={showRowTooltip ? () => setHoveredRow(null) : undefined}
              onMouseMove={showRowTooltip ? handleMouseMove : undefined}
              style={{
                ...(showRowTooltip ? { cursor:"default" } : {}),
                ...(highlightTop3 && i < 3 && !row.total ? { background:"rgba(239,68,68,0.13)" } : {}),
              }}>
              <td>
                <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                  {row.color && <span className="cv-detail-swatch" style={{ background: row.color }} />}
                  <span>{row.label}</span>
                </div>
                {row.tenant && (
                  <div style={{ color:"#ffe600", fontSize:13, fontWeight:700, marginTop:2, paddingLeft:4 }}>
                    {row.tenant}
                  </div>
                )}
                {row.autoCount > 0 && (
                  <div style={{ color:"#22c55e", fontSize:11, fontWeight:700, marginTop:2, paddingLeft:14 }}>
                    Automation: {row.autoCount.toLocaleString()} ({row.value ? ((row.autoCount / row.value) * 100).toFixed(1) : "0.0"}%)
                  </div>
                )}
                {row.wuNum && (
                  <span className="cv-detail-row-wu-wrap">
                    <span className="cv-detail-row-wu-prefix">WorkUnit:</span>
                    <a className="cv-detail-row-wu"
                      href={`https://portal.cloudfitgov.cloudfit.software/workunitsv2?workUnitId=${row.wuNum}`}
                      target="_blank" rel="noreferrer">
                      WU #{row.wuNum} ↗
                    </a>
                  </span>
                )}
              </td>
              <td>{typeof row.value === "number" ? row.value.toLocaleString() : row.value}</td>
              <td>{row.pct != null ? `${row.pct}%` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Hover tooltip — only rendered when showRowTooltip is true */}
      {showRowTooltip && hoveredRow && (
        <div className="cv-row-hover-tooltip" style={{ left: tooltipPos.x, top: tooltipPos.y }}>
          <div className="cv-row-hover-tooltip__name">{hoveredRow.label}</div>
          <div className="cv-row-hover-tooltip__row">
            <span>Count</span>
            <span>{hoveredRow.value?.toLocaleString() ?? "—"}</span>
          </div>
          {hoveredRow.pct != null && (
            <div className="cv-row-hover-tooltip__row">
              <span>% of Total</span>
              <span className="cv-row-hover-tooltip__pct" style={{ fontSize:"inherit", color:"#e2e8f0" }}>{hoveredRow.pct}%</span>
            </div>
          )}
          {hoveredRow.autoCount > 0 && (() => {
            const nonAuto = hoveredRow.value - hoveredRow.autoCount;
            const autoP   = hoveredRow.value ? ((hoveredRow.autoCount / hoveredRow.value) * 100).toFixed(1) : "0.0";
            const manP    = hoveredRow.value ? ((nonAuto / hoveredRow.value) * 100).toFixed(1) : "0.0";
            return (
              <>
                <div className="cv-row-hover-tooltip__divider" />
                <div className="cv-row-hover-tooltip__row cv-row-hover-tooltip__row--auto">
                  <span>Automation</span>
                  <span>{hoveredRow.autoCount.toLocaleString()} <span className="cv-row-hover-tooltip__pct">({autoP}%)</span></span>
                </div>
                <div className="cv-row-hover-tooltip__row cv-row-hover-tooltip__row--manual">
                  <span>Non-automation</span>
                  <span>{nonAuto.toLocaleString()} <span className="cv-row-hover-tooltip__pct">({manP}%)</span></span>
                </div>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ─── Chart Card wrapper (collapse / copy / sort) ─────────────────────────────

function ChartCard({ id, title, children, collapsed, onToggleCollapse, onCopy, sortIcon, onCycleSort, fullscreenId, onToggleFullscreen, className="", onDragStart, onDragOver, onDrop, onDragEnd, dragOver, style }) {
  const cardRef   = useRef(null);
  const fsCardRef = useRef(null);
  const expanded  = fullscreenId === id;
  const onExpand  = () => onToggleFullscreen?.(id);
  const body = (
    <>
      <div className="cv-chart-title cv-chart-title--toolbar"
        draggable
        onDragStart={e => { e.dataTransfer.effectAllowed="move"; onDragStart?.(id); }}
        style={{ cursor:"grab" }}
      >
        <span className="cv-chart-title-text">{title}</span>
        <div className="cv-chart-toolbar">
          {onCycleSort && (
            <button className="cv-toolbar-btn" onClick={onCycleSort} title="Cycle sort order">{sortIcon}</button>
          )}
          {onToggleFullscreen && !expanded && (
            <button className="cv-toolbar-btn" onClick={onExpand} title="Fullscreen">⛶</button>
          )}
          {/* Copy button visible in both normal and fullscreen modes */}
          <button className="cv-toolbar-btn"
            onClick={() => onCopy(expanded ? fsCardRef.current : cardRef.current)}
            title="Copy as image">📋</button>
          {!expanded && (
            <button className="cv-toolbar-btn" onClick={onToggleCollapse} title={collapsed ? "Expand" : "Collapse"}>
              {collapsed ? "▶" : "▼"}
            </button>
          )}
          {expanded && <button className="cv-toolbar-btn" onClick={onExpand} title="Exit fullscreen">✕</button>}
        </div>
      </div>
      {(!collapsed || expanded) && children}
    </>
  );
  if (expanded) {
    return (
      <>
        <div className="cv-fullscreen-backdrop" onClick={onExpand} />
        <div ref={fsCardRef} className="cv-chart-card cv-chart-card--fullscreen">{body}</div>
      </>
    );
  }
  return (
    <div ref={cardRef}
      id={`chart-${id}`}
      className={`cv-chart-card ${className}${dragOver ? " cv-chart-card--drag-over" : ""}`}
      style={style}
      onDragOver={e => { e.preventDefault(); onDragOver?.(id); }}
      onDrop={e => { e.preventDefault(); onDrop?.(id); }}
      onDragEnd={() => onDragEnd?.()}
    >
      {body}
    </div>
  );
}

// ─── Filter Chips ────────────────────────────────────────────────────────────

function FilterChips({ dateFrom, dateTo, tenantFilter, sevFilter, agFilter,
                       onClearDate, onClearTenant, onClearSev, onClearAg }) {
  const chips = [];
  if (dateFrom || dateTo) chips.push({ label:`📅 ${dateFrom||"…"} → ${dateTo||"…"}`, onClear: onClearDate });
  if (tenantFilter !== null) chips.push({
    label: tenantFilter.length === 0 ? "Tenant: none"
         : tenantFilter.length === 1 ? `Tenant: ${tenantFilter[0]}`
         : `Tenant: ${tenantFilter.length} selected`,
    onClear: onClearTenant,
  });
  if (sevFilter !== null) chips.push({
    label: sevFilter.length === 0 ? "Sev: none"
         : sevFilter.length === 1 ? `Sev: ${sevFilter[0]}`
         : `Sev: ${sevFilter.length} selected`,
    onClear: onClearSev,
  });
  if (agFilter !== null) chips.push({
    label: agFilter.length === 0 ? "AG: none"
         : agFilter.length === 1 ? `AG: ${agFilter[0]}`
         : `AG: ${agFilter.length} selected`,
    onClear: onClearAg,
  });
  if (!chips.length) return null;
  return (
    <div className="cv-filter-chips">
      <span className="cv-chips-label">Active:</span>
      {chips.map((c, i) => (
        <span key={i} className="cv-chip">
          {c.label}
          <button className="cv-chip-clear" onClick={c.onClear}>✕</button>
        </span>
      ))}
    </div>
  );
}

// ─── Preset Manager ───────────────────────────────────────────────────────────

const PRESET_KEY = "radar-signal-presets";

function PresetManager({ current, onLoad }) {
  const [open,    setOpen]    = useState(false);
  const [name,    setName]    = useState("");
  const [presets, setPresets] = useState(() => {
    try { return JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { return []; }
  });
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const save = () => {
    if (!name.trim()) return;
    const next = [...presets, { name: name.trim(), ...current }];
    setPresets(next);
    localStorage.setItem(PRESET_KEY, JSON.stringify(next));
    setName("");
  };
  const remove = (i) => {
    const next = presets.filter((_, idx) => idx !== i);
    setPresets(next);
    localStorage.setItem(PRESET_KEY, JSON.stringify(next));
  };

  return (
    <div className="cv-preset-wrap" ref={ref}>
      <button className="cv-ms-trigger" onClick={() => setOpen(o => !o)}>
        🔖 Presets <span className="cv-ms-caret">▾</span>
      </button>
      {open && (
        <div className="cv-preset-panel">
          <div className="cv-preset-save">
            <input className="cv-ms-search" placeholder="Preset name…" value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && save()} />
            <button className="cv-ms-action" onClick={save}>Save</button>
          </div>
          {presets.length === 0
            ? <div className="cv-ms-empty">No saved presets</div>
            : presets.map((p, i) => (
                <div key={i} className="cv-preset-row">
                  <button className="cv-preset-load" onClick={() => { onLoad(p); setOpen(false); }}>{p.name}</button>
                  <button className="cv-chip-clear" onClick={() => remove(i)}>✕</button>
                </div>
              ))
          }
        </div>
      )}
    </div>
  );
}

// ─── Chart nav sidebar ────────────────────────────────────────────────────────

const CHART_NAV = [
  { id: "incidents",     icon: "📈", label: "Incidents Over Time"                        },
  { id: "severity",      icon: "🎯", label: "By Severity"                                },
  { id: "pie",           icon: "🥧", label: "Top 10 Tenants — Share of Incidents"        },
  { id: "heatmap",       icon: "🔥", label: "Incident Heatmap — Day × Hour"              },
  { id: "agTitles",      icon: "👥", label: "Top 20 Assignment Groups — Top 10 Titles"   },
  { id: "agSpotlight",   icon: "🔦", label: "CS · CFS · MUE · MW · EZX · MADAI"         },
  { id: "agGrouped",     icon: "🧩", label: "TRUST3 & BEST1 Groups"                      },
  { id: "agSev",         icon: "📊", label: "Assignment Groups by Severity"              },
  { id: "tenantTitles",  icon: "🏢", label: "Top 10 Tenants — Top 10 Titles Each"        },
  { id: "titleTenant",   icon: "📋", label: "Top 10 Alerts — Tenant Breakdown (-Auto)"   },
  { id: "titleTenantAll",icon: "📄", label: "Top 10 Alerts — Tenant Breakdown (All)"     },
];

function ChartNav({ chartOrder }) {
  const [activeId,  setActiveId]  = useState(null);
  const [tooltip,   setTooltip]   = useState(null); // { label, y }

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(e => {
          if (e.isIntersecting) setActiveId(e.target.id.replace("chart-", ""));
        });
      },
      { threshold: 0.3 }
    );
    CHART_NAV.forEach(({ id }) => {
      const el = document.getElementById(`chart-${id}`);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [chartOrder]);

  const scrollTo = (id) => {
    const el = document.getElementById(`chart-${id}`);
    if (!el) return;
    const navH     = document.querySelector(".cv-nav")?.offsetHeight     ?? 64;
    const filtersH = document.querySelector(".cv-filters")?.offsetHeight ?? 56;
    const top      = el.getBoundingClientRect().top + window.scrollY - navH - filtersH - 16;
    window.scrollTo({ top, behavior: "smooth" });
  };

  const ordered = chartOrder
    ? [...CHART_NAV].sort((a, b) => {
        const ai = chartOrder.indexOf(a.id);
        const bi = chartOrder.indexOf(b.id);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      })
    : CHART_NAV;

  return (
    <>
      <nav className="cv-chart-nav">
        {ordered.map(({ id, icon, label }) => (
          <button
            key={id}
            className={`cv-chart-nav-btn${activeId === id ? " active" : ""}`}
            onClick={() => scrollTo(id)}
            onMouseEnter={e => {
              const rect = e.currentTarget.getBoundingClientRect();
              const rawY = rect.top + rect.height / 2;
              const y = Math.max(20, Math.min(rawY, window.innerHeight - 20));
              setTooltip({ label, y });
            }}
            onMouseLeave={() => setTooltip(null)}
          >
            <span className="cv-chart-nav-icon">{icon}</span>
          </button>
        ))}
      </nav>

      {tooltip && (
        <div className="cv-chart-nav-tooltip" style={{ top: tooltip.y }}>
          {tooltip.label}
        </div>
      )}
    </>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard({ rows, columns, fileName, onReset, onSwitchView, dateFrom, dateTo, setDateFrom, setDateTo }) {
  const [period,       setPeriod]       = useState("month");
  const [tenantFilter, setTenantFilter] = useState(null);
  const [sevFilter,    setSevFilter]    = useState(null);
  const [agFilter,     setAgFilter]     = useState(null);
  const [exporting,    setExporting]    = useState(false);

  // ── New UX state ─────────────────────────────────────────────────────────
  const [theme,          setTheme]          = useState(() => localStorage.getItem("radar-theme") || "dark");
  const [collapsedCharts,setCollapsedCharts]= useState(new Set());
  const [sortOrders,     setSortOrders]     = useState({ severity: "alpha" });   // { chartId: 'desc'|'asc'|'alpha' }
  const [annotations,    setAnnotations]    = useState({});   // { bucket: text }
  const [annotateMode,   setAnnotateMode]   = useState(false);
  const [annotateInput,  setAnnotateInput]  = useState({ bucket: null, text: "" });
  const [fullscreenId,   setFullscreenId]   = useState(null);
  const [showBackToTop,  setShowBackToTop]  = useState(false);
  const [hoveredHmCell,  setHoveredHmCell]  = useState(null);
  const [hmDayFilter,    setHmDayFilter]    = useState(null);   // 0-6 (day index) or null
  const [hmHourFilter,   setHmHourFilter]   = useState(null);   // 0-23 or null
  const [titleSearch,    setTitleSearch]    = useState("");
  const [showRollingAvg,   setShowRollingAvg]   = useState(false);
  const [showPriorPeriod,  setShowPriorPeriod]  = useState(false);
  const [stackMode,        setStackMode]        = useState(false);
  const [hiddenSeries,     setHiddenSeries]     = useState(new Set());

  // Chart order for drag-and-drop reordering
  const DEFAULT_CHART_ORDER = [
    "incidents","severity","pie","agTitles",
    "agSpotlight","agGrouped","agSev","tenantTitles","titleTenant","titleTenantAll","heatmap",
  ];
  const [chartOrder, setChartOrder] = useState(DEFAULT_CHART_ORDER);
  const dragSrc = useRef(null);
  const [dragOverId, setDragOverId] = useState(null);

  const TT_WRAP = { border: "none", borderRadius: "10px", zIndex: 100 };

  // ── Back-to-top scroll listener ───────────────────────────────────────────
  useEffect(() => {
    const onScroll = () => setShowBackToTop(window.scrollY > 400);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const toggleTheme = () => setTheme(t => { const n = t === "dark" ? "light" : "dark"; localStorage.setItem("radar-theme", n); return n; });

  const toggleCollapse    = id =>
    setCollapsedCharts(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const toggleFullscreen  = id => setFullscreenId(f => f === id ? null : id);
  const fsProps           = { fullscreenId, onToggleFullscreen: toggleFullscreen };

  const cycleSort = id =>
    setSortOrders(prev => ({ ...prev, [id]: prev[id] === "desc" ? "asc" : prev[id] === "asc" ? "alpha" : "desc" }));

  const sortIcon = id => ({ desc:"↓", asc:"↑", alpha:"A-Z" }[sortOrders[id] || "desc"]);

  const applySortToData = (data, id) => {
    const order = sortOrders[id] || "desc";
    if (order === "asc")   return [...data].sort((a,b) => (a.total||a.count||0) - (b.total||b.count||0));
    if (order === "alpha") return [...data].sort((a,b) => (a.name||"").localeCompare(b.name||""));
    return [...data].sort((a,b) => (b.total||b.count||0) - (a.total||a.count||0));
  };

  // Drag-and-drop helpers for chart reordering
  const handleDragStart = (id) => { dragSrc.current = id; };
  const handleDragOver  = (id) => { if (id !== dragSrc.current) setDragOverId(id); };
  const handleDrop      = (targetId) => {
    if (!dragSrc.current || dragSrc.current === targetId) { dragSrc.current = null; setDragOverId(null); return; }
    setChartOrder(prev => {
      const arr = [...prev];
      const fromIdx = arr.indexOf(dragSrc.current);
      const toIdx   = arr.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, dragSrc.current);
      return arr;
    });
    dragSrc.current = null;
    setDragOverId(null);
  };
  const dragProps = (id) => ({
    onDragStart: handleDragStart,
    onDragOver:  handleDragOver,
    onDrop:      handleDrop,
    onDragEnd:   () => setDragOverId(null),
    dragOver:    dragOverId === id,
    style:       { order: chartOrder.indexOf(id) >= 0 ? chartOrder.indexOf(id) : 99 },
  });


  // ── URL filter state sync ─────────────────────────────────────────────────
  useEffect(() => {
    const p = new URLSearchParams();
    if (dateFrom) p.set("from", dateFrom);
    if (dateTo)   p.set("to",   dateTo);
    if (tenantFilter !== null) p.set("tenants", tenantFilter.join(","));
    if (sevFilter    !== null) p.set("sevs",    sevFilter.join(","));
    if (agFilter     !== null) p.set("ags",     agFilter.join(","));
    const str = p.toString();
    window.history.replaceState(null, "", str ? `?${str}` : window.location.pathname);
  }, [dateFrom, dateTo, tenantFilter, sevFilter, agFilter]);

  // Click-to-pin detail panels
  const [tenantPanel,   setTenantPanel]   = useState(null);
  const [tenantTitlesPanel,  setTenantTitlesPanel]  = useState(null);
  const [titleTenantPanel,    setTitleTenantPanel]    = useState(null);
  const [titleTenantAllPanel, setTitleTenantAllPanel] = useState(null);
  const [agSevPanel,      setAgSevPanel]      = useState(null);
  const [agTitlesPanel,   setAgTitlesPanel]   = useState(null);
  const [spotlightPanel,  setSpotlightPanel]  = useState(null);
  const [trust3Panel,     setTrust3Panel]     = useState(null);
  const [best1Panel,      setBest1Panel]      = useState(null);

  // ── Auto-detect column names (handles numeric IDs or text labels) ──────────
  const dateCol            = columns.find(c => /created.?date|date|timestamp/i.test(c)) || "Created Date";
  const sevCol             = columns.find(c => /severity/i.test(c));
  const stateCol           = columns.find(c => /^state/i.test(c));
  const tenantCol          = columns.find(c => /tenant/i.test(c));
  const assignmentGroupCol = columns.find(c => /assignment.?group/i.test(c) || /^ag$/i.test(c));
  const wuCol              = columns.find(c => /^wu$/i.test(c) || /work.?unit/i.test(c));

  const hasDate            = !!dateCol   && columns.includes(dateCol);
  const hasSeverity        = !!sevCol;
  const hasState           = !!stateCol;
  const hasTenant          = !!tenantCol;
  const hasAssignmentGroup = !!assignmentGroupCol;

  // Normalise a severity value to a display label (works for numeric or text)
  const getSevLabel = (val) => {
    if (val == null) return null;
    if (SEV_MAP[val]) return SEV_MAP[val];          // numeric ID → label
    if (typeof val === "string") return val;         // already a text label
    return `Sev ${val}`;
  };

  // Normalise a state value to a display label
  const getStateLabel = (val) => {
    if (val == null) return null;
    if (STATE_MAP[val]) return STATE_MAP[val];
    if (typeof val === "string") return val;
    return `State ${val}`;
  };

  // Colour lookups that work for both numeric IDs and text labels
  const STATE_COLOR_BY_LABEL = Object.fromEntries(
    Object.entries(STATE_MAP).map(([k, v]) => [v, STATE_COLOR[k]])
  );

  const tenants = useMemo(() =>
    hasTenant ? [...new Set(rows.map(r => r[tenantCol]).filter(Boolean))].sort() : [],
  [rows, hasTenant, tenantCol]);

  const severities = useMemo(() =>
    hasSeverity ? [...new Set(rows.map(r => getSevLabel(r[sevCol])).filter(s => s && !/^unknown$/i.test(s)))].sort() : [],
  [rows, hasSeverity, sevCol]);


  const assignmentGroups = useMemo(() =>
    hasAssignmentGroup ? [...new Set(rows.map(r => r[assignmentGroupCol]).filter(Boolean))].sort() : [],
  [rows, hasAssignmentGroup, assignmentGroupCol]);

  const fromTs = dateFrom ? +new Date(dateFrom) : null;
  const toTs   = dateTo   ? +new Date(dateTo + "T23:59:59") : null;

  // titleCol needed by filtered (must be before it)
  const titleCol = columns.find(c => /^title$/i.test(c));

  const filtered = useMemo(() => {
    const tsearch = titleSearch.trim().toLowerCase();
    return rows.filter(r => {
      // Exclude records with a state or severity of "Unknown" (any casing)
      if (hasState    && /^unknown$/i.test(getStateLabel(r[stateCol])    || "")) return false;
      if (hasSeverity && /^unknown$/i.test(getSevLabel(r[sevCol])        || "")) return false;
      if (tenantFilter !== null && !tenantFilter.includes(r[tenantCol])) return false;
      if (sevFilter    !== null && !sevFilter.includes(getSevLabel(r[sevCol]))) return false;
      if (agFilter     !== null && !agFilter.includes(r[assignmentGroupCol])) return false;
      if (fromTs || toTs) {
        const ts = +new Date(r[dateCol]);
        if (isNaN(ts)) return false;
        if (fromTs && ts < fromTs) return false;
        if (toTs   && ts > toTs)   return false;
      }
      // Heatmap drill-down filter
      if (hmDayFilter !== null || hmHourFilter !== null) {
        const d = new Date(r[dateCol]);
        if (isNaN(d)) return false;
        if (hmDayFilter  !== null && d.getDay()   !== hmDayFilter)  return false;
        if (hmHourFilter !== null && d.getHours() !== hmHourFilter) return false;
      }
      // Title keyword search
      if (tsearch && titleCol) {
        const t = (r[titleCol] || "").toLowerCase();
        if (!t.includes(tsearch)) return false;
      }
      return true;
    });
  }, [rows, tenantFilter, sevFilter, agFilter, dateFrom, dateTo, tenantCol, sevCol,
      assignmentGroupCol, dateCol, fromTs, toTs, hmDayFilter, hmHourFilter, titleSearch, titleCol]);

  // Stats — use reduce instead of spread to avoid stack overflow on large arrays
  const dateVals = useMemo(() =>
    filtered.map(r => r[dateCol]).filter(Boolean).map(d => +new Date(d)).filter(n => !isNaN(n)),
  [filtered, dateCol]);

  const minDate = dateVals.length ? new Date(dateVals.reduce((a,b) => Math.min(a,b))).toLocaleDateString() : "—";
  const maxDate = dateVals.length ? new Date(dateVals.reduce((a,b) => Math.max(a,b))).toLocaleDateString() : "—";

  const criticalLabel = getSevLabel(1) || "Sev 1";
  const criticalCount = hasSeverity ? filtered.filter(r => getSevLabel(r[sevCol]) === criticalLabel).length : 0;
  const openCount     = hasState    ? filtered.filter(r => { const l = getStateLabel(r[stateCol]); return l === "New" || l === "On-Hold"; }).length : 0;

  // Time series — by severity + total
  const timeSeriesBySev = useMemo(() => {
    if (!hasDate) return [];
    const map = {};
    for (const r of filtered) {
      const b = getBucket(r[dateCol], period);
      if (!b) continue;
      if (!map[b]) map[b] = { _bucket: b, date: formatBucket(b, period), Total: 0 };
      map[b].Total++;
      if (hasSeverity) {
        const key = getSevLabel(r[sevCol]);
        if (key && !/^unknown$/i.test(key)) map[b][key] = (map[b][key] || 0) + 1;
      }
    }
    const sorted = Object.values(map).sort((x, y) => x._bucket.localeCompare(y._bucket));
    // Compute 7-point rolling average of Total
    const W = 7;
    sorted.forEach((pt, i) => {
      const slice = sorted.slice(Math.max(0, i - W + 1), i + 1);
      pt._rolling7 = Math.round(slice.reduce((s, p) => s + p.Total, 0) / slice.length);
    });
    return sorted;
  }, [filtered, period, hasDate, hasSeverity, dateCol, sevCol]);

  // Prior-period bounds: same duration as current window, immediately before it
  const priorDateBounds = useMemo(() => {
    if (!hasDate) return null;
    let curFrom, curTo;
    if (fromTs && toTs) {
      curFrom = fromTs; curTo = toTs;
    } else if (dateVals.length) {
      curFrom = dateVals.reduce((a, b) => Math.min(a, b));
      curTo   = dateVals.reduce((a, b) => Math.max(a, b));
    } else return null;
    const duration = curTo - curFrom;
    if (duration <= 0) return null;
    const priorTo   = curFrom - 1;
    const priorFrom = priorTo - duration;
    const fmt = ts => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
    return { priorFrom, priorTo, label: `${fmt(priorFrom)} – ${fmt(priorTo)}` };
  }, [hasDate, fromTs, toTs, dateVals]);

  // Time series for the prior period (same non-date filters, shifted date window)
  const timeSeriesPrior = useMemo(() => {
    if (!hasDate || !priorDateBounds) return [];
    const { priorFrom, priorTo } = priorDateBounds;
    const tsearch = titleSearch.trim().toLowerCase();
    const priorRows = rows.filter(r => {
      if (hasState    && /^unknown$/i.test(getStateLabel(r[stateCol])    || "")) return false;
      if (hasSeverity && /^unknown$/i.test(getSevLabel(r[sevCol])        || "")) return false;
      if (tenantFilter !== null && !tenantFilter.includes(r[tenantCol])) return false;
      if (sevFilter    !== null && !sevFilter.includes(getSevLabel(r[sevCol]))) return false;
      if (agFilter     !== null && !agFilter.includes(r[assignmentGroupCol])) return false;
      const ts = +new Date(r[dateCol]);
      if (isNaN(ts) || ts < priorFrom || ts > priorTo) return false;
      if (hmDayFilter  !== null || hmHourFilter !== null) {
        const d = new Date(r[dateCol]);
        if (isNaN(d)) return false;
        if (hmDayFilter  !== null && d.getDay()   !== hmDayFilter)  return false;
        if (hmHourFilter !== null && d.getHours() !== hmHourFilter) return false;
      }
      if (tsearch && titleCol) {
        if (!(r[titleCol] || "").toLowerCase().includes(tsearch)) return false;
      }
      return true;
    });
    const map = {};
    for (const r of priorRows) {
      const b = getBucket(r[dateCol], period);
      if (!b) continue;
      if (!map[b]) map[b] = { _bucketKey: b, Total: 0 };
      map[b].Total++;
      if (hasSeverity) {
        const key = getSevLabel(r[sevCol]);
        if (key && !/^unknown$/i.test(key)) map[b][key] = (map[b][key] || 0) + 1;
      }
    }
    return Object.values(map).sort((x, y) => x._bucketKey.localeCompare(y._bucketKey));
  }, [rows, hasDate, priorDateBounds, period, tenantFilter, sevFilter, agFilter,
      hasState, hasSeverity, stateCol, sevCol, tenantCol, assignmentGroupCol,
      dateCol, hmDayFilter, hmHourFilter, titleSearch, titleCol]);

  // Merge prior Total + per-sev counts into current series by index alignment
  const timeSeriesWithPrior = useMemo(() => {
    if (!showPriorPeriod || !timeSeriesPrior.length) return timeSeriesBySev;
    return timeSeriesBySev.map((pt, i) => {
      const prior = timeSeriesPrior[i];
      if (!prior) return { ...pt, _priorTotal: null };
      const priorSevs = {};
      for (const [k, v] of Object.entries(prior)) {
        if (k !== "Total" && k !== "_bucketKey") priorSevs[`_prior_${k}`] = v;
      }
      return { ...pt, _priorTotal: prior.Total ?? null, _priorDate: formatBucket(prior._bucketKey, period), ...priorSevs };
    });
  }, [timeSeriesBySev, timeSeriesPrior, showPriorPeriod]);

  // In stack mode sort severities by total count desc so the largest sits at the bottom of the stack
  const severitiesForChart = useMemo(() => {
    if (!stackMode || !timeSeriesBySev.length) return severities;
    return [...severities].sort((a, b) => {
      const totA = timeSeriesBySev.reduce((s, pt) => s + (pt[a] || 0), 0);
      const totB = timeSeriesBySev.reduce((s, pt) => s + (pt[b] || 0), 0);
      return totB - totA; // highest first → rendered first → bottom of stack
    });
  }, [severities, stackMode, timeSeriesBySev]);

  // Severity breakdown
  const sevBreakdown = useMemo(() => {
    if (!hasSeverity) return [];
    const map = {};
    for (const r of filtered) {
      const label = getSevLabel(r[sevCol]);
      if (!label) continue;
      const color = SEV_COLOR_BY_LABEL[label] || "#64748b";
      map[label] = { name: label, count: (map[label]?.count || 0) + 1, color };
    }
    return Object.values(map).sort((a,b) => a.name.localeCompare(b.name));
  }, [filtered, hasSeverity, sevCol]);

  // State breakdown
  const stateBreakdown = useMemo(() => {
    if (!hasState) return [];
    const map = {};
    for (const r of filtered) {
      const label = getStateLabel(r[stateCol]);
      if (!label) continue;
      const color = STATE_COLOR_BY_LABEL[label] || "#64748b";
      map[label] = { name: label, count: (map[label]?.count || 0) + 1, color };
    }
    return Object.values(map).sort((a,b) => b.count - a.count);
  }, [filtered, hasState, stateCol]);

  // Top tenants
  const topTenants = useMemo(() => {
    if (!hasTenant) return [];
    const map = {};
    for (const r of filtered) {
      const t = r[tenantCol] || "(blank)";
      map[t] = (map[t] || 0) + 1;
    }
    return Object.entries(map).sort(([,a],[,b]) => b - a).slice(0, 15)
      .map(([name, count]) => ({ name, count }));
  }, [filtered, hasTenant, tenantCol]);

  // Top tenants + top 9 titles per tenant
  const tenantTitlesData = useMemo(() => {
    if (!hasTenant || !titleCol) return [];
    const map = {};
    for (const r of filtered) {
      const tenant = r[tenantCol] || "(blank)";
      const title  = r[titleCol]  || "(no title)";
      if (!map[tenant]) map[tenant] = { total: 0, titles: {} };
      map[tenant].total++;
      map[tenant].titles[title] = (map[tenant].titles[title] || 0) + 1;
    }
    return Object.entries(map)
      .sort(([, a], [, b]) => b.total - a.total)
      .slice(0, 10)
      .map(([name, data]) => {
        const top9   = Object.entries(data.titles).sort(([, a], [, b]) => b - a).slice(0, 10);
        const top9Sum = top9.reduce((s, [, c]) => s + c, 0);
        const obj = { name, total: data.total, other: Math.max(0.001, data.total - top9Sum) };
        top9.forEach(([title, count], i) => {
          obj[`t${i + 1}`]      = count;
          obj[`t${i + 1}_name`] = title;
        });
        return obj;
      });
  }, [filtered, hasTenant, tenantCol, titleCol]);

  // Top 15 Titles → stacked by top tenants
  const titleTenantData = useMemo(() => {
    if (!titleCol || !hasTenant) return [];
    const map = {};
    for (const r of filtered) {
      const title  = r[titleCol];
      if (!title) continue;
      // Exclude any row whose assignment group contains "automation"
      if (assignmentGroupCol && /automation/i.test(r[assignmentGroupCol])) continue;
      const tenant = r[tenantCol] || "(blank)";
      if (!map[title]) map[title] = { total: 0, tenants: {} };
      map[title].total++;
      map[title].tenants[tenant] = (map[title].tenants[tenant] || 0) + 1;
    }
    return Object.entries(map)
      .sort(([, a], [, b]) => b.total - a.total)
      .slice(0, 10)
      .map(([name, data]) => {
        const top9    = Object.entries(data.tenants).sort(([, a], [, b]) => b - a).slice(0, 9);
        const top9Sum = top9.reduce((s, [, c]) => s + c, 0);
        const obj = { name, total: data.total, other: Math.max(0.001, data.total - top9Sum) };
        top9.forEach(([tenant, count], i) => {
          obj[`t${i + 1}`]      = count;
          obj[`t${i + 1}_name`] = tenant;
        });
        return obj;
      });
  }, [filtered, titleCol, hasTenant, tenantCol]);

  // Top 10 Titles → stacked by top tenants (ALL — automation included)
  const titleTenantAllData = useMemo(() => {
    if (!titleCol || !hasTenant) return [];
    const map = {};
    for (const r of filtered) {
      const title  = r[titleCol];
      if (!title) continue;
      const tenant = r[tenantCol] || "(blank)";
      if (!map[title]) map[title] = { total: 0, tenants: {} };
      map[title].total++;
      map[title].tenants[tenant] = (map[title].tenants[tenant] || 0) + 1;
    }
    return Object.entries(map)
      .sort(([, a], [, b]) => b.total - a.total)
      .slice(0, 10)
      .map(([name, data]) => {
        const top9    = Object.entries(data.tenants).sort(([, a], [, b]) => b - a).slice(0, 9);
        const top9Sum = top9.reduce((s, [, c]) => s + c, 0);
        const obj = { name, total: data.total, other: Math.max(0.001, data.total - top9Sum) };
        top9.forEach(([tenant, count], i) => {
          obj[`t${i + 1}`]      = count;
          obj[`t${i + 1}_name`] = tenant;
        });
        return obj;
      });
  }, [filtered, titleCol, hasTenant, tenantCol]);

  // Assignment group + top 3 titles per group
  const assignmentGroupData = useMemo(() => {
    if (!hasAssignmentGroup || !titleCol) return [];
    const groupMap = {};
    for (const r of filtered) {
      const group = r[assignmentGroupCol];
      if (!group) continue;
      const title = r[titleCol] || "(no title)";
      if (!groupMap[group]) groupMap[group] = { total: 0, titles: {} };
      groupMap[group].total++;
      groupMap[group].titles[title] = (groupMap[group].titles[title] || 0) + 1;
    }
    const topGroups = Object.entries(groupMap)
      .sort(([, a], [, b]) => b.total - a.total)
      .slice(0, 20);
    return topGroups.map(([name, data]) => {
      const top3 = Object.entries(data.titles)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 9);
      const top3Sum = top3.reduce((s, [, c]) => s + c, 0);
      const obj = { name, total: data.total, other: Math.max(0.001, data.total - top3Sum) };
      top3.forEach(([title, count], i) => {
        obj[`t${i + 1}`]      = count;
        obj[`t${i + 1}_name`] = title;
      });
      return obj;
    });
  }, [filtered, hasAssignmentGroup, assignmentGroupCol, titleCol]);

  // Filtered AG chart — specific groups only
  const AG_SPOTLIGHT = ["CS","CFS","MUE","MW","EZX","MADAI"];
  const assignmentGroupSpotlight = useMemo(() => {
    if (!hasAssignmentGroup || !titleCol) return [];
    const groupMap = {};
    for (const r of filtered) {
      const group = r[assignmentGroupCol];
      if (!group || !AG_SPOTLIGHT.includes(group)) continue;
      const title = r[titleCol] || "(no title)";
      if (!groupMap[group]) groupMap[group] = { total: 0, titles: {} };
      groupMap[group].total++;
      groupMap[group].titles[title] = (groupMap[group].titles[title] || 0) + 1;
    }
    return Object.entries(groupMap)
      .sort(([, a], [, b]) => b.total - a.total)
      .map(([name, data]) => {
        const top20 = Object.entries(data.titles)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10);
        const topSum = top20.reduce((s, [, c]) => s + c, 0);
        const obj = { name, total: data.total, other: Math.max(0.001, data.total - topSum) };
        top20.forEach(([title, count], i) => {
          obj[`t${i + 1}`]      = count;
          obj[`t${i + 1}_name`] = title;
        });
        return obj;
      });
  }, [filtered, hasAssignmentGroup, assignmentGroupCol, titleCol]);

  // TRUST3 / BEST1 grouped spotlight — all matching AGs merged into one bar each
  const agGroupedSpotlight = useMemo(() => {
    if (!hasAssignmentGroup || !titleCol) return { trust3: [], best1: [] };
    const buildGroup = (pattern, label) => {
      let total = 0;
      const titles = {};
      for (const r of filtered) {
        const group = r[assignmentGroupCol];
        if (!group || !pattern.test(group)) continue;
        const title = r[titleCol] || "(no title)";
        total++;
        titles[title] = (titles[title] || 0) + 1;
      }
      if (total === 0) return [];
      const top10 = Object.entries(titles)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10);
      const topSum = top10.reduce((s, [, c]) => s + c, 0);
      const obj = { name: label, total, other: Math.max(0.001, total - topSum) };
      top10.forEach(([title, count], i) => {
        obj[`t${i + 1}`]      = count;
        obj[`t${i + 1}_name`] = title;
      });
      return [obj];
    };
    return {
      trust3: buildGroup(/TRUST3/i, "TRUST3"),
      best1:  buildGroup(/BEST1/i,  "BEST1"),
    };
  }, [filtered, hasAssignmentGroup, assignmentGroupCol, titleCol]);

  // AG × Severity breakdown
  const assignmentGroupBySev = useMemo(() => {
    if (!hasAssignmentGroup || !hasSeverity) return [];
    const map = {};
    for (const r of filtered) {
      const group = r[assignmentGroupCol];
      if (!group) continue;
      const sev = getSevLabel(r[sevCol]);
      if (!sev || sev === "Unknown") continue;
      if (!map[group]) map[group] = { name: group, total: 0 };
      map[group].total++;
      map[group][sev] = (map[group][sev] || 0) + 1;
    }
    return Object.values(map)
      .sort((a, b) => b.total - a.total)
      .slice(0, 20);
  }, [filtered, hasAssignmentGroup, hasSeverity, assignmentGroupCol, sevCol]);


  // ── Prior-period trend for tiles ─────────────────────────────────────────
  const priorFiltered = useMemo(() => {
    if (!hasDate) return [];
    const span = (fromTs && toTs) ? toTs - fromTs : 30 * 86400000;
    const priorTo   = fromTs ? fromTs - 1 : Date.now() - 30 * 86400000;
    const priorFrom = priorTo - span;
    return rows.filter(r => {
      if (hasState    && /^unknown$/i.test((STATE_MAP[r[stateCol]] || r[stateCol] || ""))) return false;
      if (hasSeverity && /^unknown$/i.test(getSevLabel(r[sevCol])  || ""))                 return false;
      const ts = +new Date(r[dateCol]);
      return !isNaN(ts) && ts >= priorFrom && ts <= priorTo;
    });
  }, [rows, hasDate, hasState, fromTs, toTs, dateCol, stateCol]);

  // ── Sparkline: daily counts per metric, anchored to the active date filter ──
  const sparklines = useMemo(() => {
    if (!hasDate) return {};

    // Anchor window to the active filter range; fall back to last 30 days from today
    const endDt   = dateTo   ? new Date(dateTo   + "T23:59:59") : new Date();
    const startDt = dateFrom ? new Date(dateFrom + "T00:00:00")
                             : new Date(endDt.getTime() - 29 * 86400000);
    endDt.setHours(23, 59, 59, 999);

    // Cap at 60 daily buckets; for longer ranges use the most-recent 60 days of the window
    const totalDays = Math.round((endDt - startDt) / 86400000) + 1;
    const days      = Math.min(totalDays, 60);

    const buckets = Array.from({ length: days }, (_, i) => {
      const d = new Date(endDt);
      d.setDate(d.getDate() - (days - 1 - i));
      return d.toISOString().slice(0, 10);
    });

    const bucketIdx = Object.fromEntries(buckets.map((b, i) => [b, i]));
    const total = new Array(days).fill(0);
    const bySev = {};
    for (const r of filtered) {
      const ts = new Date(r[dateCol]);
      if (isNaN(ts)) continue;
      const key = ts.toISOString().slice(0, 10);
      const idx = bucketIdx[key];
      if (idx === undefined) continue;
      total[idx]++;
      if (hasSeverity) {
        const sev = getSevLabel(r[sevCol]);
        if (sev) { if (!bySev[sev]) bySev[sev] = new Array(days).fill(0); bySev[sev][idx]++; }
      }
    }
    const fmtBucket = iso => new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month:"short", day:"numeric" });
    const toSpark = arr => arr.map((v, i) => ({ v, date: fmtBucket(buckets[i]) }));
    return { total: toSpark(total), ...Object.fromEntries(Object.entries(bySev).map(([k, v]) => [k, toSpark(v)])) };
  }, [filtered, hasDate, dateCol, hasSeverity, sevCol, dateFrom, dateTo]);

  // ── Heatmap: day-of-week × hour-of-day ───────────────────────────────────
  const heatmapData = useMemo(() => {
    if (!hasDate) return null;
    const DAY_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const grid = Array.from({ length: 7 }, (_, d) =>
      Array.from({ length: 24 }, (_, h) => ({ day: DAY_LABELS[d], hour: h, count: 0 }))
    );
    for (const r of filtered) {
      if (hasAssignmentGroup && /automation/i.test(r[assignmentGroupCol] || "")) continue;
      const d = new Date(r[dateCol]);
      if (isNaN(d)) continue;
      grid[d.getDay()][d.getHours()].count++;
    }
    return grid;
  }, [filtered, hasDate, dateCol, hasAssignmentGroup, assignmentGroupCol]);

  const trendArrow = (curr, prior, invert = false) => {
    if (prior == null) return null;
    const upColor   = invert ? "#22c55e" : "#ef4444";
    const downColor = invert ? "#ef4444" : "#22c55e";
    if (prior === 0) {
      if (curr === 0) return { icon:"▬", color:"#64748b", label:"0%" };
      return { icon:"▲", color: upColor, label:"new" };
    }
    const pct = Math.abs(((curr - prior) / prior) * 100).toFixed(0);
    if (curr > prior) return { icon:"▲", color: upColor,   label:`${pct}%` };
    if (curr < prior) return { icon:"▼", color: downColor, label:`${pct}%` };
    return { icon:"▬", color:"#64748b", label:"0%" };
  };

  // ── AG tile counts (memoized) ─────────────────────────────────────────────
  const AG_TILE_DEFS = useMemo(() => [
    { label: "TRUST3", regex: /TRUST3/i,  invert: true  },
    { label: "BEST1",  regex: /BEST1/i,   invert: true  },
    { label: "CS",     regex: /^CS$/i,    invert: false },
    { label: "CFS",    regex: /^CFS$/i,   invert: false },
    { label: "MUE",    regex: /^MUE$/i,   invert: false },
    { label: "MW",     regex: /^MW$/i,    invert: false },
    { label: "MADAI",  regex: /^MADAI$/i, invert: false },
    { label: "EZX",    regex: /^EZX$/i,   invert: false },
  ], []);

  const agTileCounts = useMemo(() => {
    if (!hasAssignmentGroup) return [];
    const nonAutoTotal = filtered.filter(r => !(/automation/i.test(r[assignmentGroupCol] || ""))).length;
    return AG_TILE_DEFS.map(({ label, regex, invert }, idx) => {
      const count = filtered.filter(r => {
        const ag = r[assignmentGroupCol];
        return ag && regex.test(ag) && !/automation/i.test(ag);
      }).length;
      const priorCount = priorFiltered.filter(r => {
        const ag = r[assignmentGroupCol];
        return ag && regex.test(ag) && !/automation/i.test(ag);
      }).length;
      const pct = nonAutoTotal ? ((count / nonAutoTotal) * 100).toFixed(1) : "0.0";
      return { label, count, pct, priorCount, invert, color: RETRO_PALETTE_REV[idx * 3 % RETRO_PALETTE_REV.length] };
    });
  }, [filtered, priorFiltered, hasAssignmentGroup, assignmentGroupCol, AG_TILE_DEFS]);

  // ── Click handlers ────────────────────────────────────────────────────────
  // Returns the highest WU number from filtered rows where col === val
  const topWu = (col, val) => {
    if (!wuCol || !col) return null;
    let best = -Infinity;
    for (const r of filtered) {
      if (r[col] === val) {
        const n = Number(r[wuCol]);
        if (!isNaN(n) && n > best) best = n;
      }
    }
    return best === -Infinity ? null : best;
  };

  // Bar onClick handlers — receive raw data row directly from <Bar onClick>

  const pinAgSev = (row) => {
    const sevList = severities.filter(s => s !== "Unknown");
    const total   = sevList.reduce((s, sev) => s + (row[sev] || 0), 0);
    setAgSevPanel({
      title: row.name,
      rows: [
        ...sevList.filter(sev => row[sev] > 0).map(sev => ({
          label: sev, value: row[sev], color: SEV_COLOR_BY_LABEL[sev],
          pct: total ? ((row[sev] / total) * 100).toFixed(1) : "0.0",
        })),
      ],
    });
  };

  const pinAgTitles = (setter, row, col, rowWuCol = null, withAutoCount = false, customerCol = null) => {
    const total = row.total || 0;
    const rows  = [];
    for (let i = 1; i <= 10; i++) {
      const v         = row[`t${i}`];
      const titleName = row[`t${i}_name`];
      if (v > 0) {
        const autoCount = (withAutoCount && titleCol && assignmentGroupCol)
          ? filtered.filter(r =>
              r[titleCol] === titleName &&
              (!customerCol || r[customerCol] === row.name) &&
              /automation/i.test(r[assignmentGroupCol] || "")
            ).length
          : 0;
        rows.push({
          label:     titleName || `Title #${i}`,
          value:     v,
          color:     RETRO_PALETTE_REV[i - 1],
          pct:       total ? ((v / total) * 100).toFixed(1) : "0.0",
          wuNum:     rowWuCol ? topWu(rowWuCol, titleName) : null,
          autoCount,
        });
      }
    }
    setter({ title: row.name, rows });
  };

  // Detail panel for title→tenant charts: segments are tenants, autoCount scoped to title+tenant
  const pinTitleTenants = (setter, row) => {
    const total = row.total || 0;
    const rows  = [];
    for (let i = 1; i <= 10; i++) {
      const v          = row[`t${i}`];
      const tenantName = row[`t${i}_name`];
      if (v > 0) {
        const autoCount = (titleCol && assignmentGroupCol && tenantCol)
          ? filtered.filter(r =>
              r[titleCol]  === row.name &&
              r[tenantCol] === tenantName &&
              /automation/i.test(r[assignmentGroupCol] || "")
            ).length
          : 0;
        rows.push({
          label:     tenantName || `Tenant #${i}`,
          value:     v,
          color:     RETRO_PALETTE_REV[i - 1],
          pct:       total ? ((v / total) * 100).toFixed(1) : "0.0",
          autoCount,
        });
      }
    }
    setter({ title: row.name, rows });
  };


  // ── CSV Export ───────────────────────────────────────────────────────────
  const exportCSV = () => {
    const escape = v => {
      if (v == null) return "";
      const s = String(v);
      return (s.includes(",") || s.includes('"') || s.includes("\n"))
        ? `"${s.replace(/"/g, '""')}"`  : s;
    };
    const header = columns.join(",");
    const body   = filtered.map(r => columns.map(c => escape(r[c])).join(",")).join("\n");
    const blob   = new Blob([header + "\n" + body], { type: "text/csv" });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement("a");
    a.href = url; a.download = `radar-export-${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  // ── Copy chart as PNG to clipboard ───────────────────────────────────────
  const copyChartImage = async (cardEl) => {
    try {
      const { default: html2canvas } = await import("html2canvas");
      // Temporarily lift overflow:hidden so the detail panel isn't clipped
      const prevOverflow = cardEl.style.overflow;
      cardEl.style.overflow = "visible";

      const isFullscreen = cardEl.classList.contains("cv-chart-card--fullscreen");
      let opts = { backgroundColor:"#0a0e1a", scale:2, useCORS:true, logging:false };

      if (isFullscreen) {
        // Fixed-position elements aren't sized by their natural layout —
        // use getBoundingClientRect() and zero out scroll offsets so
        // html2canvas captures the actual viewport dimensions.
        const rect = cardEl.getBoundingClientRect();
        opts = {
          ...opts,
          width:        rect.width,
          height:       rect.height,
          scrollX:      0,
          scrollY:      0,
          windowWidth:  window.innerWidth,
          windowHeight: window.innerHeight,
        };
      }

      const canvas = await html2canvas(cardEl, opts);
      cardEl.style.overflow = prevOverflow;
      canvas.toBlob(blob => {
        if (blob) navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      }, "image/png");
    } catch (e) { console.error("Copy failed", e); }
  };

  // ── PDF Export ────────────────────────────────────────────────────────────
  const exportPDF = async () => {
    setExporting(true);
    const savedScroll = window.scrollY;
    try {
      const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);

      const pdf      = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageW    = pdf.internal.pageSize.getWidth();
      const pageH    = pdf.internal.pageSize.getHeight();
      const headerH  = 12;
      const contentW = pageW;
      const contentH = pageH - headerH;
      const dateStr  = new Date().toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" });
      const BG       = [10, 14, 26]; // #0a0e1a

      const captureOpts = (scrollY = 0) => ({
        backgroundColor: "#0a0e1a",
        scale: 2,
        useCORS: true,
        logging: false,
        scrollX: 0,
        scrollY,
      });

      const drawHeader = (page, total) => {
        pdf.setFillColor(...BG);
        pdf.rect(0, 0, pageW, pageH, "F");          // full page dark bg
        pdf.setFillColor(13, 18, 32);
        pdf.rect(0, 0, pageW, headerH, "F");        // header strip
        pdf.setTextColor(56, 189, 248);
        pdf.setFontSize(8);
        pdf.setFont("helvetica", "bold");
        pdf.text("RADAR Signal", 6, 8);
        pdf.setTextColor(100, 116, 139);
        pdf.setFont("helvetica", "normal");
        pdf.text(`${fileName}  |  ${filtered.length.toLocaleString()} records  |  ${dateStr}`, 38, 8);
        pdf.text(`Page ${page} of ${total}`, pageW - 6, 8, { align: "right" });
      };

      const placeCanvas = (canvas) => {
        const ratio = Math.min(contentW / canvas.width, contentH / canvas.height);
        const imgW  = canvas.width  * ratio;
        const imgH  = canvas.height * ratio;
        pdf.addImage(
          canvas.toDataURL("image/jpeg", 0.92), "JPEG",
          (contentW - imgW) / 2,
          headerH + (contentH - imgH) / 2,
          imgW, imgH
        );
      };

      // ── Build page list ──────────────────────────────────────────────────
      const tilesEl      = document.querySelector(".cv-tiles");
      const chartEls     = Array.from(document.querySelectorAll(".cv-chart-card"));
      const incidentsIdx = chartEls.findIndex(el =>
        el.querySelector(".cv-chart-title")?.textContent?.includes("Incidents Over Time")
      );
      const severityIdx = chartEls.findIndex(el =>
        el.querySelector(".cv-chart-title")?.textContent?.includes("By Severity")
      );
      const tenantStackIdx = chartEls.findIndex(el =>
        el.querySelector(".cv-chart-title")?.textContent?.includes("Top 10 Tenants — Top 10 Titles Each")
      );
      const tenantPieIdx = chartEls.findIndex(el =>
        el.querySelector(".cv-chart-title")?.textContent?.includes("Top 10 Tenants — Share of Incidents")
      );
      const page1Indices = new Set([incidentsIdx, severityIdx].filter(i => i >= 0));
      const page2Indices = new Set([tenantStackIdx, tenantPieIdx].filter(i => i >= 0));
      const incidentsCard  = incidentsIdx   >= 0 ? chartEls[incidentsIdx]   : null;
      const severityCard   = severityIdx    >= 0 ? chartEls[severityIdx]    : null;
      const tenantStackCard = tenantStackIdx >= 0 ? chartEls[tenantStackIdx] : null;
      const tenantPieCard   = tenantPieIdx   >= 0 ? chartEls[tenantPieIdx]   : null;
      const remainingCards = chartEls.filter((_, i) => !page1Indices.has(i) && !page2Indices.has(i));

      // Page 1: tiles + Incidents Over Time + By Severity combined in a temp wrapper
      const contentEl = document.querySelector(".cv-content");
      const tempWrap  = document.createElement("div");
      tempWrap.style.cssText = `position:absolute;top:-9999px;left:0;width:${contentEl?.offsetWidth ?? 1200}px;background:#0a0e1a;padding:20px 24px;display:flex;flex-direction:column;gap:20px;box-sizing:border-box;`;
      if (tilesEl)      tempWrap.appendChild(tilesEl.cloneNode(true));
      if (incidentsCard) tempWrap.appendChild(incidentsCard.cloneNode(true));
      if (severityCard)  tempWrap.appendChild(severityCard.cloneNode(true));
      document.body.appendChild(tempWrap);
      await new Promise(r => setTimeout(r, 80));
      const firstCanvas = await html2canvas(tempWrap, captureOpts(0));
      document.body.removeChild(tempWrap);

      // Page 2 wrapper: stacked tenants bar + pie chart
      const tempWrap2 = document.createElement("div");
      tempWrap2.style.cssText = `position:absolute;top:-9999px;left:0;width:${contentEl?.offsetWidth ?? 1200}px;background:#0a0e1a;padding:20px 24px;display:flex;flex-direction:column;gap:20px;box-sizing:border-box;`;
      if (tenantStackCard) tempWrap2.appendChild(tenantStackCard.cloneNode(true));
      if (tenantPieCard)   tempWrap2.appendChild(tenantPieCard.cloneNode(true));
      document.body.appendChild(tempWrap2);
      await new Promise(r => setTimeout(r, 80));
      const secondCanvas = await html2canvas(tempWrap2, captureOpts(0));
      document.body.removeChild(tempWrap2);

      const total = 2 + remainingCards.length;
      drawHeader(1, total);
      placeCanvas(firstCanvas);

      pdf.addPage();
      drawHeader(2, total);
      placeCanvas(secondCanvas);

      // Remaining pages: one card each (starting at page 3)
      for (let i = 0; i < remainingCards.length; i++) {
        pdf.addPage();
        drawHeader(i + 3, total);

        const el = remainingCards[i];
        el.scrollIntoView({ block: "start" });
        await new Promise(r => setTimeout(r, 80));

        const canvas = await html2canvas(el, captureOpts(-window.scrollY));
        placeCanvas(canvas);
      }

      pdf.save(`radar-signal-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (err) {
      console.error("PDF export failed:", err);
      alert("PDF export failed. See console for details.");
    } finally {
      window.scrollTo(0, savedScroll);
      setExporting(false);
    }
  };

  return (
    <div className={`cv-app cv-theme-${theme}`}>
      {/* Nav */}
      <header className="cv-nav">
        <div className="cv-nav-left">
          <span className="cv-brand-radar">RADAR</span>{" "}
          <span className="cv-brand-signal">Signal</span>
          <span className="cv-brand-sep"> | Charts</span>
        </div>
        <div className="cv-nav-logo">
          <img src="/cloudfit-logo.png" alt="CloudFit Software" className="cv-nav-logo-img" />
        </div>
        <div className="cv-nav-right">
          <button className="cv-nav-reset" onClick={toggleTheme} title="Toggle light/dark">
            {theme === "dark" ? "☀ Light" : "🌙 Dark"}
          </button>
          <button className="cv-nav-reset" onClick={() => onSwitchView("table")} title="Switch to Table view">📋 Table</button>
          <button className="cv-nav-reset" onClick={() => onSwitchView("exec")}  title="Executive Summary">🎯 BULLSEYE</button>
          <button className="cv-nav-export cv-nav-export--csv" onClick={exportCSV}>⬇ CSV</button>
          <button className="cv-nav-export" onClick={exportPDF} disabled={exporting}>
            {exporting ? "⏳ Exporting…" : "⬇ PDF"}
          </button>
          <button className="cv-nav-reset" onClick={onReset}>⬆ New File</button>
        </div>
      </header>

      {/* Filters */}
      <div className="cv-filters">
        {hasDate && (
          <DateRangePicker
            dateFrom={dateFrom}
            dateTo={dateTo}
            onChange={(from, to) => { setDateFrom(from); setDateTo(to); }}
            onClear={() => { setDateFrom(""); setDateTo(""); }}
          />
        )}

        {hasTenant && (
          <div className="cv-filter-group">
            <span className="cv-filter-label">Tenant</span>
            <MultiSelect label="Tenants" options={tenants} selected={tenantFilter ?? null} onChange={setTenantFilter} searchable />
          </div>
        )}

        {hasSeverity && (
          <div className="cv-filter-group">
            <span className="cv-filter-label">Severity</span>
            <MultiSelect label="Severities" options={severities} selected={sevFilter ?? null} onChange={setSevFilter} />
          </div>
        )}

        {hasAssignmentGroup && (
          <div className="cv-filter-group">
            <span className="cv-filter-label">AG</span>
            <MultiSelect label="Groups" options={assignmentGroups} selected={agFilter ?? null} onChange={setAgFilter} searchable />
          </div>
        )}

        {titleCol && (
          <div className="cv-filter-group">
            <span className="cv-filter-label">Title</span>
            <div className="cv-title-search-wrap">
              <input
                className="cv-title-search"
                type="text"
                placeholder="Search titles…"
                value={titleSearch}
                onChange={e => setTitleSearch(e.target.value)}
              />
              {titleSearch && (
                <button className="cv-title-search-clear" onClick={() => setTitleSearch("")}>✕</button>
              )}
            </div>
          </div>
        )}

        <PresetManager
          current={{ dateFrom, dateTo, tenantFilter, sevFilter, agFilter }}
          onLoad={p => {
            if (p.dateFrom    !== undefined) setDateFrom(p.dateFrom);
            if (p.dateTo      !== undefined) setDateTo(p.dateTo);
            if (p.tenantFilter !== undefined) setTenantFilter(p.tenantFilter);
            if (p.sevFilter   !== undefined) setSevFilter(p.sevFilter);
            if (p.agFilter    !== undefined) setAgFilter(p.agFilter);
          }}
        />
        {(dateFrom || dateTo || tenantFilter !== null || sevFilter !== null || agFilter !== null || hmDayFilter !== null || hmHourFilter !== null || titleSearch) && (
          <button className="cv-clear-all-btn" onClick={() => {
            setDateFrom(""); setDateTo("");
            setTenantFilter(null); setSevFilter(null); setAgFilter(null);
            setHmDayFilter(null); setHmHourFilter(null);
            setTitleSearch("");
          }}>✕ Clear All</button>
        )}

      </div>

      <FilterChips
        dateFrom={dateFrom} dateTo={dateTo}
        tenantFilter={tenantFilter} sevFilter={sevFilter} agFilter={agFilter}
        onClearDate={()   => { setDateFrom(""); setDateTo(""); }}
        onClearTenant={()  => setTenantFilter(null)}
        onClearSev={()     => setSevFilter(null)}
        onClearAg={()      => setAgFilter(null)}
      />

      {/* Body */}
      <div className="cv-body-wrap">
      <ChartNav chartOrder={chartOrder} />
      <div className="cv-content">

        {/* Tiles */}
        <div className="cv-tiles">
          <Tile label="Total Records" value={filtered.length} color="#22c55e"
            sparkline={sparklines.total}
            sub={(() => {
              if (!hasAssignmentGroup) return undefined;
              const autoCount = filtered.filter(r => /automation/i.test(r[assignmentGroupCol] || "")).length;
              const autoPct   = filtered.length ? ((autoCount / filtered.length) * 100).toFixed(1) : "0.0";
              return `Automation: ${autoPct}% ${autoCount.toLocaleString()}`;
            })()} />
          <Tile label="Date Range" value={minDate} valueSize="20px" color="#415a77"
            sub={
              <span style={{ display:"flex", flexDirection:"column", gap:1 }}>
                <span style={{ fontSize:"18px", color:"#94a3b8", fontWeight:400, letterSpacing:"0.5px" }}>through</span>
                <span style={{ fontSize:"20px", fontWeight:800, color:"#415a77", lineHeight:1.1 }}>{maxDate}</span>
              </span>
            } />
          {hasSeverity && severities.filter(sev => sev !== "Unknown").map(sev => {
            const count      = filtered.filter(r => getSevLabel(r[sevCol]) === sev).length;
            const priorCount = priorFiltered.filter(r => getSevLabel(r[sevCol]) === sev).length;
            const color      = SEV_COLOR_BY_LABEL[sev] || "#64748b";
            const trend      = trendArrow(count, priorCount);
            const isActive   = sevFilter !== null && sevFilter.includes(sev);
            return (
              <Tile key={sev} label={sev} value={count} color={color}
                trend={trend} sparkline={sparklines[sev]}
                active={isActive}
                onClick={() => setSevFilter(isActive ? null : [sev])}
                sub={`${filtered.length ? ((count / filtered.length) * 100).toFixed(1) : 0}% of total`} />
            );
          })}
          {hasTenant && <Tile label="Tenants" value={tenants.length} />}
        </div>

        {/* AG group tiles row — memoized */}
        {agTileCounts.length > 0 && (
          <div className="cv-tiles">
            {agTileCounts.map(({ label, count, pct, priorCount, invert, color }) => {
              const def = AG_TILE_DEFS.find(d => d.label === label);
              const isActive = agFilter !== null && def
                && agFilter.length > 0 && agFilter.every(ag => def.regex.test(ag));
              return (
              <Tile key={label} label={label} value={count} color="#cfdbd5"
                labelStyle={{ color: "#b8b08d", fontSize: "16px" }}
                active={isActive}
                onClick={() => {
                  if (!def) return;
                  if (isActive) { setAgFilter(null); return; }
                  const matches = assignmentGroups.filter(ag => def.regex.test(ag) && !/automation/i.test(ag));
                  setAgFilter(matches.length ? matches : null);
                }}
                trend={trendArrow(count, priorCount, invert)}
                sub={<span style={{ background:"var(--accent-bg)", color:"var(--accent)", border:"1px solid rgba(56,189,248,0.3)", borderRadius:4, padding:"3px 9px", fontSize:13, fontWeight:700, letterSpacing:"0.5px", whiteSpace:"nowrap" }}>{pct}% of total</span>} />
              );
            })}
          </div>
        )}

        {/* Zero-data state */}
        {filtered.length === 0 && (
          <div className="cv-zero-state">
            <div className="cv-zero-icon">🔍</div>
            <div className="cv-zero-title">No records match your filters</div>
            <div className="cv-zero-sub">Try broadening your date range, removing a filter, or clearing all filters.</div>
          </div>
        )}

        {/* Incidents over time — total + per severity */}
        {timeSeriesBySev.length > 0 && (
          <ChartCard id="incidents" collapsed={collapsedCharts.has("incidents")}
            onToggleCollapse={() => toggleCollapse("incidents")} onCopy={copyChartImage} {...fsProps} {...dragProps("incidents")}
            title={
              <span style={{ display:"flex", alignItems:"center", gap:12 }}>
                📈 Incidents Over Time
                <div className="cv-btn-group" style={{ marginLeft:8 }}>
                  {PERIODS.map(p => (
                    <button key={p.key} className={`cv-btn-seg${period === p.key ? " active" : ""}`}
                      onClick={() => setPeriod(p.key)}>{p.label}</button>
                  ))}
                </div>
                <button className={`cv-btn-seg${annotateMode ? " active" : ""}`}
                  onClick={() => setAnnotateMode(m => !m)} title="Toggle annotation mode">✏ Annotate</button>
                <button className={`cv-btn-seg${showRollingAvg ? " active" : ""}`}
                  onClick={() => setShowRollingAvg(v => !v)} title="Toggle 7-period rolling average">〜 Avg</button>
                <button className={`cv-btn-seg${showPriorPeriod ? " active" : ""}`}
                  onClick={() => setShowPriorPeriod(v => !v)}
                  title={priorDateBounds ? `Overlay prior period: ${priorDateBounds.label}` : "Overlay prior period"}>⟳ Prior</button>
                <button className={`cv-btn-seg${stackMode ? " active" : ""}`}
                  onClick={() => setStackMode(v => !v)} title="Toggle stacked / overlapping areas">⊞ Stack</button>
              </span>
            }>
            <div className="cv-chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timeSeriesWithPrior} margin={{ top: 8, right: 24, left: 0, bottom: 4 }}
                  onClick={!annotateMode ? undefined : (data) => {
                    if (!data?.activeLabel) return;
                    const bucket = timeSeriesBySev.find(d => d.date === data.activeLabel)?._bucket || data.activeLabel;
                    const cur = annotations[bucket] || "";
                    const txt = window.prompt(`Annotation for ${data.activeLabel}:`, cur);
                    if (txt !== null) setAnnotations(a => txt ? { ...a, [bucket]: txt } : Object.fromEntries(Object.entries(a).filter(([k]) => k !== bucket)));
                  }}
                  style={{ cursor: annotateMode ? "crosshair" : "default" }}>

                  <defs>
                    {/* #8 — deeper gradient fills */}
                    <linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#ffffff" stopOpacity={0.30} />
                      <stop offset="95%" stopColor="#ffffff" stopOpacity={0.02} />
                    </linearGradient>
                    {severities.map(name => {
                      const color = SEV_COLOR_BY_LABEL[name] || "#64748b";
                      const id = `grad_${name.replace(/\s+/g, "_")}`;
                      return (
                        <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor={color} stopOpacity={0.40} />
                          <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                        </linearGradient>
                      );
                    })}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="date" tick={{ fill:"#89c2d9", fontSize:14 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} tick={{ fill:"#64748b", fontSize:11 }} tickLine={false} axisLine={false} width={44} />
                  <Tooltip content={<IncidentsTooltip annotations={annotations} annotationKeys={Object.keys(annotations).sort()} accent={TOOLTIP_COLORS[0]} priorLabel={priorDateBounds?.label || "Prior Period"} />} wrapperStyle={TT_WRAP} />
                  {/* #1 — clickable legend */}
                  <Legend wrapperStyle={{ fontSize:16, paddingTop:8, zIndex:1, cursor:"pointer" }}
                    onClick={data => {
                      const key = data.dataKey ?? data.value;
                      setHiddenSeries(prev => {
                        const next = new Set(prev);
                        next.has(key) ? next.delete(key) : next.add(key);
                        return next;
                      });
                    }}
                    formatter={(value, entry) => (
                      <span style={{ opacity: hiddenSeries.has(entry.dataKey ?? value) ? 0.3 : 1, transition:"opacity 0.2s" }}>
                        {value}
                      </span>
                    )}
                  />
                  {/* Total area — hidden in stack mode (stack shows per-sev areas summing to total) */}
                  {!stackMode && (
                    <Area type="natural" dataKey="Total" name="Total"
                      hide={hiddenSeries.has("Total")}
                      stroke="#ffffff" strokeWidth={2} strokeDasharray="5 3"
                      fill="url(#gradTotal)" dot={{ r:3, fill:"#ffffff", strokeWidth:0 }}
                      activeDot={{ r:5 }} connectNulls>
                      <LabelList dataKey="Total" position="top"
                        style={{ fill:"#ffffff", fontSize:12, fontWeight:700 }}
                        formatter={v => v > 0 ? v : ""} />
                    </Area>
                  )}
                  {/* #2 — stack vs overlap, #7 — natural curve */}
                  {severitiesForChart.map(name => {
                    const color = SEV_COLOR_BY_LABEL[name] || "#64748b";
                    const id = `grad_${name.replace(/\s+/g, "_")}`;
                    return (
                      <Area key={name} type="natural" dataKey={name} name={name}
                        hide={hiddenSeries.has(name)}
                        stackId={stackMode ? "stack" : undefined}
                        stroke={color} strokeWidth={2}
                        fill={`url(#${id})`} dot={{ r:3, fill:color, strokeWidth:0 }}
                        activeDot={{ r:5 }} connectNulls>
                        <LabelList dataKey={name} position="top"
                          style={{ fill:color, fontSize:12, fontWeight:700 }}
                          formatter={v => v > 0 ? v : ""} />
                      </Area>
                    );
                  })}
                  {(() => {
                    const sortedBuckets = Object.keys(annotations).sort();
                    const Y_LEVELS = [14, 38, 62, 86, 110];
                    return sortedBuckets.map((bucket, idx) => {
                      const pt = timeSeriesBySev.find(d => d._bucket === bucket);
                      if (!pt) return null;
                      const num  = idx + 1;
                      const yPos = Y_LEVELS[idx % Y_LEVELS.length];
                      const R    = 14;
                      return (
                        <ReferenceLine key={bucket} x={pt.date} stroke="#f97316" strokeDasharray="4 2"
                          label={(props) => {
                            const cx = (props.viewBox?.x ?? 0) + R + 12;
                            const cy = yPos;
                            return (
                              <g>
                                <circle cx={cx} cy={cy} r={R} fill="#38BDF8" stroke="none" />
                                <text x={cx} y={cy + 1} fill="#ffffff" fontSize={14} fontWeight={800}
                                  textAnchor="middle" dominantBaseline="middle">{num}</text>
                              </g>
                            );
                          }}
                        />
                      );
                    });
                  })()}
                  {showRollingAvg && (
                    <Line type="natural" dataKey="_rolling7" name="7-period Avg"
                      hide={hiddenSeries.has("_rolling7")}
                      stroke="#39FF14" strokeWidth={2} strokeDasharray="6 3"
                      dot={false} activeDot={{ r:4 }} legendType="plainline" />
                  )}
                  {showPriorPeriod && timeSeriesPrior.length > 0 && (
                    <Line type="natural" dataKey="_priorTotal"
                      name={priorDateBounds ? `Prior (${priorDateBounds.label})` : "Prior Period"}
                      hide={hiddenSeries.has("_priorTotal")}
                      stroke="#60a5fa" strokeWidth={2.5} strokeDasharray="7 4"
                      dot={false} activeDot={{ r:5, fill:"#60a5fa" }}
                      legendType="plainline" connectNulls={false} />
                  )}
                  {/* #4 — brush / zoom bar */}
                  <Brush dataKey="date" height={22} travellerWidth={8}
                    stroke="#334155" fill="#0f172a"
                    tickFormatter={() => ""}
                    style={{ marginTop:4 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>
        )}

        {sevBreakdown.length > 0 && (
          <ChartCard id="severity" title="🎯 By Severity"
            collapsed={collapsedCharts.has("severity")} onToggleCollapse={() => toggleCollapse("severity")}
            onCopy={copyChartImage} {...fsProps} sortIcon={sortIcon("severity")} onCycleSort={() => cycleSort("severity")} {...dragProps("severity")}>
            <div className="cv-chart-wrap cv-chart-wrap--sm">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={applySortToData(sevBreakdown, "severity")} layout="vertical" tabIndex={-1}
                  margin={{ top:4, right:200, left:56, bottom:4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                  <XAxis type="number" tick={{ fill:"#64748b", fontSize:11 }} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="name" tick={makeTick(10)} tickFormatter={truncate(10)} tickLine={false} axisLine={false} width={52} />
                  <Tooltip content={<ChartTooltip accent={TOOLTIP_COLORS[1]} />} wrapperStyle={TT_WRAP} cursor={{ fill:"rgba(255,255,255,0.04)" }} offset={80} />
                  <Bar dataKey="count" name="Count" radius={[0,3,3,0]} opacity={0.75}>
                    {sevBreakdown.map((entry, i) => <Cell key={i} fill={entry.color} opacity={0.75} />)}
                    <LabelList dataKey="count" position="right" style={{ fill:"#cbd5e1", fontSize:13, fontWeight:700 }}
                      formatter={v => `${v.toLocaleString()} (${filtered.length ? ((v / filtered.length) * 100).toFixed(1) : 0}%)`} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>
        )}

        {/* Tenant pie chart */}
        {topTenants.length > 0 && (
          <ChartCard id="pie" title="🥧 Top 10 Tenants — Share of Incidents" className="cv-chart-card--pie"
            collapsed={collapsedCharts.has("pie")} onToggleCollapse={() => toggleCollapse("pie")}
            onCopy={copyChartImage} {...fsProps} {...dragProps("pie")}>
            <div className="cv-chart-wrap cv-chart-wrap--pie">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart margin={{ top: 40, right: 160, bottom: 40, left: 40 }}>
                  <Pie
                    data={topTenants.slice(0, 10)}
                    dataKey="count"
                    nameKey="name"
                    opacity={0.75}
                    cx="40%"
                    cy="50%"
                    outerRadius="62%"
                    onClick={(entry) => setTenantFilter([entry.name])}
                    style={{ cursor:"pointer" }}
                    label={({ cx, cy, midAngle, outerRadius, name, value, index }) => {
                      const RADIAN = Math.PI / 180;
                      const radius = outerRadius + 24;
                      const x = cx + radius * Math.cos(-midAngle * RADIAN);
                      const y = cy + radius * Math.sin(-midAngle * RADIAN);
                      const pct = filtered.length ? ((value / filtered.length) * 100).toFixed(1) : "0.0";
                      const n = name.length > 18 ? name.slice(0, 18) + "…" : name;
                      const color = PIE_COLORS[index % PIE_COLORS.length];
                      return (
                        <text x={x} y={y} fill={color}
                          textAnchor={x > cx ? "start" : "end"}
                          dominantBaseline="central"
                          fontSize={15} fontWeight={700}>
                          {n}  {pct}%
                        </text>
                      );
                    }}
                    labelLine={{ stroke: "rgba(255,255,255,0.25)", strokeWidth: 1 }}
                  >
                    {topTenants.slice(0, 10).map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} opacity={0.75} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={<ChartTooltip accent={TOOLTIP_COLORS[2]} />}
                    wrapperStyle={TT_WRAP}
                    formatter={(value, name) => [value.toLocaleString(), name]}
                  />
                  <Legend
                    layout="vertical" tabIndex={-1}
                    align="right"
                    verticalAlign="middle"
                    wrapperStyle={{ paddingLeft: 16, maxWidth: "32%", overflowY:"auto", maxHeight:400 }}
                    content={(props) => <SortedPieLegend {...props} filteredLength={filtered.length} />}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>
        )}

        {/* Top Tenants — stacked by top titles */}
        {tenantTitlesData.length > 0 && (
          <ChartCard id="tenantTitles"
            title={<>🏢 Top 10 Tenants — Top 10 Titles Each <span className="cv-click-hint">click bar to pin</span></>}
            collapsed={collapsedCharts.has("tenantTitles")} onToggleCollapse={() => toggleCollapse("tenantTitles")}
            onCopy={copyChartImage} {...fsProps} sortIcon={sortIcon("tenantTitles")} onCycleSort={() => cycleSort("tenantTitles")} {...dragProps("tenantTitles")}>
            <div style={{ display:"flex", alignItems:"stretch" }}>
            <div style={{ flex:1, minWidth:0 }}>
              <div className="cv-chart-wrap cv-chart-wrap--lg">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={applySortToData(tenantTitlesData,"tenantTitles")} layout="vertical" tabIndex={-1}
                    margin={{ top:4, right:200, left:148, bottom:4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                    <XAxis type="number" tick={{ fill:"#64748b", fontSize:11 }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="name" tick={makeTick(30)} tickFormatter={truncate(30)}
                      tickLine={false} axisLine={false} width={144} />
                    <Tooltip content={<AssignGroupTooltip accent={TOOLTIP_COLORS[3]} />} wrapperStyle={TT_WRAP} cursor={{ fill:"rgba(255,255,255,0.08)" }} offset={80} />
                    {RETRO_PALETTE_REV.slice(0, 10).map((color, i) => (
                      <Bar key={`t${i+1}`} dataKey={`t${i+1}`} name={`Title #${i+1}`} stackId="a" fill={color}
                        radius={[0,0,0,0]} cursor="pointer"
                        onClick={(row) => pinAgTitles(setTenantTitlesPanel, row, tenantCol, titleCol, true, tenantCol)}>
                        {tenantTitlesData.map((entry, j) => (
                          <Cell key={j} fill={color} opacity={cellOpacity(tenantTitlesPanel?.title, entry.name)} />
                        ))}
                      </Bar>
                    ))}
                    <Bar dataKey="other" name="Other" stackId="a" fill="#374151" radius={[0,3,3,0]}
                      cursor="pointer" onClick={(row) => pinAgTitles(setTenantTitlesPanel, row, tenantCol, titleCol, true, tenantCol)}>
                      {tenantTitlesData.map((entry, j) => (
                        <Cell key={j} fill="#374151" opacity={cellOpacity(tenantTitlesPanel?.title, entry.name)} />
                      ))}
                      <LabelList dataKey="total" position="right"
                        formatter={v => v > 0 ? `${v.toLocaleString()} (${filtered.length ? ((v / filtered.length) * 100).toFixed(1) : 0}%)` : ""}
                        style={{ fill:"#cbd5e1", fontSize:13, fontWeight:700 }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            {tenantTitlesPanel && <DetailPanel {...tenantTitlesPanel} onClose={() => setTenantTitlesPanel(null)} showRowTooltip />}
            </div>
          </ChartCard>
        )}

        {/* Assignment Group + Top 3 Titles */}
        {assignmentGroupData.length > 0 && (
          <ChartCard id="agTitles"
            title={<>👥 Top 20 Assignment Groups — Top 10 Titles Each ({assignmentGroupCol}) <span className="cv-click-hint">click bar to pin</span></>}
            collapsed={collapsedCharts.has("agTitles")} onToggleCollapse={() => toggleCollapse("agTitles")}
            onCopy={copyChartImage} {...fsProps} sortIcon={sortIcon("agTitles")} onCycleSort={() => cycleSort("agTitles")} {...dragProps("agTitles")}>
            <div style={{ display:"flex", alignItems:"stretch" }}>
            <div style={{ flex:1, minWidth:0 }}>
              <div className="cv-chart-wrap cv-chart-wrap--xl">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={applySortToData(assignmentGroupData,"agTitles")} layout="vertical" tabIndex={-1}
                    margin={{ top:4, right:220, left:148, bottom:4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                    <XAxis type="number" tick={{ fill:"#64748b", fontSize:11 }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="name" tick={makeTick(30)} tickFormatter={truncate(30)}
                      tickLine={false} axisLine={false} width={144} />
                    <Tooltip content={<AssignGroupTooltip accent={TOOLTIP_COLORS[4]} />} wrapperStyle={TT_WRAP} cursor={{ fill:"rgba(255,255,255,0.08)" }} offset={80} />
                    {RETRO_PALETTE_REV.slice(0, 9).map((color, i) => (
                      <Bar key={`t${i+1}`} dataKey={`t${i+1}`} name={`Title #${i+1}`} stackId="a" fill={color}
                        radius={[0,0,0,0]} cursor="pointer"
                        onClick={(row) => pinAgTitles(setAgTitlesPanel, row, assignmentGroupCol, titleCol)}>
                        {assignmentGroupData.map((entry, j) => (
                          <Cell key={j} fill={color} opacity={cellOpacity(agTitlesPanel?.title, entry.name)} />
                        ))}
                      </Bar>
                    ))}
                    <Bar dataKey="other" name="Other" stackId="a" fill="#374151" radius={[0,3,3,0]}
                      cursor="pointer" onClick={(row) => pinAgTitles(setAgTitlesPanel, row, assignmentGroupCol, titleCol)}>
                      {assignmentGroupData.map((entry, j) => (
                        <Cell key={j} fill="#374151" opacity={cellOpacity(agTitlesPanel?.title, entry.name)} />
                      ))}
                      <LabelList dataKey="total" position="right"
                        formatter={v => v > 0 ? `${v.toLocaleString()} (${filtered.length ? ((v / filtered.length) * 100).toFixed(1) : 0}%)` : ""}
                        style={{ fill:"#cbd5e1", fontSize:13, fontWeight:700 }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            {agTitlesPanel && <DetailPanel {...agTitlesPanel} onClose={() => setAgTitlesPanel(null)} showRowTooltip />}
            </div>
          </ChartCard>
        )}


        {/* AG Spotlight — CS / CFS / MUE / MW / EZX / MADAI */}
        {assignmentGroupSpotlight.length > 0 && (
          <ChartCard id="agSpotlight"
            title={<>🎯 CS · CFS · MUE · MW · EZX · MADAI — Top 10 Titles Each (-Automation) <span className="cv-click-hint">click bar to pin</span></>}
            collapsed={collapsedCharts.has("agSpotlight")} onToggleCollapse={() => toggleCollapse("agSpotlight")}
            onCopy={copyChartImage} {...fsProps} sortIcon={sortIcon("agSpotlight")} onCycleSort={() => cycleSort("agSpotlight")} {...dragProps("agSpotlight")}>
            <div style={{ display:"flex", alignItems:"stretch" }}>
            <div style={{ flex:1, minWidth:0 }}>
              <div className="cv-chart-wrap cv-chart-wrap--lg">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={applySortToData(assignmentGroupSpotlight,"agSpotlight")} layout="vertical" tabIndex={-1}
                    margin={{ top:4, right:200, left:60, bottom:4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                    <XAxis type="number" tick={{ fill:"#64748b", fontSize:11 }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="name" tick={makeTick(20)} tickFormatter={truncate(20)}
                      tickLine={false} axisLine={false} width={56} />
                    <Tooltip content={<AssignGroupTooltip accent={TOOLTIP_COLORS[5]} />} wrapperStyle={TT_WRAP} cursor={{ fill:"rgba(255,255,255,0.08)" }} offset={80} />
                    {RETRO_PALETTE_REV.slice(0, 10).map((color, i) => (
                      <Bar key={`t${i+1}`} dataKey={`t${i+1}`} name={`Title #${i+1}`} stackId="a" fill={color}
                        radius={[0,0,0,0]} cursor="pointer"
                        onClick={(row) => pinAgTitles(setSpotlightPanel, row, assignmentGroupCol, titleCol)}>
                        {assignmentGroupSpotlight.map((entry, j) => (
                          <Cell key={j} fill={color} opacity={cellOpacity(spotlightPanel?.title, entry.name)} />
                        ))}
                      </Bar>
                    ))}
                    <Bar dataKey="other" name="Other" stackId="a" fill="#374151" radius={[0,3,3,0]}
                      cursor="pointer" onClick={(row) => pinAgTitles(setSpotlightPanel, row, assignmentGroupCol, titleCol)}>
                      {assignmentGroupSpotlight.map((entry, j) => (
                        <Cell key={j} fill="#374151" opacity={cellOpacity(spotlightPanel?.title, entry.name)} />
                      ))}
                      <LabelList dataKey="total" position="right"
                        formatter={v => v > 0 ? `${v.toLocaleString()} (${filtered.length ? ((v / filtered.length) * 100).toFixed(1) : 0}%)` : ""}
                        style={{ fill:"#cbd5e1", fontSize:13, fontWeight:700 }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            {spotlightPanel && <DetailPanel {...spotlightPanel} onClose={() => setSpotlightPanel(null)} showRowTooltip />}
            </div>
          </ChartCard>
        )}

        {/* TRUST3 / BEST1 grouped spotlight */}
        {(agGroupedSpotlight.trust3.length > 0 || agGroupedSpotlight.best1.length > 0) && (
          <ChartCard id="agGrouped"
            title={<>🧩 TRUST3 &amp; BEST1 Groups — Top 10 Titles Each (-Automation) <span className="cv-click-hint">click bar to pin</span></>}
            collapsed={collapsedCharts.has("agGrouped")} onToggleCollapse={() => toggleCollapse("agGrouped")}
            onCopy={copyChartImage} {...fsProps} sortIcon={sortIcon("agGrouped")} onCycleSort={() => cycleSort("agGrouped")} {...dragProps("agGrouped")}>

            {(() => {
              const combined = applySortToData(
                [...agGroupedSpotlight.trust3, ...agGroupedSpotlight.best1], "agGrouped"
              );
              return (
                <div style={{ display:"flex", alignItems:"stretch" }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div className="cv-chart-wrap cv-chart-wrap--sm">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={combined} layout="vertical" tabIndex={-1}
                          margin={{ top:4, right:200, left:60, bottom:4 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                          <XAxis type="number" tick={{ fill:"#64748b", fontSize:11 }} tickLine={false} axisLine={false} />
                          <YAxis type="category" dataKey="name" tick={makeTick(20)} tickFormatter={truncate(20)}
                            tickLine={false} axisLine={false} width={70} />
                          <Tooltip content={<AssignGroupTooltip accent={TOOLTIP_COLORS[6]} />} wrapperStyle={TT_WRAP} cursor={{ fill:"rgba(255,255,255,0.08)" }} offset={80} />
                          {RETRO_PALETTE_REV.slice(0, 10).map((color, i) => (
                            <Bar key={`t${i+1}`} dataKey={`t${i+1}`} name={`Title #${i+1}`} stackId="a" fill={color}
                              radius={[0,0,0,0]} cursor="pointer"
                              onClick={(row) => pinAgTitles(setTrust3Panel, row, assignmentGroupCol, titleCol)}>
                              {combined.map((entry, j) => (
                                <Cell key={j} fill={color} opacity={cellOpacity(trust3Panel?.title, entry.name)} />
                              ))}
                            </Bar>
                          ))}
                          <Bar dataKey="other" name="Other" stackId="a" fill="#374151" radius={[0,3,3,0]}
                            cursor="pointer" onClick={(row) => pinAgTitles(setTrust3Panel, row, assignmentGroupCol, titleCol)}>
                            {combined.map((entry, j) => (
                              <Cell key={j} fill="#374151" opacity={cellOpacity(trust3Panel?.title, entry.name)} />
                            ))}
                            <LabelList dataKey="total" position="right"
                              formatter={v => v > 0 ? `${v.toLocaleString()} (${filtered.length ? ((v / filtered.length) * 100).toFixed(1) : 0}%)` : ""}
                              style={{ fill:"#cbd5e1", fontSize:13, fontWeight:700 }} />
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  {trust3Panel && <DetailPanel {...trust3Panel} onClose={() => setTrust3Panel(null)} showRowTooltip />}
                </div>
              );
            })()}

          </ChartCard>
        )}

        {/* AG × Severity */}
        {assignmentGroupBySev.length > 0 && (
          <ChartCard id="agSev"
            title={<>📊 Assignment Groups by Severity — Count &amp; % <span className="cv-click-hint">click bar to pin</span></>}
            collapsed={collapsedCharts.has("agSev")} onToggleCollapse={() => toggleCollapse("agSev")}
            onCopy={copyChartImage} {...fsProps} sortIcon={sortIcon("agSev")} onCycleSort={() => cycleSort("agSev")} {...dragProps("agSev")}>
            <div style={{ display:"flex", alignItems:"stretch" }}>
            <div style={{ flex:1, minWidth:0 }}>
              <div className="cv-chart-wrap cv-chart-wrap--xl">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={applySortToData(assignmentGroupBySev,"agSev")} layout="vertical" tabIndex={-1}
                    margin={{ top:4, right:220, left:148, bottom:4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                    <XAxis type="number" tick={{ fill:"#64748b", fontSize:11 }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="name" tick={makeTick(30)} tickFormatter={truncate(30)}
                      tickLine={false} axisLine={false} width={144} />
                    <Tooltip content={<AgSevTooltip accent={TOOLTIP_COLORS[7]} />} wrapperStyle={TT_WRAP} cursor={{ fill:"rgba(255,255,255,0.08)" }} offset={80} />
                    <Legend wrapperStyle={{ fontSize:24, paddingTop:8 }} />
                    {severities.filter(s => s !== "Unknown").map(sev => (
                      <Bar key={sev} dataKey={sev} name={sev} stackId="a"
                        fill={SEV_COLOR_BY_LABEL[sev] || "#64748b"}
                        radius={[0,0,0,0]} cursor="pointer"
                        onClick={(row) => pinAgSev(row)}>
                        {assignmentGroupBySev.map((entry, i) => (
                          <Cell key={i} fill={SEV_COLOR_BY_LABEL[sev] || "#64748b"}
                            opacity={cellOpacity(agSevPanel?.title, entry.name)} />
                        ))}
                      </Bar>
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            {agSevPanel && <DetailPanel {...agSevPanel} onClose={() => setAgSevPanel(null)} showRowTooltip highlightTop3={false} />}
            </div>
          </ChartCard>
        )}

        {/* Top 15 Titles × Tenants */}
        {titleTenantData.length > 0 && (
          <ChartCard id="titleTenant"
            title={<>📋 Top 10 Alerts — Tenant Breakdown (-Automation) <span className="cv-click-hint">click bar to pin</span></>}
            collapsed={collapsedCharts.has("titleTenant")} onToggleCollapse={() => toggleCollapse("titleTenant")}
            onCopy={copyChartImage} {...fsProps} sortIcon={sortIcon("titleTenant")} onCycleSort={() => cycleSort("titleTenant")} {...dragProps("titleTenant")}>
            <div style={{ display:"flex", alignItems:"stretch" }}>
            <div style={{ flex:1, minWidth:0 }}>
              <div className="cv-chart-wrap cv-chart-wrap--xl">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={applySortToData(titleTenantData,"titleTenant")} layout="vertical" tabIndex={-1}
                    margin={{ top:4, right:200, left:184, bottom:4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                    <XAxis type="number" tick={{ fill:"#64748b", fontSize:11 }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="name" tick={makeTick(38)} tickFormatter={truncate(38)}
                      tickLine={false} axisLine={false} width={180} />
                    <Tooltip content={<AssignGroupTooltip accent={TOOLTIP_COLORS[8]} />} wrapperStyle={TT_WRAP} cursor={{ fill:"rgba(255,255,255,0.08)" }} offset={80} />
                    {RETRO_PALETTE_REV.slice(0, 9).map((color, i) => (
                      <Bar key={`t${i+1}`} dataKey={`t${i+1}`} name={`Tenant #${i+1}`} stackId="a" fill={color}
                        radius={[0,0,0,0]} cursor="pointer"
                        onClick={(row) => pinAgTitles(setTitleTenantPanel, row, titleCol)}>
                        {titleTenantData.map((entry, j) => (
                          <Cell key={j} fill={color} opacity={cellOpacity(titleTenantPanel?.title, entry.name)} />
                        ))}
                      </Bar>
                    ))}
                    <Bar dataKey="other" name="Other" stackId="a" fill="#374151" radius={[0,3,3,0]}
                      cursor="pointer" onClick={(row) => pinAgTitles(setTitleTenantPanel, row, titleCol)}>
                      {titleTenantData.map((entry, j) => (
                        <Cell key={j} fill="#374151" opacity={cellOpacity(titleTenantPanel?.title, entry.name)} />
                      ))}
                      <LabelList dataKey="total" position="right"
                        formatter={v => v > 0 ? `${v.toLocaleString()} (${filtered.length ? ((v / filtered.length) * 100).toFixed(1) : 0}%)` : ""}
                        style={{ fill:"#cbd5e1", fontSize:13, fontWeight:700 }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            {titleTenantPanel && <DetailPanel {...titleTenantPanel} onClose={() => setTitleTenantPanel(null)} showRowTooltip />}
            </div>
          </ChartCard>
        )}

        {/* Top 10 Titles × Tenants — ALL (automation included, with per-tenant auto breakdown) */}
        {titleTenantAllData.length > 0 && (
          <ChartCard id="titleTenantAll"
            title={<>📋 Top 10 Alerts — Tenant Breakdown (All) <span className="cv-click-hint">click bar to pin</span></>}
            collapsed={collapsedCharts.has("titleTenantAll")} onToggleCollapse={() => toggleCollapse("titleTenantAll")}
            onCopy={copyChartImage} {...fsProps} sortIcon={sortIcon("titleTenantAll")} onCycleSort={() => cycleSort("titleTenantAll")} {...dragProps("titleTenantAll")}>
            <div style={{ display:"flex", alignItems:"stretch" }}>
            <div style={{ flex:1, minWidth:0 }}>
              <div className="cv-chart-wrap cv-chart-wrap--xl">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={applySortToData(titleTenantAllData,"titleTenantAll")} layout="vertical" tabIndex={-1}
                    margin={{ top:4, right:200, left:184, bottom:4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                    <XAxis type="number" tick={{ fill:"#64748b", fontSize:11 }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="name" tick={makeTick(38)} tickFormatter={truncate(38)}
                      tickLine={false} axisLine={false} width={180} />
                    <Tooltip content={<AssignGroupTooltip accent={TOOLTIP_COLORS[9]} />} wrapperStyle={TT_WRAP} cursor={{ fill:"rgba(255,255,255,0.08)" }} offset={80} />
                    {RETRO_PALETTE_REV.slice(0, 9).map((color, i) => (
                      <Bar key={`t${i+1}`} dataKey={`t${i+1}`} name={`Tenant #${i+1}`} stackId="a" fill={color}
                        radius={[0,0,0,0]} cursor="pointer"
                        onClick={(row) => pinTitleTenants(setTitleTenantAllPanel, row)}>
                        {titleTenantAllData.map((entry, j) => (
                          <Cell key={j} fill={color} opacity={cellOpacity(titleTenantAllPanel?.title, entry.name)} />
                        ))}
                      </Bar>
                    ))}
                    <Bar dataKey="other" name="Other" stackId="a" fill="#374151" radius={[0,3,3,0]}
                      cursor="pointer" onClick={(row) => pinTitleTenants(setTitleTenantAllPanel, row)}>
                      {titleTenantAllData.map((entry, j) => (
                        <Cell key={j} fill="#374151" opacity={cellOpacity(titleTenantAllPanel?.title, entry.name)} />
                      ))}
                      <LabelList dataKey="total" position="right"
                        formatter={v => v > 0 ? `${v.toLocaleString()} (${filtered.length ? ((v / filtered.length) * 100).toFixed(1) : 0}%)` : ""}
                        style={{ fill:"#cbd5e1", fontSize:13, fontWeight:700 }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            {titleTenantAllPanel && <DetailPanel {...titleTenantAllPanel} onClose={() => setTitleTenantAllPanel(null)} showRowTooltip />}
            </div>
          </ChartCard>
        )}

        {/* Heatmap — day of week × hour of day */}
        {heatmapData && (
          <ChartCard id="heatmap" title="🔥 Incident Heatmap — Day × Hour (Top 3 Busiest Hours)"
            collapsed={collapsedCharts.has("heatmap")} onToggleCollapse={() => toggleCollapse("heatmap")}
            onCopy={copyChartImage} {...fsProps} {...dragProps("heatmap")}>
            <div style={{ padding:"16px 24px 20px", overflowX:"auto" }}>
              {(() => {
                const allCounts  = heatmapData.flatMap(row => row.map(c => c.count));
                const maxCount   = Math.max(1, ...allCounts);
                const grandTotal = allCounts.reduce((a, b) => a + b, 0);
                const HOURS      = Array.from({ length: 24 }, (_, h) => h);
                const DAY_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
                const CELL_W = 52; const CELL_H = 44; const DAY_W = 48;

                // Yellow (#ffd700) → Orange (#f97316) → Red (#dc2626)
                // Uses two-segment lerp so mid-range cells are orange, not muddy brown
                const hmColor = (intensity) => {
                  if (intensity === 0) return "rgba(255,255,255,0.05)";
                  let r, g, b;
                  if (intensity <= 0.5) {
                    // yellow → orange:  (255,215,0) → (249,115,22)
                    const t = intensity * 2;
                    r = Math.round(255 + (249 - 255) * t);
                    g = Math.round(215 + (115 - 215) * t);
                    b = Math.round(0   + (22  - 0)   * t);
                  } else {
                    // orange → red:  (249,115,22) → (220,38,38)
                    const t = (intensity - 0.5) * 2;
                    r = Math.round(249 + (220 - 249) * t);
                    g = Math.round(115 + (38  - 115) * t);
                    b = Math.round(22  + (38  - 22)  * t);
                  }
                  const a = (0.25 + intensity * 0.75).toFixed(2);
                  return `rgba(${r},${g},${b},${a})`;
                };

                // Build top-3 rank map: "d-h" → rank (1/2/3)
                const rankMap = {};
                const top3 = heatmapData
                  .flatMap((row, d) => row.map((cell, h) => ({ d, h, count: cell.count })))
                  .filter(c => c.count > 0)
                  .sort((a, b) => b.count - a.count)
                  .slice(0, 3);
                top3.forEach((c, i) => { rankMap[`${c.d}-${c.h}`] = i + 1; });

                // Per-rank styling
                const RANK_STYLE = [
                  { border:"2px solid #ffffff",  shadow:"0 0 10px 2px rgba(255,255,255,0.5)",  labelColor:"#ffffff" },
                  { border:"2px solid #cbd5e1",  shadow:"0 0 8px 1px rgba(203,213,225,0.4)",   labelColor:"#cbd5e1" },
                  { border:"2px solid #fbbf24",  shadow:"0 0 8px 1px rgba(251,191,36,0.35)",   labelColor:"#fbbf24" },
                ];

                return (
                  <div>
                    {/* Hour labels */}
                    <div style={{ display:"flex", marginLeft: DAY_W, marginBottom:6 }}>
                      {HOURS.map(h => (
                        <div key={h} style={{ width:CELL_W, textAlign:"center", fontSize:11, color:"#64748b", flexShrink:0 }}>
                          {h % 3 === 0 ? `${h}:00` : ""}
                        </div>
                      ))}
                    </div>
                    {/* Grid rows */}
                    {heatmapData.map((row, d) => (
                      <div key={d} style={{ display:"flex", alignItems:"center", marginBottom:4 }}>
                        <div style={{ width:DAY_W, fontSize:13, color:"#94a3b8", flexShrink:0, fontWeight:600 }}>{DAY_LABELS[d]}</div>
                        {row.map((cell, h) => {
                          const intensity = cell.count / maxCount;
                          const bg = hmColor(intensity);
                          const rank = rankMap[`${d}-${h}`];
                          const rs = rank ? RANK_STYLE[rank - 1] : null;
                          return (
                            <div key={h}
                              style={{ width:CELL_W, height:CELL_H, borderRadius:4, background:bg,
                                marginRight:3, flexShrink:0, cursor: cell.count > 0 ? "pointer" : "default",
                                position:"relative",
                                border: (hmDayFilter === d && hmHourFilter === h)
                                  ? "2px solid #38BDF8"
                                  : rs
                                    ? rs.border
                                    : cell.count > 0
                                      ? "1px solid rgba(220,100,38,0.3)"
                                      : "1px solid rgba(255,255,255,0.04)",
                                boxShadow: (hmDayFilter === d && hmHourFilter === h)
                                  ? "0 0 10px 2px rgba(56,189,248,0.5)"
                                  : rs ? rs.shadow : "none",
                                transition:"filter 0.1s, box-shadow 0.1s" }}
                              onMouseEnter={e => setHoveredHmCell({ day: DAY_LABELS[d], hour: h, _d: d, count: cell.count, grandTotal, x: e.clientX, y: e.clientY })}
                              onMouseMove={e  => setHoveredHmCell(c => c ? { ...c, x: e.clientX, y: e.clientY } : null)}
                              onMouseLeave={() => setHoveredHmCell(null)}
                              onClick={() => {
                                if (!cell.count) return;
                                if (hmDayFilter === d && hmHourFilter === h) {
                                  setHmDayFilter(null); setHmHourFilter(null);
                                } else {
                                  setHmDayFilter(d); setHmHourFilter(h);
                                }
                              }}
                            >
                              {rank && (
                                <span style={{
                                  position:"absolute", top:2, right:4,
                                  fontSize:11, fontWeight:800, lineHeight:1,
                                  color: rs.labelColor, userSelect:"none",
                                }}>{rank}</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                    {/* Legend */}
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:16, marginLeft:DAY_W }}>
                      <span style={{ fontSize:14, color:"#f1f5f9", fontWeight:600 }}>Low</span>
                      {[0.08,0.2,0.38,0.56,0.74,1].map(v => (
                        <div key={v} style={{ width:38, height:18, borderRadius:4, background:hmColor(v) }} />
                      ))}
                      <span style={{ fontSize:14, color:"#f1f5f9", fontWeight:600 }}>High ({maxCount.toLocaleString()})</span>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Active drill-down badge */}
            {hmDayFilter !== null && hmHourFilter !== null && (() => {
              const DAY_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
              return (
                <div style={{ padding:"4px 24px 8px", display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ background:"rgba(56,189,248,0.15)", border:"1px solid rgba(56,189,248,0.5)",
                    borderRadius:6, color:"#38BDF8", fontSize:12, fontWeight:700, padding:"3px 10px" }}>
                    🔍 Filtered: {DAY_LABELS[hmDayFilter]} {hmHourFilter}:00–{hmHourFilter}:59
                  </span>
                  <button onClick={() => { setHmDayFilter(null); setHmHourFilter(null); }}
                    style={{ background:"none", border:"none", color:"#94a3b8", cursor:"pointer", fontSize:13 }}>✕ Clear</button>
                </div>
              );
            })()}

            {/* Hover popup — fixed to viewport so it follows cursor */}
            {hoveredHmCell && (
              <div style={{
                position:"fixed", left: hoveredHmCell.x + 16, top: hoveredHmCell.y - 16,
                background:"#1e293b", border:"1px solid rgba(249,115,22,0.5)",
                borderRadius:8, padding:"10px 16px", zIndex:9999, pointerEvents:"none",
                boxShadow:"0 6px 24px rgba(0,0,0,0.6)", minWidth:170,
              }}>
                <div style={{ color:"#fbbf24", fontWeight:700, fontSize:13, marginBottom:6 }}>
                  {hoveredHmCell.day} &nbsp;{hoveredHmCell.hour}:00 – {hoveredHmCell.hour}:59
                </div>
                <div style={{ color:"#f1f5f9", fontSize:22, fontWeight:700, lineHeight:1 }}>
                  {hoveredHmCell.count.toLocaleString()}
                </div>
                <div style={{ color:"#94a3b8", fontSize:12, marginTop:4 }}>
                  {hoveredHmCell.count > 0 && hoveredHmCell.grandTotal > 0
                    ? `${((hoveredHmCell.count / hoveredHmCell.grandTotal) * 100).toFixed(2)}% of all incidents`
                    : "No incidents"}
                </div>
                {hoveredHmCell.count > 0 && (
                  <div style={{ color:"#38BDF8", fontSize:11, marginTop:6, fontWeight:600 }}>
                    {hmDayFilter === hoveredHmCell._d && hmHourFilter === hoveredHmCell.hour
                      ? "Click to remove filter" : "Click to drill down"}
                  </div>
                )}
              </div>
            )}
          </ChartCard>
        )}

      </div>
      </div>{/* /cv-body-wrap */}

      {/* Back to top */}
      {showBackToTop && (
        <button className="cv-back-to-top" onClick={() => window.scrollTo({ top:0, behavior:"smooth" })}
          title="Back to top">▲</button>
      )}
    </div>
  );
}

// ─── Table Row Expand Panel ───────────────────────────────────────────────────

function TableRowPanel({ row, columns, wuCol, onClose, onPrev, onNext, hasPrev, hasNext }) {
  return (
    <div className="cv-row-panel">
      <div className="cv-row-panel-header">
        <span className="cv-row-panel-title">Row Detail</span>
        <div style={{ display:"flex", gap:6 }}>
          <button className="cv-row-panel-nav" onClick={onPrev} disabled={!hasPrev} title="Previous row">↑</button>
          <button className="cv-row-panel-nav" onClick={onNext} disabled={!hasNext} title="Next row">↓</button>
          <button className="cv-detail-close" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="cv-row-panel-body">
        {columns.map(col => {
          const val = row[col] ?? "";
          const isWu = col === wuCol && val;
          return (
            <div key={col} className="cv-row-panel-field">
              <div className="cv-row-panel-label">{col}</div>
              <div className="cv-row-panel-value">
                {isWu ? (
                  <a href={`https://portal.cloudfitgov.cloudfit.software/workunitsv2?workUnitId=${val}`}
                    target="_blank" rel="noreferrer" className="cv-table-wu-link">
                    WU #{val} ↗
                  </a>
                ) : String(val)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Table View ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 500;

function TableView({ rows, columns, fileName, onReset, onSwitchView, dateFrom, dateTo, setDateFrom, setDateTo }) {
  // ── All hooks first ──────────────────────────────────────────────────────
  const [colFilters,   setColFilters]   = useState({});
  const [globalSearch, setGlobalSearch] = useState("");
  const [sortCol,      setSortCol]      = useState(null);
  const [sortDir,      setSortDir]      = useState("asc");
  const [page,         setPage]         = useState(1);
  const [showFilters,  setShowFilters]  = useState(true);
  const [hiddenCols,     setHiddenCols]     = useState(new Set());
  const [showColPanel,   setShowColPanel]   = useState(false);
  const [selectedRowIdx, setSelectedRowIdx] = useState(null); // index into sorted[]
  const [density,        setDensity]        = useState("comfortable"); // compact | comfortable | spacious
  const [copiedIdx,      setCopiedIdx]      = useState(null);
  const colPanelRef = useRef(null);

  // ── Column detection (not hooks, but needed before useMemo) ─────────────
  const sevCol    = columns.find(c => /severity/i.test(c));
  const stateCol  = columns.find(c => /^state/i.test(c));
  const tenantCol = columns.find(c => /tenant/i.test(c));
  const agCol     = columns.find(c => /assignment.?group/i.test(c) || /^ag$/i.test(c));
  const dateCol   = columns.find(c => /created.?date|date|timestamp/i.test(c));
  const wuCol     = columns.find(c => /^wu$/i.test(c) || /work.?unit/i.test(c));

  const dropdownCols = useMemo(() => {
    const special = [sevCol, stateCol, tenantCol, agCol].filter(Boolean);
    const result = {};
    for (const col of special) {
      const vals = [...new Set(rows.map(r => String(r[col] ?? "")).filter(Boolean))].sort();
      result[col] = vals;
    }
    return result;
  }, [rows, sevCol, stateCol, tenantCol, agCol]);

  const fromTs = dateFrom ? +new Date(dateFrom)             : null;
  const toTs   = dateTo   ? +new Date(dateTo + "T23:59:59") : null;

  const filtered = useMemo(() => {
    let result = rows;
    const gs = globalSearch.trim().toLowerCase();
    if (gs) {
      result = result.filter(r =>
        columns.some(c => String(r[c] ?? "").toLowerCase().includes(gs))
      );
    }
    // Date range filter
    if ((fromTs || toTs) && dateCol) {
      result = result.filter(r => {
        const ts = +new Date(r[dateCol]);
        if (isNaN(ts)) return false;
        if (fromTs && ts < fromTs) return false;
        if (toTs   && ts > toTs)   return false;
        return true;
      });
    }
    for (const [col, val] of Object.entries(colFilters)) {
      if (!val || val === null) continue;
      if (dropdownCols[col]) {
        if (Array.isArray(val) && val.length > 0) {
          result = result.filter(r => val.includes(String(r[col] ?? "")));
        }
      } else {
        const v = val.toLowerCase();
        result = result.filter(r => String(r[col] ?? "").toLowerCase().includes(v));
      }
    }
    return result;
  }, [rows, columns, globalSearch, colFilters, fromTs, toTs, dateCol]);

  const sorted = useMemo(() => {
    if (!sortCol) return filtered;
    return [...filtered].sort((a, b) => {
      const av = a[sortCol] ?? ""; const bv = b[sortCol] ?? "";
      const an = Number(av); const bn = Number(bv);
      const cmp = (!isNaN(an) && !isNaN(bn)) ? an - bn : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortCol, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows   = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const hasAnyFilter = globalSearch || dateFrom || dateTo || Object.values(colFilters).some(v =>
    v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)
  );

  const setColFilter = (col, val) => { setColFilters(f => ({ ...f, [col]: val })); setPage(1); };

  const clearAll = () => {
    const reset = {};
    Object.keys(colFilters).forEach(col => { reset[col] = dropdownCols[col] ? null : ""; });
    setColFilters(reset);
    setGlobalSearch("");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  };

  const exportCSV = () => {
    const escape = (v) => {
      const s = v == null ? "" : String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = columns.join(",");
    const body   = sorted.map(row => columns.map(c => escape(row[c])).join(",")).join("\n");
    const blob   = new Blob([header + "\n" + body], { type: "text/csv;charset=utf-8;" });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement("a");
    a.href = url;
    a.download = `export_${filtered.length}_rows.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyRow = (row, absIdx, e) => {
    if (e) e.stopPropagation();
    const text = columns.map(c => {
      const val = row[c] ?? "";
      if (c === wuCol && val) return `${c}: https://portal.cloudfitgov.cloudfit.software/workunitsv2?workUnitId=${val}`;
      return `${c}: ${val}`;
    }).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopiedIdx(absIdx);
      setTimeout(() => setCopiedIdx(null), 1800);
    });
  };

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  };

  // Keyboard nav for expanded row panel
  useEffect(() => {
    if (selectedRowIdx === null) return;
    const handler = e => {
      if (e.key === "ArrowDown")  { e.preventDefault(); setSelectedRowIdx(i => Math.min(i + 1, sorted.length - 1)); }
      if (e.key === "ArrowUp")    { e.preventDefault(); setSelectedRowIdx(i => Math.max(i - 1, 0)); }
      if (e.key === "Escape")     setSelectedRowIdx(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedRowIdx, sorted.length]);

  const visibleCols = columns.filter(c => !hiddenCols.has(c));
  const firstCol    = visibleCols[0] ?? null;

  const toggleCol = (col) => setHiddenCols(prev => {
    const s = new Set(prev);
    s.has(col) ? s.delete(col) : s.add(col);
    return s;
  });

  // Filter count badge: count active individual filters
  const filterCount = [
    globalSearch ? 1 : 0,
    (dateFrom || dateTo) ? 1 : 0,
    ...Object.values(colFilters).map(v =>
      (v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) ? 1 : 0
    ),
  ].reduce((a, b) => a + b, 0);

  // Close col panel on outside click
  useEffect(() => {
    if (!showColPanel) return;
    const handler = e => { if (colPanelRef.current && !colPanelRef.current.contains(e.target)) setShowColPanel(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showColPanel]);

  return (
    <div className="cv-app cv-app--table">
      {/* Header */}
      <header className="cv-nav">
        <div className="cv-nav-left">
          <img src="/cloudfit-logo.png" alt="CloudFit Software" className="cv-nav-logo-img" />
        </div>
        <div className="cv-nav-center" style={{ flex:1, textAlign:"center", color:"#94a3b8", fontSize:13, fontWeight:600 }}>
          {fileName} — {rows.length.toLocaleString()} records
        </div>
        <div className="cv-nav-right">
          <button className="cv-nav-reset" onClick={() => onSwitchView("dashboard")} title="Switch to Charts">📊 Charts</button>
          <button className="cv-nav-reset" onClick={() => onSwitchView("exec")} title="Executive Summary">🎯 BULLSEYE</button>
          <button className="cv-nav-reset" onClick={onReset}>⬆ New File</button>
        </div>
      </header>

      {/* Search + filter bar */}
      <div className="cv-table-toolbar">
        <div className="cv-table-search-wrap">
          <input className="cv-title-search" style={{ width:260 }}
            type="text" placeholder="🔍 Search all columns…"
            value={globalSearch} onChange={e => { setGlobalSearch(e.target.value); setPage(1); }} />
          {globalSearch && <button className="cv-title-search-clear" onClick={() => { setGlobalSearch(""); setPage(1); }}>✕</button>}
        </div>
        <button className={`cv-table-toolbar-btn${showFilters ? " active" : ""}`}
          onClick={() => setShowFilters(v => !v)}>
          ⚙ Column Filters
          {filterCount > 0 && <span className="cv-filter-badge">{filterCount}</span>}
        </button>

        {/* Column visibility toggle */}
        <div style={{ position:"relative" }} ref={colPanelRef}>
          <button className={`cv-table-toolbar-btn${showColPanel ? " active" : ""}`}
            onClick={() => setShowColPanel(v => !v)}>
            ☰ Columns
            {hiddenCols.size > 0 && <span className="cv-filter-badge">{hiddenCols.size} hidden</span>}
          </button>
          {showColPanel && (
            <div className="cv-col-panel">
              <div className="cv-col-panel-header">
                <span>Show / Hide Columns</span>
                {hiddenCols.size > 0 && (
                  <button className="cv-col-panel-reset" onClick={() => setHiddenCols(new Set())}>Show All</button>
                )}
              </div>
              <div className="cv-col-panel-list">
                {columns.map(col => (
                  <label key={col} className="cv-col-panel-item">
                    <input type="checkbox" checked={!hiddenCols.has(col)}
                      onChange={() => toggleCol(col)} />
                    <span>{col}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Density toggle */}
        <div className="cv-density-toggle">
          {[
            { key:"compact",     icon:"▤", label:"Compact"     },
            { key:"comfortable", icon:"▣", label:"Comfortable" },
            { key:"spacious",    icon:"□", label:"Spacious"     },
          ].map(({ key, icon, label }) => (
            <button key={key}
              className={`cv-density-btn${density === key ? " active" : ""}`}
              title={label}
              onClick={() => setDensity(key)}>
              {icon}
            </button>
          ))}
        </div>

        <button className="cv-clear-all-btn" onClick={clearAll} disabled={!hasAnyFilter}
          style={{ opacity: hasAnyFilter ? 1 : 0.35, cursor: hasAnyFilter ? "pointer" : "default" }}>
          ✕ Clear All Filters
        </button>
        <button className="cv-export-btn" onClick={exportCSV} title="Export filtered rows to CSV">
          ⬇ Export CSV <span style={{ opacity:0.7, fontSize:12 }}>({filtered.length.toLocaleString()})</span>
        </button>
        <span style={{ marginLeft:"auto", color:"#64748b", fontSize:13 }}>
          {filtered.length.toLocaleString()} of {rows.length.toLocaleString()} rows
        </span>
      </div>

      {/* Column filter inputs */}
      {showFilters && (
        <div className="cv-table-col-filters">
          {columns.map(col => {
            const ddValues = dropdownCols[col];
            return (
            <div key={col} className="cv-table-col-filter-item">
              <label className="cv-filter-label" style={{ fontSize:11, marginBottom:2 }}>{col}</label>
              {col === dateCol ? (
                <DateRangePicker
                  dateFrom={dateFrom} dateTo={dateTo}
                  onChange={(from, to) => { setDateFrom(from); setDateTo(to); setPage(1); }}
                  onClear={() => { setDateFrom(""); setDateTo(""); setPage(1); }}
                />
              ) : ddValues ? (
                <MultiSelect
                  label={col}
                  options={ddValues}
                  selected={colFilters[col] ?? null}
                  onChange={val => setColFilter(col, val)}
                  searchable
                />
              ) : (
                <div style={{ position:"relative" }}>
                  <input className="cv-title-search" style={{ width:"100%", fontSize:12, padding:"4px 24px 4px 8px" }}
                    type="text" placeholder="filter…"
                    value={colFilters[col] || ""}
                    onChange={e => setColFilter(col, e.target.value)} />
                  {colFilters[col] && (
                    <button className="cv-title-search-clear" style={{ top:"50%", transform:"translateY(-50%)" }}
                      onClick={() => setColFilter(col, "")}>✕</button>
                  )}
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}

      {/* Table + optional row panel side-by-side */}
      <div style={{ display:"flex", flex:1, minHeight:0 }}>
      <div className="cv-table-wrap">
        <table className={`cv-table cv-table--${density}`}>
          <thead>
            <tr>
              {visibleCols.map(col => (
                <th key={col}
                  className={`cv-table-th${col === firstCol ? " cv-table-frozen" : ""}`}
                  onClick={() => handleSort(col)}>
                  <span>{col}</span>
                  <span className="cv-table-sort-icon">
                    {sortCol === col ? (sortDir === "asc" ? " ↑" : " ↓") : " ↕"}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr><td colSpan={visibleCols.length} className="cv-table-empty">No matching records</td></tr>
            ) : pageRows.map((row, i) => {
              const absIdx = (page - 1) * PAGE_SIZE + i;
              const isSelected = absIdx === selectedRowIdx;
              const isCopied   = absIdx === copiedIdx;
              return (
              <tr key={i}
                className={`cv-table-row${i % 2 === 0 ? "" : " cv-table-row--alt"}${isSelected ? " cv-table-row--selected" : ""}`}
                style={{ cursor:"pointer" }}
                onClick={() => setSelectedRowIdx(isSelected ? null : absIdx)}
                onContextMenu={e => { e.preventDefault(); copyRow(row, absIdx, null); }}>
                {visibleCols.map((col, ci) => {
                  const val    = row[col] ?? "";
                  const frozen = col === firstCol;
                  const isSev  = col === sevCol;
                  const sevColor = isSev ? SEV_COLOR_BY_LABEL[normSevLabel(val)] : null;
                  const cellStyle = sevColor ? {
                    background: sevColor,
                    color: "#000",
                    fontWeight: 700,
                    borderRadius: 4,
                  } : undefined;
                  const copyBtn = ci === 0 ? (
                    <button className={`cv-row-copy-btn${isCopied ? " copied" : ""}`}
                      title="Copy row" onClick={e => copyRow(row, absIdx, e)}>
                      {isCopied ? "✓" : "⎘"}
                    </button>
                  ) : null;
                  if (col === wuCol && val) {
                    return (
                      <td key={col} className={`cv-table-td${frozen ? " cv-table-frozen" : ""}`}>
                        {copyBtn}
                        <a href={`https://portal.cloudfitgov.cloudfit.software/workunitsv2?workUnitId=${val}`}
                          target="_blank" rel="noreferrer" className="cv-table-wu-link">
                          WU #{val} ↗
                        </a>
                      </td>
                    );
                  }
                  return (
                    <td key={col} className={`cv-table-td${frozen ? " cv-table-frozen" : ""}`}>
                      {copyBtn}
                      {sevColor
                        ? <span style={{ ...cellStyle, display:"inline-block", padding:"2px 10px", borderRadius:4 }}>{val}</span>
                        : val}
                    </td>
                  );
                })}
              </tr>
              );
            })}
          </tbody>

        </table>
      </div>

      {/* Row expand panel */}
      {selectedRowIdx !== null && sorted[selectedRowIdx] && (
        <TableRowPanel
          row={sorted[selectedRowIdx]}
          columns={columns}
          wuCol={wuCol}
          onClose={() => setSelectedRowIdx(null)}
          onPrev={() => setSelectedRowIdx(i => Math.max(i - 1, 0))}
          onNext={() => setSelectedRowIdx(i => Math.min(i + 1, sorted.length - 1))}
          hasPrev={selectedRowIdx > 0}
          hasNext={selectedRowIdx < sorted.length - 1}
        />
      )}
      </div>{/* /flex table+panel */}

      {/* Pagination */}
      <div className="cv-table-pagination">
        <button className="cv-btn-seg" disabled={page === 1} onClick={() => setPage(1)}>«</button>
        <button className="cv-btn-seg" disabled={page === 1} onClick={() => setPage(p => p - 1)}>‹</button>
        <span style={{ color:"#94a3b8", fontSize:13, padding:"0 12px" }}>
          Page {page} of {totalPages}
        </span>
        <button className="cv-btn-seg" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>›</button>
        <button className="cv-btn-seg" disabled={page === totalPages} onClick={() => setPage(totalPages)}>»</button>
        <span style={{ color:"#64748b", fontSize:12, marginLeft:12 }}>
          Rows {((page-1)*PAGE_SIZE)+1}–{Math.min(page*PAGE_SIZE, sorted.length)} of {sorted.length.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

// ─── ExecCard ─────────────────────────────────────────────────────────────────

function ExecCard({ id, title, className = "", fullscreenId, onToggleFullscreen, onSaveImage, children }) {
  const cardRef   = useRef(null);
  const fsCardRef = useRef(null);
  const expanded  = fullscreenId === id;

  const toolbar = (
    <div className="cv-chart-toolbar">
      {!expanded && (
        <button className="cv-toolbar-btn" title="Fullscreen"
          onClick={() => onToggleFullscreen?.(id)}>⛶</button>
      )}
      <button className="cv-toolbar-btn" title="Save as PNG"
        onClick={() => onSaveImage?.(expanded ? fsCardRef.current : cardRef.current, title)}>
        🖼
      </button>
      {expanded && (
        <button className="cv-toolbar-btn" title="Exit fullscreen"
          onClick={() => onToggleFullscreen?.(id)}>✕</button>
      )}
    </div>
  );

  const inner = (
    <>
      <div className="cv-exec-card-title" style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <span>{title}</span>
        {toolbar}
      </div>
      {children}
    </>
  );

  if (expanded) {
    return (
      <>
        <div className="cv-fullscreen-backdrop" onClick={() => onToggleFullscreen?.(id)} />
        <div ref={fsCardRef}
          className={`cv-exec-card cv-exec-card--fs ${className}`}
          style={{ position:"fixed", inset:20, zIndex:9000, overflowY:"auto",
                   borderRadius:12, background:"#1e293b", border:"1px solid #334155" }}>
          {inner}
        </div>
      </>
    );
  }

  return (
    <div ref={cardRef} className={`cv-exec-card ${className}`}>
      {inner}
    </div>
  );
}

// ─── Executive Summary ────────────────────────────────────────────────────────

// Product group and sub-group definitions (module-level)
const EXEC_PRODUCT_DEFS = [
  { id:"CS",    label:"CS",    regex:/\bCS\b/i    },
  { id:"MW",    label:"MW",    regex:/\bMW\b/i    },
  { id:"MUE",   label:"MUE",   regex:/\bMUE\b/i   },
  { id:"CFS",   label:"CFS",   regex:/\bCFS\b/i   },
  { id:"EZX",   label:"EZX",   regex:/\bEZX\b/i   },
  { id:"MADAI", label:"MADAI", regex:/\bMADAI\b/i },
];

// ─── Annotation Overlay ───────────────────────────────────────────────────────

const ANNOT_KEY = "c4_exec_annotations";
function loadAnnotData() {
  try {
    const d = JSON.parse(localStorage.getItem(ANNOT_KEY) || '{}');
    return { bullets: d.bullets || [], arrows: d.arrows || [], refs: d.refs || [] };
  } catch { return { bullets: [], arrows: [], refs: [] }; }
}

function AnnotationOverlay({ active, tool, onToolChange, visible = true }) {
  const svgRef     = useRef(null);
  const [ann,      setAnn]      = useState(loadAnnotData);
  const [preview,  setPreview]  = useState(null);
  const [p1,       setP1]       = useState(null);
  const [drag,     setDrag]     = useState(null);
  const [editingId,  setEditingId]  = useState(null);
  const [editText,   setEditText]   = useState("");
  const [refTarget,  setRefTarget]  = useState(null); // id of primary bullet being referenced
  const [snapGuides, setSnapGuides] = useState({ x: null, y: null });
  const SNAP_DIST = 9;

  const persist = (next) => {
    setAnn(next);
    try { localStorage.setItem(ANNOT_KEY, JSON.stringify(next)); } catch {}
  };

  const svgPt = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Control point defaults to midpoint → straight line
  const midPt = (x1, y1, x2, y2) => ({ cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 });

  const bezierD = (a) => {
    const cx = a.cx ?? (a.x1 + a.x2) / 2;
    const cy = a.cy ?? (a.y1 + a.y2) / 2;
    return `M ${a.x1} ${a.y1} Q ${cx} ${cy} ${a.x2} ${a.y2}`;
  };

  const handleBgClick = (e) => {
    if (!active) return;
    if (e.target.closest?.('.annot-bullet') || e.target.closest?.('.annot-arrow-hit') || e.target.closest?.('.annot-bend-handle')) return;
    const pt = svgPt(e);
    if (tool === 'bullet') {
      persist({ ...ann, bullets: [...ann.bullets, { id: Date.now(), x: pt.x, y: pt.y, num: ann.bullets.length + 1 }] });
    } else if (tool === 'ref') {
      if (refTarget) {
        persist({ ...ann, refs: [...(ann.refs || []), { id: Date.now(), x: pt.x, y: pt.y, refBulletId: refTarget }] });
      }
    } else if (tool === 'arrow') {
      if (!p1) {
        setP1(pt);
        setPreview({ x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y });
      } else {
        const { cx, cy } = midPt(p1.x, p1.y, pt.x, pt.y);
        persist({ ...ann, arrows: [...ann.arrows, { id: Date.now(), x1: p1.x, y1: p1.y, x2: pt.x, y2: pt.y, cx, cy }] });
        setP1(null); setPreview(null);
      }
    }
  };

  const handleMouseMove = (e) => {
    if (!active) return;
    const pt = svgPt(e);
    if (p1) setPreview({ x1: p1.x, y1: p1.y, x2: pt.x, y2: pt.y });
    if (drag?.type === 'bullet' || drag?.type === 'ref') {
      let nx = pt.x + drag.ox;
      let ny = pt.y + drag.oy;
      // Collect snap targets — all bullets and refs except the one being dragged
      const targets = [
        ...ann.bullets
          .filter(b => !(drag.type === 'bullet' && b.id === drag.id))
          .map(b => ({ x: b.x, y: b.y })),
        ...(ann.refs || [])
          .filter(r => !(drag.type === 'ref' && r.id === drag.id))
          .map(r => ({ x: r.x, y: r.y })),
      ];
      let snapX = null, snapY = null;
      for (const t of targets) {
        if (Math.abs(nx - t.x) <= SNAP_DIST) { nx = t.x; snapX = t.x; }
        if (Math.abs(ny - t.y) <= SNAP_DIST) { ny = t.y; snapY = t.y; }
      }
      setSnapGuides({ x: snapX, y: snapY });
      if (drag.type === 'bullet') {
        setAnn(prev => ({ ...prev, bullets: prev.bullets.map(b =>
          b.id === drag.id ? { ...b, x: nx, y: ny } : b
        )}));
      } else {
        setAnn(prev => ({ ...prev, refs: (prev.refs || []).map(r =>
          r.id === drag.id ? { ...r, x: nx, y: ny } : r
        )}));
      }
    }
    if (drag?.type === 'bend') {
      setAnn(prev => ({ ...prev, arrows: prev.arrows.map(a =>
        a.id === drag.id ? { ...a, cx: pt.x + drag.ox, cy: pt.y + drag.oy } : a
      )}));
    }
    if (drag?.type === 'start') {
      setAnn(prev => ({ ...prev, arrows: prev.arrows.map(a =>
        a.id === drag.id ? { ...a, x1: pt.x + drag.ox, y1: pt.y + drag.oy } : a
      )}));
    }
    if (drag?.type === 'end') {
      setAnn(prev => ({ ...prev, arrows: prev.arrows.map(a =>
        a.id === drag.id ? { ...a, x2: pt.x + drag.ox, y2: pt.y + drag.oy } : a
      )}));
    }
  };

  const handleMouseUp = () => {
    if (drag) { persist(ann); setDrag(null); }
    setSnapGuides({ x: null, y: null });
  };

  const deleteBullet = (id) => {
    const bullets = ann.bullets.filter(b => b.id !== id).map((b, i) => ({ ...b, num: i + 1 }));
    persist({
      bullets,
      arrows: ann.arrows.filter(a => a.bulletId !== id),
      refs: (ann.refs || []).filter(r => r.refBulletId !== id),
    });
    if (editingId === id) setEditingId(null);
    if (refTarget === id) setRefTarget(null);
  };

  const deleteRef = (id) => persist({ ...ann, refs: (ann.refs || []).filter(r => r.id !== id) });

  const commitEdit = (id) => {
    persist({ ...ann, bullets: ann.bullets.map(b => b.id === id ? { ...b, text: editText.trim() } : b) });
    setEditingId(null);
  };

  const deleteArrow = (id) => persist({ ...ann, arrows: ann.arrows.filter(a => a.id !== id) });

  const nothingPlaced = ann.bullets.length === 0 && ann.arrows.length === 0 && (ann.refs || []).length === 0;

  return (
    <>
      {active && (
        <div className="annot-toolbar">
          <button className={`annot-btn${tool === 'bullet' ? ' annot-btn--on' : ''}`}
            onClick={() => onToolChange(tool === 'bullet' ? null : 'bullet')}>
            ➊ Bullet
          </button>
          <button className={`annot-btn${tool === 'ref' ? ' annot-btn--on' : ''}`}
            onClick={() => { onToolChange(tool === 'ref' ? null : 'ref'); setRefTarget(null); }}
            title="Place a reference marker that shares a number with an existing bullet">
            ⓪ Ref
          </button>
          <button className={`annot-btn${tool === 'arrow' ? ' annot-btn--on' : ''}`}
            onClick={() => { onToolChange(tool === 'arrow' ? null : 'arrow'); setP1(null); setPreview(null); }}>
            ⤷ Arrow
          </button>
          <button className="annot-btn annot-btn--clear" onClick={() => persist({ bullets: [], arrows: [], refs: [] })} disabled={nothingPlaced}>
            🗑 Clear
          </button>
          {/* Ref number picker — shown when Ref tool is active and there are primary bullets */}
          {tool === 'ref' && ann.bullets.length > 0 && (
            <span className="annot-ref-picker">
              <span className="annot-ref-picker-label">Pick #:</span>
              {ann.bullets.map(b => (
                <button key={b.id}
                  className={`annot-ref-num${refTarget === b.id ? ' annot-ref-num--on' : ''}`}
                  onClick={() => setRefTarget(prev => prev === b.id ? null : b.id)}>
                  {b.num}
                </button>
              ))}
            </span>
          )}
          <span className="annot-hint">
            {tool === 'bullet' && 'Click to place · double-click to add text · drag to move · right-click to delete'}
            {tool === 'ref'    && ann.bullets.length === 0 && 'Place a numbered bullet first, then use Ref to add a reference marker'}
            {tool === 'ref'    && ann.bullets.length > 0 && !refTarget && 'Pick a number above, then click to place a reference marker'}
            {tool === 'ref'    && ann.bullets.length > 0 && refTarget  && `Click to place reference ❨${ann.bullets.find(b=>b.id===refTarget)?.num}❩ · right-click to delete`}
            {tool === 'arrow'  && (p1 ? 'Click end point' : 'Click start point')}
            {!tool && 'Drag ◆ to bend · drag ● endpoints to reposition · right-click to delete'}
          </span>
        </div>
      )}
      <svg ref={svgRef} className="annot-svg"
        style={{ pointerEvents: active ? 'all' : 'none', cursor: tool ? 'crosshair' : 'default', visibility: (active || visible) ? 'visible' : 'hidden' }}
        onClick={handleBgClick}
        onMouseMove={active ? handleMouseMove : undefined}
        onMouseUp={active ? handleMouseUp : undefined}
        onMouseLeave={active ? handleMouseUp : undefined}
      >
        <defs>
          <marker id="annot-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#f97316" />
          </marker>
        </defs>

        {/* Saved arrows — Bézier paths */}
        {ann.arrows.map(a => (
          <g key={a.id} className="annot-arrow-hit">
            {/* Wide transparent hit area */}
            <path d={bezierD(a)} stroke="transparent" strokeWidth={10} fill="none"
              style={{ cursor: 'pointer' }}
              onContextMenu={e => { e.preventDefault(); deleteArrow(a.id); }} />
            {/* Visible curve */}
            <path d={bezierD(a)} stroke="#f97316" strokeWidth={2.5} fill="none"
              markerEnd="url(#annot-arrow)" style={{ pointerEvents: 'none' }} />
            {/* Handles — only visible in annotation mode */}
            {active && (
              <>
                {/* Bend handle — drag to reshape curve */}
                <g className="annot-bend-handle"
                  style={{ cursor: 'grab' }}
                  onMouseDown={e => {
                    e.stopPropagation();
                    const pt = svgPt(e);
                    const cx = a.cx ?? (a.x1 + a.x2) / 2;
                    const cy = a.cy ?? (a.y1 + a.y2) / 2;
                    setDrag({ type: 'bend', id: a.id, ox: cx - pt.x, oy: cy - pt.y });
                  }}
                >
                  <line x1={a.x1} y1={a.y1} x2={a.cx ?? (a.x1+a.x2)/2} y2={a.cy ?? (a.y1+a.y2)/2} stroke="#334155" strokeWidth={1} strokeDasharray="4 3" style={{ pointerEvents: 'none' }} />
                  <line x1={a.x2} y1={a.y2} x2={a.cx ?? (a.x1+a.x2)/2} y2={a.cy ?? (a.y1+a.y2)/2} stroke="#334155" strokeWidth={1} strokeDasharray="4 3" style={{ pointerEvents: 'none' }} />
                  <rect
                    x={(a.cx ?? (a.x1+a.x2)/2) - 6} y={(a.cy ?? (a.y1+a.y2)/2) - 6} width={12} height={12}
                    fill="#1e293b" stroke="#f97316" strokeWidth={1.5}
                    transform={`rotate(45 ${a.cx ?? (a.x1+a.x2)/2} ${a.cy ?? (a.y1+a.y2)/2})`}
                  />
                </g>
                {/* Start-point handle */}
                <circle cx={a.x1} cy={a.y1} r={6}
                  fill="#1e293b" stroke="#38bdf8" strokeWidth={2}
                  style={{ cursor: 'move', pointerEvents: 'all' }}
                  onMouseDown={e => { e.stopPropagation(); const pt = svgPt(e); setDrag({ type: 'start', id: a.id, ox: a.x1 - pt.x, oy: a.y1 - pt.y }); }}
                />
                {/* End-point handle */}
                <circle cx={a.x2} cy={a.y2} r={6}
                  fill="#1e293b" stroke="#38bdf8" strokeWidth={2}
                  style={{ cursor: 'move', pointerEvents: 'all' }}
                  onMouseDown={e => { e.stopPropagation(); const pt = svgPt(e); setDrag({ type: 'end', id: a.id, ox: a.x2 - pt.x, oy: a.y2 - pt.y }); }}
                />
              </>
            )}
          </g>
        ))}

        {/* Preview while placing second point */}
        {preview && (
          <line x1={preview.x1} y1={preview.y1} x2={preview.x2} y2={preview.y2}
            stroke="#f97316" strokeWidth={2} strokeDasharray="6 3"
            markerEnd="url(#annot-arrow)" style={{ pointerEvents: 'none' }} />
        )}

        {/* Snap guide lines — shown while dragging near alignment */}
        {snapGuides.x != null && (
          <line x1={snapGuides.x} y1={0} x2={snapGuides.x} y2={9999}
            stroke="#39ff14" strokeWidth={1} strokeDasharray="5 4" opacity={0.55}
            style={{ pointerEvents: 'none' }} />
        )}
        {snapGuides.y != null && (
          <line x1={0} y1={snapGuides.y} x2={9999} y2={snapGuides.y}
            stroke="#39ff14" strokeWidth={1} strokeDasharray="5 4" opacity={0.55}
            style={{ pointerEvents: 'none' }} />
        )}

        {/* Reference bullets — dashed, smaller, same number as linked primary */}
        {(ann.refs || []).map(r => {
          const primary = ann.bullets.find(b => b.id === r.refBulletId);
          if (!primary) return null; // orphaned — primary was deleted
          const RW = 56, RH = 36;
          return (
            <g key={r.id} className="annot-bullet" style={{ pointerEvents: 'all' }}
              onContextMenu={e => { e.preventDefault(); if (active) deleteRef(r.id); }}>
              <rect
                x={r.x - RW/2} y={r.y - RH/2} width={RW} height={RH} rx={8}
                fill="#071a00" stroke="#39ff14" strokeWidth={1.5} strokeDasharray="5 3"
                style={{ cursor: active ? 'move' : 'default' }}
                onMouseDown={active ? (e => {
                  e.stopPropagation();
                  const pt = svgPt(e);
                  setDrag({ type: 'ref', id: r.id, ox: r.x - pt.x, oy: r.y - pt.y });
                }) : undefined}
              />
              <text x={r.x} y={r.y} textAnchor="middle" dominantBaseline="central"
                fill="#39ff14" fontSize={20} fontWeight={800} opacity={0.85}
                style={{ userSelect: 'none', pointerEvents: 'none' }}>
                {primary.num}
              </text>
            </g>
          );
        })}

        {/* Bullets */}
        {ann.bullets.map(b => {
          const PW = 56, PH = 36;                  // pill width / height (doubled count-pill)
          const labelX    = b.x + PW / 2 + 10;
          const label     = b.text || "";
          const charW     = 7.5;
          const boxW      = Math.max(label.length * charW + 14, 0);
          const isEditing = active && editingId === b.id;
          return (
            <g key={b.id} className="annot-bullet"
              style={{ pointerEvents: 'all' }}
              onContextMenu={e => { e.preventDefault(); if (active) deleteBullet(b.id); }}
            >
              {/* Text label background */}
              {label && !isEditing && (
                <rect x={labelX} y={b.y - 16} width={boxW} height={32}
                  rx={5} fill="#0f172a" opacity={0.85} style={{ pointerEvents: 'none' }} />
              )}
              {/* Text label */}
              {label && !isEditing && (
                <text x={labelX + 8} y={b.y} dominantBaseline="central"
                  fill="#e2e8f0" fontSize={19} fontWeight={600}
                  style={{ userSelect: 'none', pointerEvents: 'none' }}>
                  {label}
                </text>
              )}
              {/* Inline editor */}
              {isEditing && (
                <foreignObject x={labelX} y={b.y - 14} width={240} height={28}>
                  <input
                    type="text"
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitEdit(b.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    onBlur={() => commitEdit(b.id)}
                    autoFocus
                    placeholder="Type talking point…"
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      background: '#1e293b', border: '1px solid #39ff14',
                      color: '#e2e8f0', fontSize: 13, padding: '3px 8px',
                      borderRadius: 5, outline: 'none',
                    }}
                  />
                </foreignObject>
              )}
              {/* Pill badge — drag to move, double-click to edit text */}
              <rect
                x={b.x - PW / 2} y={b.y - PH / 2} width={PW} height={PH} rx={8}
                fill="#071a00" stroke="#39ff14" strokeWidth={1.5}
                style={{ cursor: active ? (isEditing ? 'default' : 'move') : 'default' }}
                onMouseDown={active && !isEditing ? (e => {
                  e.stopPropagation();
                  const pt = svgPt(e);
                  setDrag({ type: 'bullet', id: b.id, ox: b.x - pt.x, oy: b.y - pt.y });
                }) : undefined}
                onDoubleClick={active ? (e => {
                  e.stopPropagation();
                  setEditingId(b.id);
                  setEditText(b.text || "");
                }) : undefined}
              />
              <text x={b.x} y={b.y} textAnchor="middle" dominantBaseline="central"
                fill="#39ff14" fontSize={20} fontWeight={800}
                style={{ userSelect: 'none', pointerEvents: 'none' }}>
                {b.num}
              </text>
            </g>
          );
        })}
      </svg>
    </>
  );
}

// ─── Sparkline ────────────────────────────────────────────────────────────────

function Sparkline({ data, color = "#a9d6e5", height = 36 }) {
  if (!data || data.length < 2) return null;
  const vals  = data.map(d => d.count);
  const min   = Math.min(...vals);
  const max   = Math.max(...vals);
  const range = max - min || 1;
  const W = 100; const H = 36; const pad = 3;
  const pts = vals.map((v, i) => ({
    x: pad + (i / (vals.length - 1)) * (W - pad * 2),
    y: H - pad - ((v - min) / range) * (H - pad * 2),
  }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const area = `${line} L ${pts[pts.length-1].x} ${H} L ${pts[0].x} ${H} Z`;
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height}
      preserveAspectRatio="none" style={{ display:"block", overflow:"hidden" }}>
      <path d={area} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5}
        strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last.x} cy={last.y} r={2.5} fill={color} />
    </svg>
  );
}

// ─── ExecSummary ──────────────────────────────────────────────────────────────

function ExecSummary({ rows, columns, fileName, onReset, onSwitchView, dateFrom, dateTo, setDateFrom, setDateTo }) {
  const [fullscreenId,   setFullscreenId]   = useState(null);
  const [annotating,   setAnnotating]   = useState(false);
  const [annotTool,    setAnnotTool]    = useState(null);
  const [annotVisible, setAnnotVisible] = useState(false);
  const [hoveredTenant,   setHoveredTenant]   = useState(null); // { name, x, y }
  const [hoveredSev,      setHoveredSev]      = useState(null); // { sevLabel, x, y }
  const [hoveredSubgroup, setHoveredSubgroup] = useState(null); // { pgId, subLabel, titles, x, y }
  const [sevClickPanel,   setSevClickPanel]   = useState(null); // { title, rows, x, y }
  const [panelSearch,     setPanelSearch]     = useState("");

  const pgCardRefs      = useRef({});   // keyed by pg.id
  const topCustomerRef   = useRef(null); // normal panel
  const topCustomerFsRef = useRef(null); // fullscreen panel

  const toggleFullscreen = (id) => setFullscreenId(prev => prev === id ? null : id);

  const saveCardImage = async (cardEl, cardTitle) => {
    if (!cardEl) return;
    const { default: html2canvas } = await import("html2canvas");
    const canvas = await html2canvas(cardEl, {
      backgroundColor: "#0f172a", scale: 2, useCORS: true, logging: false,
    });
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `exec-${(cardTitle || "chart").toLowerCase().replace(/[^a-z0-9]+/g,"-")}-${new Date().toISOString().slice(0,10)}.png`;
    a.click();
  };

  // Column detection
  const dateCol  = columns.find(c => /created/i.test(c) && /date/i.test(c)) || columns.find(c => /date/i.test(c));
  const sevCol   = columns.find(c => /severity/i.test(c));
  const agCol    = columns.find(c => /assignment.?group/i.test(c) || /^ag$/i.test(c));
  const tenantCol= columns.find(c => /tenant/i.test(c));
  const titleCol = columns.find(c => /^title$/i.test(c));
  const stateCol = columns.find(c => /^state/i.test(c));
  const wuCol    = columns.find(c => /^wu$/i.test(c) || /work.?unit/i.test(c));


  const fromTs = dateFrom ? new Date(dateFrom).getTime() : null;
  const toTs   = dateTo   ? new Date(dateTo + "T23:59:59").getTime() : null;

  const filtered = useMemo(() => {
    const knownSevs = new Set(Object.values(SEV_MAP)); // "Sev 1" … "Sev 4"
    return rows.filter(r => {
      // Exclude unknown severity
      if (sevCol) {
        const label = normSevLabel(r[sevCol]);
        if (!label || !knownSevs.has(label)) return false;
      }
      // Date range
      if (dateCol && (fromTs || toTs)) {
        const t = new Date(r[dateCol]).getTime();
        if (!isNaN(t)) {
          if (fromTs && t < fromTs) return false;
          if (toTs   && t > toTs)   return false;
        }
      }
      return true;
    });
  }, [rows, sevCol, dateCol, fromTs, toTs]);

  const total = filtered.length;

  // Severity breakdown helper for a row set
  const buildSevBreak = (rowSet) => {
    const s = {};
    if (!sevCol) return s;
    for (const r of rowSet) {
      const lbl = normSevLabel(r[sevCol]);
      if (lbl) s[lbl] = (s[lbl] || 0) + 1;
    }
    return s;
  };

  // C4 = WUs where AG contains BEST1 or TRUST3; pct = C4 count / (total - automation)
  const c4Stats = useMemo(() => {
    if (!agCol) return { count: 0, pct: 0 };
    const c4Count = filtered.filter(r => /BEST1|TRUST3/i.test(r[agCol] || "")).length;
    const nonAuto = filtered.filter(r => !/automation/i.test(r[agCol] || "")).length;
    return { count: c4Count, pct: nonAuto ? Math.round((c4Count / nonAuto) * 100) : 0 };
  }, [filtered, agCol]);

  // Total sev breakdown
  const totalSevBreak = useMemo(() => buildSevBreak(filtered), [filtered, sevCol]);

  // Automation rows
  const autoStats = useMemo(() => {
    if (!agCol) return { count: 0, pct: 0, sevBreak: {} };
    const autoRows = filtered.filter(r => /automation/i.test(r[agCol] || ""));
    // Compute sev breakdown inline — only automation rows, no closure dependency
    const sevBreak = {};
    if (sevCol) {
      for (const r of autoRows) {
        const lbl = normSevLabel(r[sevCol]);
        if (lbl) sevBreak[lbl] = (sevBreak[lbl] || 0) + 1;
      }
    }
    return {
      count: autoRows.length,
      pct:   total ? Math.round((autoRows.length / total) * 100) : 0,
      sevBreak,
    };
  }, [filtered, agCol, sevCol, total]);

  // ── Prior-period KPI comparison ─────────────────────────────────────────────

  // All timestamps from raw rows (for "no date filter" baseline)
  const allDateVals = useMemo(() =>
    dateCol ? rows.map(r => +new Date(r[dateCol])).filter(n => !isNaN(n)) : [],
  [rows, dateCol]);

  // Prior window = same duration, shifted back immediately before current window
  const execPriorBounds = useMemo(() => {
    if (!dateCol) return null;
    let curFrom, curTo;
    if (fromTs && toTs) {
      curFrom = fromTs; curTo = toTs;
    } else if (allDateVals.length) {
      curFrom = allDateVals.reduce((a, b) => Math.min(a, b));
      curTo   = allDateVals.reduce((a, b) => Math.max(a, b));
    } else return null;
    const duration = curTo - curFrom;
    if (duration <= 0) return null;
    const priorTo   = curFrom - 1;
    const priorFrom = priorTo - duration;
    const fmt = ts => new Date(ts).toLocaleDateString("en-US", { month:"short", day:"numeric", year:"2-digit" });
    return { priorFrom, priorTo, label: `${fmt(priorFrom)} – ${fmt(priorTo)}` };
  }, [dateCol, fromTs, toTs, allDateVals]);

  // Rows matching the prior window (same sev exclusion, no other filters)
  const priorFiltered = useMemo(() => {
    if (!execPriorBounds || !dateCol) return [];
    const { priorFrom, priorTo } = execPriorBounds;
    const knownSevs = new Set(Object.values(SEV_MAP));
    return rows.filter(r => {
      if (sevCol) {
        const lbl = normSevLabel(r[sevCol]);
        if (!lbl || !knownSevs.has(lbl)) return false;
      }
      const t = +new Date(r[dateCol]);
      if (isNaN(t) || t < priorFrom || t > priorTo) return false;
      return true;
    });
  }, [rows, execPriorBounds, dateCol, sevCol]);

  const priorTotal = priorFiltered.length;

  const priorC4Stats = useMemo(() => {
    if (!agCol || !priorFiltered.length) return null;
    const c4Count = priorFiltered.filter(r => /BEST1|TRUST3/i.test(r[agCol] || "")).length;
    const nonAuto = priorFiltered.filter(r => !/automation/i.test(r[agCol] || "")).length;
    return { count: c4Count, pct: nonAuto ? Math.round((c4Count / nonAuto) * 100) : 0 };
  }, [priorFiltered, agCol]);

  const priorAutoStats = useMemo(() => {
    if (!agCol || !priorFiltered.length) return null;
    const autoRows = priorFiltered.filter(r => /automation/i.test(r[agCol] || ""));
    return {
      count: autoRows.length,
      pct:   priorTotal ? Math.round((autoRows.length / priorTotal) * 100) : 0,
    };
  }, [priorFiltered, agCol, priorTotal]);

  // Trend badge: shows ↑↓ delta vs prior. invert=true means up is good (e.g. automation %)
  const TrendBadge = ({ current, prior, invert = false }) => {
    if (prior == null || prior === 0 || current == null) return null;
    const delta = current - prior;
    if (delta === 0) return <span className="cv-kpi-trend-badge cv-kpi-trend-badge--flat" title={`vs prior period (${execPriorBounds?.label})`}>— 0%</span>;
    const pct  = Math.abs((delta / prior) * 100).toFixed(1);
    const up   = delta > 0;
    const good = invert ? up : !up;
    return (
      <span className={`cv-kpi-trend-badge ${good ? "cv-kpi-trend-badge--good" : "cv-kpi-trend-badge--bad"}`}
        title={`vs prior period (${execPriorBounds?.label})`}>
        {up ? "↑" : "↓"} {up ? "+" : "−"}{pct}%
      </span>
    );
  };

  // Top 3 customers
  const topCustomers = useMemo(() => {
    if (!tenantCol) return [];
    const counts = {};
    for (const r of filtered) {
      const t = (r[tenantCol] || "").trim();
      if (t) counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([name, count]) => ({ name, count }));
  }, [filtered, tenantCol]);

  // Title breakdown per tenant (for hover tooltip)
  const tenantTitleMap = useMemo(() => {
    if (!tenantCol || !titleCol || !topCustomers.length) return {};
    const tenantNames = new Set(topCustomers.map(c => c.name));
    const map = {};
    for (const r of filtered) {
      const tenant = (r[tenantCol] || "").trim();
      if (!tenantNames.has(tenant)) continue;
      const title = (r[titleCol] || "(no title)").trim();
      if (!map[tenant]) map[tenant] = {};
      map[tenant][title] = (map[tenant][title] || 0) + 1;
    }
    // Convert to sorted arrays with pct
    const result = {};
    for (const [tenant, titles] of Object.entries(map)) {
      const tenantTotal = topCustomers.find(c => c.name === tenant)?.count || 1;
      result[tenant] = Object.entries(titles)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([title, count]) => ({
          title,
          count,
          pct: ((count / tenantTotal) * 100).toFixed(1),
        }));
    }
    return result;
  }, [filtered, tenantCol, titleCol, topCustomers]);

  // Top 10 customers with full title breakdowns — used by fullscreen Top Customer WUs panel
  const topCustomersFull = useMemo(() => {
    if (!tenantCol) return [];
    const counts = {};
    for (const r of filtered) {
      const t = (r[tenantCol] || "").trim();
      if (t) counts[t] = (counts[t] || 0) + 1;
    }
    const top10 = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, count]) => ({ name, count }));
    if (!titleCol) return top10.map(c => ({ ...c, autoTitles: [], otherTitles: [] }));
    const tenantNames = new Set(top10.map(c => c.name));
    const autoMap = {}, otherMap = {};
    for (const r of filtered) {
      const tenant = (r[tenantCol] || "").trim();
      if (!tenantNames.has(tenant)) continue;
      const title = (r[titleCol] || "(no title)").trim();
      const ag = agCol ? (r[agCol] || "").trim() : "";
      const map = /automation/i.test(ag) ? autoMap : otherMap;
      if (!map[tenant]) map[tenant] = {};
      map[tenant][title] = (map[tenant][title] || 0) + 1;
    }
    const toRows = (map, name) => {
      const entries = Object.entries(map[name] || {}).sort((a, b) => b[1] - a[1]);
      const grpTotal = entries.reduce((s, [, c]) => s + c, 0);
      return entries.map(([title, c]) => ({
        title, count: c,
        pct: grpTotal ? ((c / grpTotal) * 100).toFixed(1) : "0.0",
      }));
    };
    return top10.map(({ name, count }) => ({
      name, count,
      autoTitles:  toRows(autoMap,  name),
      otherTitles: toRows(otherMap, name),
    }));
  }, [filtered, tenantCol, titleCol, agCol]);

  // Top 10 titles per severity (global, for hover tooltip)
  const sevTitleMap = useMemo(() => {
    if (!sevCol || !titleCol) return {};
    const map = {};
    for (const r of filtered) {
      const lbl = normSevLabel(r[sevCol]);
      if (!lbl) continue;
      const title = (r[titleCol] || "(no title)").trim();
      if (!map[lbl]) map[lbl] = {};
      map[lbl][title] = (map[lbl][title] || 0) + 1;
    }
    const result = {};
    for (const [sev, titles] of Object.entries(map)) {
      const sevTotal = Object.values(titles).reduce((a, b) => a + b, 0);
      result[sev] = Object.entries(titles)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([title, count]) => ({
          title, count,
          pct: ((count / sevTotal) * 100).toFixed(1),
        }));
    }
    return result;
  }, [filtered, sevCol, titleCol]);

  // Top 10 titles per severity — automation rows only (for Total Automated hover)
  const autoSevTitleMap = useMemo(() => {
    if (!sevCol || !titleCol || !agCol) return {};
    const map = {};
    for (const r of filtered) {
      if (!/automation/i.test(r[agCol] || "")) continue;
      const lbl = normSevLabel(r[sevCol]);
      if (!lbl) continue;
      const title = (r[titleCol] || "(no title)").trim();
      if (!map[lbl]) map[lbl] = {};
      map[lbl][title] = (map[lbl][title] || 0) + 1;
    }
    const result = {};
    for (const [sev, titles] of Object.entries(map)) {
      const sevTotal = Object.values(titles).reduce((a, b) => a + b, 0);
      result[sev] = Object.entries(titles)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([title, count]) => ({
          title, count,
          pct: ((count / sevTotal) * 100).toFixed(1),
        }));
    }
    return result;
  }, [filtered, sevCol, titleCol, agCol]);

  // ── Tenant counts per severity — for bar chart in hover tooltip ──────────
  const mkSevTenantMap = (rowSet) => {
    if (!sevCol || !tenantCol) return {};
    const map = {};
    for (const r of rowSet) {
      const lbl    = normSevLabel(r[sevCol]);
      if (!lbl) continue;
      const tenant = (r[tenantCol] || "(no tenant)").trim();
      if (!map[lbl]) map[lbl] = {};
      map[lbl][tenant] = (map[lbl][tenant] || 0) + 1;
    }
    const result = {};
    for (const [sev, tenants] of Object.entries(map)) {
      const sevTotal = Object.values(tenants).reduce((a, b) => a + b, 0);
      result[sev] = Object.entries(tenants)
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([tenant, count]) => ({ tenant, count, pct: ((count / sevTotal) * 100).toFixed(1) }));
    }
    return result;
  };
  const sevTenantMap = useMemo(() => mkSevTenantMap(filtered),
    [filtered, sevCol, tenantCol]);
  const autoSevTenantMap = useMemo(() => {
    if (!agCol) return {};
    return mkSevTenantMap(filtered.filter(r => /automation/i.test(r[agCol] || "")));
  }, [filtered, agCol, sevCol, tenantCol]);
  const pgSevTenantMap = useMemo(() => {
    if (!agCol || !sevCol || !tenantCol) return {};
    const map = {};
    for (const r of filtered) {
      const ag   = (r[agCol] || "").trim();
      const prod = EXEC_PRODUCT_DEFS.find(p => p.regex.test(ag));
      if (!prod) continue;
      const lbl    = normSevLabel(r[sevCol]);
      if (!lbl) continue;
      const tenant = (r[tenantCol] || "(no tenant)").trim();
      if (!map[prod.id])         map[prod.id] = {};
      if (!map[prod.id][lbl])    map[prod.id][lbl] = {};
      map[prod.id][lbl][tenant]  = (map[prod.id][lbl][tenant] || 0) + 1;
    }
    const result = {};
    for (const [pgId, sevMap] of Object.entries(map)) {
      result[pgId] = {};
      for (const [sev, tenants] of Object.entries(sevMap)) {
        const sevTotal = Object.values(tenants).reduce((a, b) => a + b, 0);
        result[pgId][sev] = Object.entries(tenants)
          .sort((a, b) => b[1] - a[1]).slice(0, 8)
          .map(([tenant, count]) => ({ tenant, count, pct: ((count / sevTotal) * 100).toFixed(1) }));
      }
    }
    return result;
  }, [filtered, agCol, sevCol, tenantCol]);

  // Per-sev title breakdown WITH wuNum + isAuto — for click-to-detail on sev boxes
  const mkSevDetailMap = (rowSet) => {
    if (!sevCol || !titleCol) return {};
    const map = {};
    for (const r of rowSet) {
      const lbl = normSevLabel(r[sevCol]);
      if (!lbl) continue;
      const title  = (r[titleCol]  || "(no title)").trim();
      const tenant = tenantCol ? (r[tenantCol] || "").trim() : "";
      const key = `${title}|||${tenant}`;
      if (!map[lbl]) map[lbl] = {};
      if (!map[lbl][key]) map[lbl][key] = { count: 0, wuNum: null, title, tenant, autoCount: 0 };
      map[lbl][key].count++;
      if (agCol && /automation/i.test(r[agCol] || "")) map[lbl][key].autoCount++;
      if (wuCol) {
        const n = Number(r[wuCol]);
        if (!isNaN(n) && n > (map[lbl][key].wuNum ?? -Infinity))
          map[lbl][key].wuNum = n;
      }
    }
    const result = {};
    for (const [sev, entries] of Object.entries(map)) {
      const sevTotal = Object.values(entries).reduce((s, v) => s + v.count, 0);
      result[sev] = Object.values(entries)
        .sort((a, b) => b.count - a.count)
        .slice(0, 25)
        .map(({ title, tenant, count, autoCount, wuNum }) => ({
          label: title, tenant, value: count, wuNum,
          isAuto: autoCount > 0,
          pct: ((count / sevTotal) * 100).toFixed(1),
        }));
    }
    return result;
  };
  const sevDetailMap = useMemo(() =>
    mkSevDetailMap(filtered),
  [filtered, sevCol, titleCol, tenantCol, wuCol]);

  const autoSevDetailMap = useMemo(() => {
    if (!agCol) return {};
    return mkSevDetailMap(filtered.filter(r => /automation/i.test(r[agCol] || "")));
  }, [filtered, agCol, sevCol, titleCol, tenantCol, wuCol]);

  // Per-PG per-sev detail map WITH tenant — for click-to-detail on product group sev boxes
  const pgSevDetailMap = useMemo(() => {
    if (!agCol || !sevCol || !titleCol) return {};
    const map = {}; // pgId → sev → key → {count, wuNum, title, tenant}
    for (const r of filtered) {
      const ag   = (r[agCol] || "").trim();
      const prod = EXEC_PRODUCT_DEFS.find(p => p.regex.test(ag));
      if (!prod) continue;
      const lbl = normSevLabel(r[sevCol]);
      if (!lbl) continue;
      const title  = (r[titleCol]  || "(no title)").trim();
      const tenant = tenantCol ? (r[tenantCol] || "").trim() : "";
      const key = `${title}|||${tenant}`;
      if (!map[prod.id])         map[prod.id] = {};
      if (!map[prod.id][lbl])    map[prod.id][lbl] = {};
      if (!map[prod.id][lbl][key])
        map[prod.id][lbl][key] = { count: 0, wuNum: null, title, tenant, autoCount: 0 };
      map[prod.id][lbl][key].count++;
      if (/automation/i.test(ag)) map[prod.id][lbl][key].autoCount++;
      if (wuCol) {
        const n = Number(r[wuCol]);
        if (!isNaN(n) && n > (map[prod.id][lbl][key].wuNum ?? -Infinity))
          map[prod.id][lbl][key].wuNum = n;
      }
    }
    const result = {};
    for (const [pgId, sevMap] of Object.entries(map)) {
      result[pgId] = {};
      for (const [sev, entries] of Object.entries(sevMap)) {
        const sevTotal = Object.values(entries).reduce((s, v) => s + v.count, 0);
        result[pgId][sev] = Object.values(entries)
          .sort((a, b) => b.count - a.count)
          .slice(0, 25)
          .map(({ title, tenant, count, autoCount, wuNum }) => ({
            label: title, tenant, value: count, wuNum,
            isAuto: autoCount > 0,
            pct: ((count / sevTotal) * 100).toFixed(1),
          }));
      }
    }
    return result;
  }, [filtered, agCol, sevCol, titleCol, tenantCol, wuCol]);

  // Accent colors for subgroup tooltip headers
  const SUBGROUP_COLOR = { AUTO: "#22c55e", BEST1: "#38bdf8", TRUST3: "#a78bfa", PG: "#94a3b8" };

  // Product group data — each group: total, c4Pct, workloadPct, sevs, AUTO/BEST1/TRUST3/PG + subTitles
  const productGroupData = useMemo(() => {
    if (!agCol) return [];
    const buckets = {};
    EXEC_PRODUCT_DEFS.forEach(p => {
      buckets[p.id] = {
        total:0, sevs:{}, sevTitles:{}, sevTitlesByGroup:{},
        AUTO:0, BEST1:0, TRUST3:0, PG:0,
        subTitles: { AUTO:{}, BEST1:{}, TRUST3:{}, PG:{} },
      };
    });
    for (const r of filtered) {
      const ag = (r[agCol] || "").trim();
      const prod = EXEC_PRODUCT_DEFS.find(p => p.regex.test(ag));
      if (!prod) continue;
      const b = buckets[prod.id];
      b.total++;
      if (sevCol) {
        const lbl = normSevLabel(r[sevCol]);
        if (lbl) {
          b.sevs[lbl] = (b.sevs[lbl] || 0) + 1;
          if (titleCol) {
            const t = (r[titleCol] || "(no title)").trim();
            if (!b.sevTitles[lbl]) b.sevTitles[lbl] = {};
            b.sevTitles[lbl][t] = (b.sevTitles[lbl][t] || 0) + 1;
            // Track auto vs other separately (with example WU)
            const grp = /automation/i.test(ag) ? "auto" : "other";
            if (!b.sevTitlesByGroup[lbl]) b.sevTitlesByGroup[lbl] = { auto: {}, other: {} };
            if (!b.sevTitlesByGroup[lbl][grp][t]) b.sevTitlesByGroup[lbl][grp][t] = { count: 0, wuNum: null };
            b.sevTitlesByGroup[lbl][grp][t].count++;
            if (wuCol) {
              const n = Number(r[wuCol]);
              if (!isNaN(n) && n > (b.sevTitlesByGroup[lbl][grp][t].wuNum ?? -Infinity))
                b.sevTitlesByGroup[lbl][grp][t].wuNum = n;
            }
          }
        }
      }
      const title = titleCol ? (r[titleCol] || "(no title)").trim() : null;
      let subKey;
      if (/automation/i.test(ag))  { b.AUTO++;   subKey = "AUTO"; }
      else if (/BEST1/i.test(ag))  { b.BEST1++;  subKey = "BEST1"; }
      else if (/TRUST3/i.test(ag)) { b.TRUST3++; subKey = "TRUST3"; }
      else                          { b.PG++;     subKey = "PG"; }
      if (title && subKey) {
        b.subTitles[subKey][title] = (b.subTitles[subKey][title] || 0) + 1;
      }
    }
    const toTopTitles = (titleMap, subTotal) =>
      Object.entries(titleMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([title, count]) => ({
          title, count,
          pct: subTotal ? ((count / subTotal) * 100).toFixed(1) : "0.0",
        }));
    return EXEC_PRODUCT_DEFS.map(p => {
      const b = buckets[p.id];
      // C4 Resolution %: (TRUST3 + BEST1) / (PG + TRUST3 + BEST1) — AUTO excluded
      const c4Numerator   = b.BEST1 + b.TRUST3;
      const c4Denominator = b.PG    + b.BEST1 + b.TRUST3;
      return {
        ...p,
        total: b.total,
        c4Pct: c4Denominator ? Math.round((c4Numerator / c4Denominator) * 100) : 0,
        workloadPct: total ? Math.round((b.total / total) * 100) : 0,
        sevs: b.sevs,
        sevTitles: Object.fromEntries(
          Object.entries(b.sevTitles).map(([sev, titles]) => [
            sev,
            toTopTitles(titles, b.sevs[sev] || 0),
          ])
        ),
        sevTitlesAll: Object.fromEntries(
          ["Sev 1", "Sev 2", "Sev 3"]
            .filter(sev => b.sevTitlesByGroup[sev])
            .map(sev => {
              const grps = b.sevTitlesByGroup[sev];
              const toRows = (map) => {
                const entries = Object.entries(map).sort((a, c) => c[1].count - a[1].count);
                const grpTotal = entries.reduce((s, [, v]) => s + v.count, 0);
                return entries.map(([title, { count, wuNum }]) => ({
                  title, count, wuNum,
                  pct: grpTotal ? ((count / grpTotal) * 100).toFixed(1) : "0.0",
                }));
              };
              const autoRows  = toRows(grps.auto  || {});
              const otherRows = toRows(grps.other || {});
              return [sev, { auto: autoRows, other: otherRows }];
            })
        ),
        AUTO: b.AUTO, BEST1: b.BEST1, TRUST3: b.TRUST3, PG: b.PG,
        subTitles: {
          AUTO:   toTopTitles(b.subTitles.AUTO,   b.AUTO),
          BEST1:  toTopTitles(b.subTitles.BEST1,  b.BEST1),
          TRUST3: toTopTitles(b.subTitles.TRUST3, b.TRUST3),
          PG:     toTopTitles(b.subTitles.PG,     b.PG),
        },
      };
    });
  }, [filtered, agCol, sevCol, stateCol, titleCol, wuCol, total]);

  // Per-PG sparkline time series
  const pgSparkData = useMemo(() => {
    if (!dateCol || !agCol) return {};
    const ts = filtered.map(r => +new Date(r[dateCol])).filter(n => !isNaN(n));
    if (ts.length < 2) return {};
    const span   = ts.reduce((a, b) => Math.max(a, b)) - ts.reduce((a, b) => Math.min(a, b));
    const days   = span / 86400000;
    const period = days > 180 ? "month" : days > 60 ? "week" : "day";
    const maps   = {};
    EXEC_PRODUCT_DEFS.forEach(p => { maps[p.id] = {}; });
    for (const r of filtered) {
      const ag   = (r[agCol] || "").trim();
      const prod = EXEC_PRODUCT_DEFS.find(p => p.regex.test(ag));
      if (!prod) continue;
      const b = getBucket(r[dateCol], period);
      if (!b) continue;
      maps[prod.id][b] = (maps[prod.id][b] || 0) + 1;
    }
    return Object.fromEntries(
      EXEC_PRODUCT_DEFS.map(p => [
        p.id,
        Object.entries(maps[p.id])
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, count]) => ({ count })),
      ])
    );
  }, [filtered, dateCol, agCol]);

  // Sev badge row helper
  const hexToRgba = (hex, alpha) => {
    const h = hex.replace('#','');
    const r = parseInt(h.slice(0,2),16);
    const g = parseInt(h.slice(2,4),16);
    const b = parseInt(h.slice(4,6),16);
    return `rgba(${r},${g},${b},${alpha})`;
  };
  const SevRow = ({ sevs, pgId, onHover, onLeave, onClickSev }) => (
    <div className="cv-pg-sev-row">
      {["Sev 1","Sev 2","Sev 3","Sev 4"].map(s => {
        const color = SEV_COLOR_BY_LABEL[s] || "#374151";
        const hasData = (sevs[s] || 0) > 0;
        return (
          <div key={s} className="cv-pg-sev-box"
            style={{
              background: hexToRgba(color, 0.15),
              border: `1.5px solid ${color}`,
              cursor: (onHover || (onClickSev && hasData)) ? "pointer" : undefined,
            }}
            onMouseEnter={onHover ? (e => {
              onHover(s, e.currentTarget.getBoundingClientRect(), pgId);
            }) : undefined}
            onMouseLeave={onLeave}
            onClick={onClickSev && hasData ? (e => {
              e.stopPropagation();
              onClickSev(s, e.currentTarget.getBoundingClientRect(), pgId);
            }) : undefined}>
            <div className="cv-pg-sev-label" style={{ color }}>{s}</div>
            <div className="cv-pg-sev-count" style={{ color }}>{(sevs[s] || 0).toLocaleString()}</div>
          </div>
        );
      })}
    </div>
  );

  const handleSevHover = (sevLabel, anchorRect, pgId) => {
    // 560 = max tooltip width; 580 = generous height to account for titles + tenant bars
    const { x, y } = getTooltipXY(anchorRect, 560, 580);
    setHoveredSev({ sevLabel, pgId: pgId || null, x, y });
  };
  const handleSevLeave = () => setHoveredSev(null);

  const handleSevClick = (sevLabel, anchorRect, pgId) => {
    if (!sevLabel) return;
    let rows = [];
    let panelTitle = sevLabel;
    if (pgId === "__auto__") {
      rows = (autoSevDetailMap[sevLabel] || []);
      panelTitle = `Automation · ${sevLabel}`;
    } else if (pgId) {
      rows = (pgSevDetailMap[pgId]?.[sevLabel] || []);
      panelTitle = `${pgId} · ${sevLabel}`;
    } else {
      rows = (sevDetailMap[sevLabel] || []);
      panelTitle = `All WUs · ${sevLabel}`;
    }
    if (!rows.length) return;
    const { x, y } = getTooltipXY(anchorRect, 360, 480);
    setSevClickPanel({ title: panelTitle, rows, x, y });
    setPanelSearch("");
  };

  // Safety-net: clear stale tooltips when mouse drifts off all hotspots
  useEffect(() => {
    if (!hoveredSev && !hoveredTenant && !hoveredSubgroup) return;
    const onMove = (e) => {
      const el = e.target;
      if (
        !el.closest?.('.cv-pg-sev-box') &&
        !el.closest?.('.cv-pg-customer-row') &&
        !el.closest?.('.cv-pg-subgroup-hotspot') &&
        !el.closest?.('.cv-sev-tooltip') &&
        !el.closest?.('.cv-tenant-tooltip')
      ) {
        setHoveredSev(null);
        setHoveredTenant(null);
        setHoveredSubgroup(null);
      }
    };
    document.addEventListener('mousemove', onMove, { passive: true });
    return () => document.removeEventListener('mousemove', onMove);
  }, [!!hoveredSev, !!hoveredTenant, !!hoveredSubgroup]);

  const dateDisplay = dateFrom || dateTo
    ? <span style={{ color:"#94a3b8", fontSize:13 }}>
        {dateFrom && <><span style={{ color:"#64748b" }}>From: </span><span style={{ color:"#38bdf8" }}>{dateFrom}</span> </>}
        {dateTo   && <><span style={{ color:"#64748b" }}>To: </span><span style={{ color:"#f97316" }}>{dateTo}</span></>}
      </span>
    : null;

  // ── Snapshot HTML generator ───────────────────────────────────────────────
  const generateSnapshotHTML = () => {
    const now    = new Date();
    const ts     = now.toLocaleString("en-US", { month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit" });
    const period = dateFrom || dateTo ? `${dateFrom || "…"} → ${dateTo || "…"}` : "All dates";

    // Inline sparkline SVG
    const sparkSVG = (data, color = "#38bdf8") => {
      if (!data || data.length < 2) return "";
      const vals  = data.map(d => d.count);
      const min   = Math.min(...vals);
      const max   = Math.max(...vals);
      const range = max - min || 1;
      const W = 100, H = 28, pad = 3;
      const pts = vals.map((v, i) => ({
        x: pad + (i / (vals.length - 1)) * (W - pad * 2),
        y: H - pad - ((v - min) / range) * (H - pad * 2),
      }));
      const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
      const area = `${line} L ${pts[pts.length-1].x.toFixed(1)} ${H} L ${pts[0].x.toFixed(1)} ${H} Z`;
      const last = pts[pts.length - 1];
      return `<svg viewBox="0 0 ${W} ${H}" width="100" height="28" style="display:block;overflow:visible">`
        + `<path d="${area}" fill="${color}" opacity="0.15"/>`
        + `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`
        + `<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.5" fill="${color}"/>`
        + `</svg>`;
    };

    // Trend badge helper (plain HTML)
    const badge = (current, prior, invert = false) => {
      if (prior == null || prior === 0 || current == null) return "";
      const delta = current - prior;
      if (delta === 0) return `<span style="background:rgba(100,116,139,0.2);color:#94a3b8;padding:3px 10px;border-radius:10px;font-size:15px;font-weight:700">— 0%</span>`;
      const pct  = Math.abs((delta / prior) * 100).toFixed(1);
      const up   = delta > 0;
      const good = invert ? up : !up;
      const col  = good ? "#22c55e" : "#ef4444";
      const bg   = good ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)";
      return `<span style="background:${bg};color:${col};padding:3px 10px;border-radius:10px;font-size:15px;font-weight:700">${up ? "↑ +" : "↓ −"}${pct}%</span>`;
    };

    const sevColor = lbl => ({ "Sev 1":"#ef4444","Sev 2":"#f97316","Sev 3":"#eab308","Sev 4":"#22c55e" }[lbl] || "#94a3b8");
    const PG_SNAP_COLORS = ["#38bdf8","#a78bfa","#22c55e","#f97316","#ec4899","#eab308"];

    // ── Product group rows ──────────────────────────────────────────────────
    const pgRows = productGroupData.map((pg, idx) => {
      const col = PG_SNAP_COLORS[idx % PG_SNAP_COLORS.length];
      const pills = ["Sev 1","Sev 2","Sev 3","Sev 4"].filter(s => pg.sevs[s]).map(s =>
        `<span style="background:${sevColor(s)}22;color:${sevColor(s)};padding:2px 5px;border-radius:5px;font-size:11px;margin-right:3px">${s}: ${(pg.sevs[s]||0).toLocaleString()}</span>`
      ).join("");
      const spark = sparkSVG(pgSparkData[pg.id] || [], col);
      return `<tr style="border-bottom:1px solid #1e293b">
        <td style="padding:8px 10px;font-weight:800;color:${col}">${pg.label}</td>
        <td style="padding:8px 10px;text-align:center;font-weight:700;font-size:15px">${pg.total.toLocaleString()}</td>
        <td style="padding:8px 10px;text-align:center">${spark}</td>
        <td style="padding:8px 10px">${pills}</td>
        <td style="padding:8px 6px;text-align:center;color:#22c55e;font-size:12px">${pg.AUTO.toLocaleString()}</td>
        <td style="padding:8px 6px;text-align:center;color:#38bdf8;font-size:12px">${pg.BEST1.toLocaleString()}</td>
        <td style="padding:8px 6px;text-align:center;color:#a78bfa;font-size:12px">${pg.TRUST3.toLocaleString()}</td>
        <td style="padding:8px 6px;text-align:center;color:#94a3b8;font-size:12px">${pg.PG.toLocaleString()}</td>
        <td style="padding:8px 10px;text-align:center;font-weight:800;color:#38bdf8">${pg.c4Pct}%</td>
        <td style="padding:8px 10px;text-align:center;color:#64748b;font-size:12px">${pg.workloadPct}%</td>
      </tr>`;
    }).join("");

    // ── Top customers rows ─────────────────────────────────────────────────
    const tcRows = topCustomersFull.map((c, i) => {
      const pct = total ? ((c.count / total) * 100).toFixed(1) : "0.0";
      return `<tr style="border-bottom:1px solid #1e293b">
        <td style="padding:6px 10px;color:#94a3b8;font-size:12px">${i + 1}</td>
        <td style="padding:6px 10px;font-weight:600;color:#f1f5f9">${c.name}</td>
        <td style="padding:6px 10px;text-align:center;font-weight:700;color:#38bdf8">${c.count.toLocaleString()}</td>
        <td style="padding:6px 10px;text-align:center;color:#64748b;font-size:12px">${pct}%</td>
      </tr>`;
    }).join("");

    // ── Sev title breakdowns per PG ────────────────────────────────────────
    const WU_BASE = "https://portal.cloudfitgov.cloudfit.software/workunitsv2?workUnitId=";
    const sevTitleBlocks = productGroupData.map((pg, idx) => {
      const col      = PG_SNAP_COLORS[idx % PG_SNAP_COLORS.length];
      const sevKeys  = ["Sev 1","Sev 2","Sev 3"].filter(s => pg.sevTitlesAll?.[s]);
      if (!sevKeys.length) return "";
      const sevHtml = sevKeys.map(sev => {
        const grps      = pg.sevTitlesAll[sev];
        const autoRows  = (grps.auto  || []).slice(0, 10);
        const otherRows = (grps.other || []).slice(0, 10);
        if (!autoRows.length && !otherRows.length) return "";
        const mkRows = (rows, dotColor) => rows.map(t => {
          const wu = (wuCol && t.wuNum) ? `<a href="${WU_BASE}${t.wuNum}" style="color:#38bdf8;text-decoration:none;font-size:11px">WU#${t.wuNum}</a>` : "";
          return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04)">
            <td style="padding:4px 6px;color:${dotColor};font-size:10px">●</td>
            <td style="padding:4px 8px;color:#e2e8f0;font-size:12px;max-width:340px">${t.title}</td>
            <td style="padding:4px 8px;text-align:center;font-size:12px;font-weight:700;color:#f1f5f9">${t.count}</td>
            <td style="padding:4px 8px;text-align:center;font-size:11px;color:#64748b">${t.pct}%</td>
            <td style="padding:4px 8px">${wu}</td>
          </tr>`;
        }).join("");
        const autoHtml  = autoRows.length  ? `<tr><td colspan="5" style="padding:4px 8px 2px;font-size:10px;font-weight:700;color:#22c55e;text-transform:uppercase;letter-spacing:0.5px">Automation</td></tr>${mkRows(autoRows,"#22c55e")}` : "";
        const otherHtml = otherRows.length ? `<tr><td colspan="5" style="padding:4px 8px 2px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px">Other</td></tr>${mkRows(otherRows,"#94a3b8")}` : "";
        return `<div style="margin-bottom:14px">
          <div style="font-size:12px;font-weight:800;color:${sevColor(sev)};background:${sevColor(sev)}18;padding:4px 10px;border-radius:5px;margin-bottom:4px">${sev}</div>
          <table style="width:100%;border-collapse:collapse">${autoHtml}${otherHtml}</table>
        </div>`;
      }).filter(Boolean).join("");
      if (!sevHtml) return "";
      return `<div style="background:#1e293b;border-radius:10px;padding:14px 16px;border:1px solid #334155;break-inside:avoid;margin-bottom:16px">
        <div style="font-size:14px;font-weight:900;color:${col};margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #334155">${pg.label}</div>
        ${sevHtml}
      </div>`;
    }).filter(Boolean).join("");

    // ── Assemble HTML ───────────────────────────────────────────────────────
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RADAR Signal Snapshot — ${period}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 24px; background:#0f172a; color:#f1f5f9; font-family:system-ui,-apple-system,sans-serif; font-size:14px; line-height:1.5; }
  h2  { font-size:15px; font-weight:800; margin:0 0 14px; padding-bottom:8px; border-bottom:1px solid #1e293b; color:#f1f5f9; }
  a   { text-decoration:none; }
  a:hover { text-decoration:underline; }
  table { border-collapse:collapse; }
  tr:hover > td { background:rgba(255,255,255,0.025); }
  section { margin-bottom:28px; }
</style>
</head>
<body>
<div style="max-width:1100px;margin:0 auto">

  <!-- Header -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;padding-bottom:16px;border-bottom:2px solid #1e293b">
    <div>
      <div style="font-size:24px;font-weight:900;letter-spacing:1px">
        <span style="color:#ef4444">RADAR</span>&nbsp;<span style="color:#f1f5f9">Signal</span>
        <span style="color:#475569;font-size:14px;font-weight:600;margin-left:10px">| Executive Snapshot</span>
      </div>
      <div style="color:#64748b;font-size:13px;margin-top:3px">${fileName}</div>
    </div>
    <div style="text-align:right;font-size:12px;color:#64748b">
      <div style="color:#94a3b8;font-size:13px;font-weight:700">📅 ${period}</div>
      <div style="margin-top:3px">Generated ${ts}</div>
      ${execPriorBounds ? `<div style="margin-top:3px;color:#475569">Prior period: ${execPriorBounds.label}</div>` : ""}
    </div>
  </div>

  <!-- KPI Tiles -->
  <section>
    <div style="display:flex;gap:14px;flex-wrap:wrap">
      <div style="flex:1;min-width:190px;background:#1e293b;border-radius:12px;padding:16px 20px;border:1px solid #334155">
        <div style="font-size:14px;font-weight:700;color:#f1f5f9;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px">Total WU Count</div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px">
          <div style="font-size:30px;font-weight:900;color:#f1f5f9;line-height:1">${total.toLocaleString()}</div>
          ${badge(total, priorTotal || null)}
        </div>
      </div>
      <div style="flex:1;min-width:190px;background:#1e293b;border-radius:12px;padding:16px 20px;border:1px solid #334155">
        <div style="font-size:14px;font-weight:700;color:#f1f5f9;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px">Total Automated</div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px">
          <div style="font-size:30px;font-weight:900;color:#22c55e;line-height:1">${autoStats.count.toLocaleString()}</div>
          ${badge(autoStats.count, priorAutoStats?.count, true)}
        </div>
        <div style="font-size:15px;color:#f1f5f9;margin-top:4px">${autoStats.pct}% of total</div>
      </div>
      <div style="flex:1;min-width:190px;background:#1e293b;border-radius:12px;padding:16px 20px;border:1px solid #334155">
        <div style="font-size:14px;font-weight:700;color:#f1f5f9;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px">C4 WUs Closed</div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px">
          <div style="font-size:30px;font-weight:900;color:#38bdf8;line-height:1">${c4Stats.count.toLocaleString()}</div>
          ${badge(c4Stats.count, priorC4Stats?.count)}
        </div>
      </div>
      <div style="flex:1;min-width:190px;background:#1e293b;border-radius:12px;padding:16px 20px;border:1px solid #334155">
        <div style="font-size:14px;font-weight:700;color:#f1f5f9;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px">C4 Resolution %</div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px">
          <div style="font-size:30px;font-weight:900;color:#a78bfa;line-height:1">${c4Stats.pct}%</div>
          ${badge(c4Stats.pct, priorC4Stats?.pct, true)}
        </div>
      </div>
    </div>
  </section>

  <!-- Product Groups -->
  <section>
    <h2>📦 Product Groups</h2>
    <div style="overflow-x:auto">
      <table style="width:100%;min-width:700px">
        <thead>
          <tr style="font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #1e293b">
            <th style="padding:6px 10px;text-align:left;font-weight:700">Group</th>
            <th style="padding:6px 10px;text-align:center;font-weight:700">Total</th>
            <th style="padding:6px 10px;text-align:center;font-weight:700">Trend</th>
            <th style="padding:6px 10px;text-align:left;font-weight:700">Severity</th>
            <th style="padding:6px 10px;text-align:center;font-weight:700;color:#22c55e">Auto</th>
            <th style="padding:6px 10px;text-align:center;font-weight:700;color:#38bdf8">BEST1</th>
            <th style="padding:6px 10px;text-align:center;font-weight:700;color:#a78bfa">TRUST3</th>
            <th style="padding:6px 10px;text-align:center;font-weight:700;color:#94a3b8">PG</th>
            <th style="padding:6px 10px;text-align:center;font-weight:700">C4%</th>
            <th style="padding:6px 10px;text-align:center;font-weight:700">Wkld%</th>
          </tr>
        </thead>
        <tbody>${pgRows}</tbody>
      </table>
    </div>
  </section>

  ${topCustomersFull.length ? `<!-- Top Customers -->
  <section>
    <h2>🏆 Top Customers</h2>
    <table style="width:100%;max-width:560px">
      <thead>
        <tr style="font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #1e293b">
          <th style="padding:6px 8px;text-align:center;font-weight:700">#</th>
          <th style="padding:6px 10px;text-align:left;font-weight:700">Tenant</th>
          <th style="padding:6px 10px;text-align:center;font-weight:700">WUs</th>
          <th style="padding:6px 10px;text-align:center;font-weight:700">% Total</th>
        </tr>
      </thead>
      <tbody>${tcRows}</tbody>
    </table>
  </section>` : ""}

  ${sevTitleBlocks ? `<!-- Sev Title Breakdown -->
  <section>
    <h2>📋 Top Titles by Severity &amp; Product Group</h2>
    <div style="columns:2;column-gap:20px">${sevTitleBlocks}</div>
  </section>` : ""}

  <!-- Footer -->
  <div style="border-top:1px solid #1e293b;padding-top:12px;color:#334155;font-size:11px;text-align:center;margin-top:8px">
    RADAR Signal · ${ts} · ${fileName} · ${total.toLocaleString()} work units
  </div>

</div>
</body>
</html>`;

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const a    = document.createElement("a");
    a.href     = URL.createObjectURL(blob);
    const safe = (fileName || "snapshot").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
    a.download = `radar-snapshot-${safe}-${new Date().toISOString().slice(0,10)}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="cv-app cv-app--exec">
      {/* Header */}
      <header className="cv-nav">
        <div className="cv-nav-left">
          <span className="cv-brand-radar">RADAR</span>{" "}
          <span className="cv-brand-signal">Signal</span>
          <span className="cv-brand-sep"> | BullsEye</span>
        </div>
        <div className="cv-nav-logo">
          <img src="/cloudfit-logo.png" alt="CloudFit Software" className="cv-nav-logo-img" />
        </div>
      </header>

      <div className="cv-exec-datebar">
        {dateCol && <>
          <span className="cv-exec-datebar-label">DATE FILTER</span>
          <DateRangePicker dateFrom={dateFrom} dateTo={dateTo}
            onChange={(f,t)=>{setDateFrom(f);setDateTo(t);}}
            onClear={()=>{setDateFrom("");setDateTo("");}} />
          <span className="cv-exec-datebar-summary">
            {dateFrom || dateTo ? (
              <>
                Showing data
                {dateFrom && dateTo
                  ? <> from <strong>{dateFrom}</strong> to <strong>{dateTo}</strong></>
                  : dateFrom
                    ? <> from <strong>{dateFrom}</strong> onward</>
                    : <> up to <strong>{dateTo}</strong></>
                }
              </>
            ) : (
              <span className="cv-exec-datebar-all">All dates — no filter applied</span>
            )}
          </span>
        </>}
        <div className="cv-exec-datebar-actions">
          <button className="cv-nav-reset" onClick={() => onSwitchView("dashboard")}>📊 Charts</button>
          <button className="cv-nav-reset" onClick={() => onSwitchView("table")}>📋 Table</button>
          <button className="cv-nav-reset" onClick={onReset}>⬆ New File</button>
          <button className="cv-nav-reset cv-nav-snapshot" onClick={generateSnapshotHTML} title="Download a static HTML snapshot for sharing or emailing">📧 Snapshot</button>
          <button
            className={`cv-nav-reset${annotating ? " cv-nav-reset--active" : ""}`}
            onClick={() => { setAnnotating(a => !a); setAnnotTool(null); }}
            title="Toggle annotation mode"
          >✏ Annotate</button>
          <button
            className={`cv-nav-reset${!annotVisible ? " cv-nav-reset--hidden" : ""}`}
            onClick={() => setAnnotVisible(v => !v)}
            title={annotVisible ? "Hide annotations" : "Show annotations"}
          >{annotVisible ? "👁 Hide" : "👁 Show"}</button>
        </div>
      </div>

      <div className="cv-exec-body" style={{ position: "relative" }}>
        <AnnotationOverlay active={annotating} tool={annotTool} onToolChange={setAnnotTool} visible={annotVisible} />
        <div className="cv-pg-layout">

          {/* ── LEFT PANEL ─────────────────────────────────── */}
          <div className="cv-pg-left">

            {/* C4 card */}
            <div className="cv-pg-panel">
              <div className="cv-pg-pill">C4</div>
              <div className="cv-pg-panel-row">
                <div className="cv-pg-stat-block">
                  <div className="cv-pg-stat-label">WUs Closed by C4</div>
                  <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                    <div className="cv-pg-stat-box">{c4Stats.count.toLocaleString()}</div>
                    <TrendBadge current={c4Stats.count} prior={priorC4Stats?.count} />
                  </div>
                </div>
                <div className="cv-pg-stat-block">
                  <div className="cv-pg-stat-label">C4 OVERALL Resolution %</div>
                  <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                    <div className="cv-pg-stat-box">{c4Stats.pct}%</div>
                    <TrendBadge current={c4Stats.pct} prior={priorC4Stats?.pct} invert={true} />
                  </div>
                </div>
              </div>
            </div>

            {/* Total WU Count */}
            <div className="cv-pg-panel">
              <div className="cv-pg-panel-label">Total WU Count</div>
              <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                <div className="cv-pg-big-box">{total.toLocaleString()}</div>
                <TrendBadge current={total} prior={priorTotal || null} />
              </div>
              <SevRow sevs={totalSevBreak} onHover={handleSevHover} onLeave={handleSevLeave} onClickSev={handleSevClick} />
            </div>

            {/* Total Automated */}
            <div className="cv-pg-panel">
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                <div className="cv-pg-panel-label" style={{ marginBottom:0 }}>Total Automated</div>
                <div className="cv-pg-pct-badge">{autoStats.pct}%</div>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                <div className="cv-pg-big-box">{autoStats.count.toLocaleString()}</div>
                <TrendBadge current={autoStats.count} prior={priorAutoStats?.count} invert={true} />
              </div>
              <SevRow sevs={autoStats.sevBreak} pgId="__auto__" onHover={handleSevHover} onLeave={handleSevLeave} onClickSev={handleSevClick} />
            </div>

            {/* Top Customers */}
            {topCustomers.length > 0 && (() => {
              const tcExpanded = fullscreenId === "top-customers";

              const tcHeader = (
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                  <div className="cv-pg-panel-label" style={{ marginBottom:0 }}>Top Customer WUs</div>
                  <div style={{ display:"flex", gap:4 }}>
                    <button className="cv-toolbar-btn cv-pg-fs-btn"
                      style={{ opacity:1 }}
                      title="Save as PNG"
                      onClick={() => saveCardImage(
                        tcExpanded ? topCustomerFsRef.current : topCustomerRef.current,
                        "Top-Customer-WUs"
                      )}>🖼</button>
                    <button className="cv-toolbar-btn cv-pg-fs-btn"
                      style={{ opacity:1 }}
                      title={tcExpanded ? "Exit fullscreen" : "Fullscreen"}
                      onClick={() => toggleFullscreen("top-customers")}>
                      {tcExpanded ? "✕" : "⛶"}
                    </button>
                  </div>
                </div>
              );

              const tcRows = (data, showTitles) => data.map((c, i) => {
                const autoTitles  = c.autoTitles  || [];
                const otherTitles = c.otherTitles || [];
                const hasTitles   = autoTitles.length > 0 || otherTitles.length > 0;
                const renderTitleSection = (label, accentColor, titles) => {
                  if (!titles.length) return null;
                  return (
                    <div className="cv-tc-fs-section">
                      <div className="cv-tc-fs-section-hdr" style={{ color: accentColor }}>
                        <span className="cv-tc-fs-section-dot" style={{ background: accentColor }} />
                        {label}
                        <span className="cv-tc-fs-section-meta">{titles.length} title{titles.length !== 1 ? "s" : ""}</span>
                      </div>
                      {titles.map((t, ti) => (
                        <div key={ti} className="cv-pg-fs-title-row">
                          <span className="cv-pg-fs-title-rank">{ti + 1}</span>
                          <span className="cv-pg-fs-title-name" title={t.title}>
                            {t.title.length > 50 ? t.title.slice(0, 50) + "…" : t.title}
                          </span>
                          <span className="cv-pg-fs-title-count">{t.count.toLocaleString()}</span>
                          <span className="cv-pg-fs-title-pct" style={{ color: accentColor }}>{t.pct}%</span>
                        </div>
                      ))}
                    </div>
                  );
                };
                return (
                  <div key={i}>
                    <div className="cv-pg-customer-row"
                      style={{ cursor: !showTitles && tenantTitleMap[c.name]?.length ? "default" : undefined }}
                      onMouseEnter={!showTitles ? (e => {
                        if (!tenantTitleMap[c.name]?.length) return;
                        const { x, y } = getTooltipXY(e.currentTarget.getBoundingClientRect());
                        setHoveredTenant({ name: c.name, x, y });
                      }) : undefined}
                      onMouseLeave={!showTitles ? () => setHoveredTenant(null) : undefined}>
                      <div className="cv-pg-customer-name">{c.name}</div>
                      <div className="cv-pg-customer-count">{c.count.toLocaleString()}</div>
                    </div>
                    {showTitles && hasTitles && (
                      <div className="cv-tc-fs-titles">
                        {renderTitleSection("Automation", "#22c55e", autoTitles)}
                        {renderTitleSection("Other", "#94a3b8", otherTitles)}
                      </div>
                    )}
                  </div>
                );
              });

              return (
                <>
                  <div ref={topCustomerRef} className="cv-pg-panel" style={{ position:"relative" }}>
                    {tcHeader}
                    {tcRows(topCustomers, false)}
                  </div>
                  {tcExpanded && (
                    <>
                      <div className="cv-fullscreen-backdrop" onClick={() => toggleFullscreen("top-customers")} />
                      <div ref={topCustomerFsRef} className="cv-pg-panel cv-tc-fs-panel">
                        {tcHeader}
                        {tcRows(topCustomersFull, true)}
                      </div>
                    </>
                  )}
                </>
              );
            })()}

            {/* Tenant title tooltip */}
            {hoveredTenant && tenantTitleMap[hoveredTenant.name] && (
              <div className="cv-tenant-tooltip"
                style={{ top: hoveredTenant.y, left: hoveredTenant.x }}
                onMouseEnter={() => {/* keep open */}}
                onMouseLeave={() => setHoveredTenant(null)}>
                <div className="cv-tenant-tooltip-title">{hoveredTenant.name} — Top Titles</div>
                {tenantTitleMap[hoveredTenant.name].map((t, i) => (
                  <div key={i} className="cv-tenant-tooltip-row">
                    <span className="cv-tenant-tooltip-rank">{i+1}</span>
                    <span className="cv-tenant-tooltip-name" title={t.title}>
                      {t.title.length > 38 ? t.title.slice(0,38)+"…" : t.title}
                    </span>
                    <span className="cv-tenant-tooltip-count">{t.count.toLocaleString()}</span>
                    <span className="cv-tenant-tooltip-pct">{t.pct}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Severity title tooltip — position:fixed, outside flow */}
          {(() => {
            if (!hoveredSev) return null;
            const titles = hoveredSev.pgId === "__auto__"
              ? (autoSevTitleMap[hoveredSev.sevLabel] || [])
              : hoveredSev.pgId
                ? (productGroupData.find(pg => pg.id === hoveredSev.pgId)?.sevTitles?.[hoveredSev.sevLabel] || [])
                : (sevTitleMap[hoveredSev.sevLabel] || []);
            if (!titles.length) return null;
            return (
              <div className="cv-sev-tooltip"
                style={{
                  top:  hoveredSev.y,
                  left: hoveredSev.x,
                  borderColor: SEV_COLOR_BY_LABEL[hoveredSev.sevLabel] || "#334155",
                }}
                onMouseEnter={() => {/* keep open */}}
                onMouseLeave={handleSevLeave}>
                <div className="cv-sev-tooltip-title"
                  style={{ color: SEV_COLOR_BY_LABEL[hoveredSev.sevLabel] || "#e2e8f0" }}>
                  {hoveredSev.pgId ? `${hoveredSev.pgId} · ` : ""}{hoveredSev.sevLabel} — Top Titles
                </div>
                {titles.map((t, i) => (
                  <div key={i} className="cv-sev-tooltip-row">
                    <span className="cv-sev-tooltip-rank">{i+1}</span>
                    <span className="cv-sev-tooltip-name" title={t.title}>
                      {t.title.length > 42 ? t.title.slice(0,42)+"…" : t.title}
                    </span>
                    <span className="cv-sev-tooltip-count">{t.count.toLocaleString()}</span>
                    <span className="cv-sev-tooltip-pct">{t.pct}%</span>
                  </div>
                ))}
                {/* Tenant bar chart */}
                {(() => {
                  const sevColor = SEV_COLOR_BY_LABEL[hoveredSev.sevLabel] || "#64748b";
                  const tenants = hoveredSev.pgId === "__auto__"
                    ? (autoSevTenantMap[hoveredSev.sevLabel] || [])
                    : hoveredSev.pgId
                      ? (pgSevTenantMap[hoveredSev.pgId]?.[hoveredSev.sevLabel] || [])
                      : (sevTenantMap[hoveredSev.sevLabel] || []);
                  if (!tenants.length) return null;
                  const maxCount = tenants[0].count;
                  return (
                    <div style={{ marginTop:10, borderTop:"1px solid rgba(255,255,255,0.08)", paddingTop:8 }}>
                      <div style={{ fontSize:11, color:"#94a3b8", fontWeight:600, letterSpacing:"0.4px", textTransform:"uppercase", marginBottom:6 }}>
                        By Tenant
                      </div>
                      {tenants.map((t, i) => (
                        <div key={i} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                          <span style={{ width:90, fontSize:11, color:"#cbd5e1", textAlign:"right", flexShrink:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}
                            title={t.tenant}>
                            {t.tenant.length > 13 ? t.tenant.slice(0,13)+"…" : t.tenant}
                          </span>
                          <div style={{ flex:1, background:"rgba(255,255,255,0.06)", borderRadius:3, height:10, overflow:"hidden" }}>
                            <div style={{
                              height:"100%", borderRadius:3,
                              width:`${(t.count / maxCount) * 100}%`,
                              background: sevColor,
                              opacity: 0.85,
                              minWidth: 3,
                            }} />
                          </div>
                          <span style={{ fontSize:11, color:"#f1f5f9", fontWeight:700, flexShrink:0, width:36, textAlign:"right" }}>
                            {t.count.toLocaleString()}
                          </span>
                          <span style={{ fontSize:10, color:"#64748b", flexShrink:0, width:34 }}>
                            {t.pct}%
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            );
          })()}

          {/* Subgroup title tooltip — position:fixed, outside flow */}
          {hoveredSubgroup && hoveredSubgroup.titles?.length > 0 && (
            <div className="cv-sev-tooltip"
              style={{
                top:  hoveredSubgroup.y,
                left: hoveredSubgroup.x,
                borderColor: SUBGROUP_COLOR[hoveredSubgroup.subLabel] || "#334155",
              }}
              onMouseEnter={() => {/* keep open */}}
              onMouseLeave={() => setHoveredSubgroup(null)}>
              <div className="cv-sev-tooltip-title"
                style={{ color: SUBGROUP_COLOR[hoveredSubgroup.subLabel] || "#e2e8f0" }}>
                {hoveredSubgroup.pgId} · {hoveredSubgroup.subLabel} — Top Titles
              </div>
              {hoveredSubgroup.titles.map((t, i) => (
                <div key={i} className="cv-sev-tooltip-row">
                  <span className="cv-sev-tooltip-rank">{i+1}</span>
                  <span className="cv-sev-tooltip-name" title={t.title}>
                    {t.title.length > 42 ? t.title.slice(0,42)+"…" : t.title}
                  </span>
                  <span className="cv-sev-tooltip-count">{t.count.toLocaleString()}</span>
                  <span className="cv-sev-tooltip-pct"
                    style={{ color: SUBGROUP_COLOR[hoveredSubgroup.subLabel] || "#94a3b8" }}>
                    {t.pct}%
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Sev click detail panel — position:fixed, outside flow */}
          {sevClickPanel && (() => {
            const q = panelSearch.trim().toLowerCase();
            const filteredRows = q
              ? sevClickPanel.rows.filter(r =>
                  (r.label  || "").toLowerCase().includes(q) ||
                  (r.tenant || "").toLowerCase().includes(q))
              : sevClickPanel.rows;
            return (
              <div className="cv-sev-dock-panel" style={{ position:"fixed", top:0, right:0, height:"100vh", width:520, zIndex:300, overflowY:"auto", border:"2px solid #ffffff", borderRadius:"8px 0 0 8px", boxShadow:"-4px 0 24px rgba(0,0,0,0.5)", background:"#0f172a" }}>
                <div style={{ display:"flex", justifyContent:"flex-end", padding:"8px 10px 0" }}>
                  <button onClick={() => setSevClickPanel(null)}
                    style={{ background:"none", border:"1px solid #ffffff", color:"#ffffff", borderRadius:5, width:28, height:28, cursor:"pointer", fontSize:16, lineHeight:1, display:"flex", alignItems:"center", justifyContent:"center" }}>✕</button>
                </div>
                {/* Search input */}
                <div style={{ padding:"6px 14px 10px" }}>
                  <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                    <input
                      type="text"
                      placeholder="Search title or tenant…"
                      value={panelSearch}
                      onChange={e => setPanelSearch(e.target.value)}
                      style={{
                        flex:1, boxSizing:"border-box",
                        background:"#1e293b", border:"1px solid #334155",
                        borderRadius:6, padding:"7px 10px",
                        color:"#f1f5f9", fontSize:13,
                        outline:"none",
                      }}
                    />
                    <button
                      onClick={() => setPanelSearch("")}
                      title="Clear search"
                      className="cv-clear-all-btn"
                    >Clear</button>
                  </div>
                  {q && (
                    <div style={{ fontSize:12, color:"#64748b", marginTop:5 }}>
                      {filteredRows.length} of {sevClickPanel.rows.length} rows
                    </div>
                  )}
                </div>
                <DetailPanel
                  title={sevClickPanel.title}
                  rows={filteredRows}
                  onClose={() => setSevClickPanel(null)}
                  highlightTop3={false}
                />
              </div>
            );
          })()}

          {/* ── PRODUCT CARDS GRID ─────────────────────────── */}
          <div className="cv-pg-grid">
            {productGroupData.map(pg => {
              const isExpanded = fullscreenId === pg.id;

              const cardInner = (
                <>
                  {/* Card header */}
                  <div className="cv-pg-card-header">
                    <div className="cv-pg-pill">{pg.label}</div>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <button className="cv-toolbar-btn cv-pg-fs-btn"
                        title="Save as PNG"
                        onClick={() => saveCardImage(pgCardRefs.current[pg.id], pg.label)}>
                        🖼
                      </button>
                      <button className="cv-toolbar-btn cv-pg-fs-btn"
                        title={isExpanded ? "Exit fullscreen" : "Fullscreen"}
                        onClick={() => toggleFullscreen(pg.id)}>
                        {isExpanded ? "✕" : "⛶"}
                      </button>
                      <div className="cv-pg-workload">
                        Workload <span className="cv-pg-workload-pct">{pg.workloadPct}%</span>
                      </div>
                    </div>
                  </div>

                  {/* Main metrics */}
                  <div className={`cv-pg-card-body${isExpanded ? " cv-pg-card-body--fs" : ""}`}>
                    <div className="cv-pg-card-bottom">
                      <div className="cv-pg-card-left">
                        <div className="cv-pg-card-metrics">
                          <div>
                            <div className="cv-pg-metric-label">Total WUs</div>
                            <div className="cv-pg-metric-val">{pg.total.toLocaleString()}</div>
                          </div>
                          <div>
                            <div className="cv-pg-metric-label">C4 Resolution %</div>
                            <div className="cv-pg-metric-val">{pg.c4Pct}%</div>
                          </div>
                        </div>

                        {/* Sparkline trend */}
                        {pgSparkData[pg.id]?.length >= 2 && (
                          <div className="cv-pg-sparkline"
                            title={`Volume trend over date range (${pgSparkData[pg.id].length} ${pgSparkData[pg.id].length > 60 ? "days" : "buckets"})`}>
                            <Sparkline data={pgSparkData[pg.id]} color="#ffff66" />
                          </div>
                        )}
                      </div>

                    {/* Sub-groups */}
                    <div className={`cv-pg-subgroups${isExpanded ? " cv-pg-subgroups--fs" : ""}`}>
                      {[["AUTO",pg.AUTO],["BEST1",pg.BEST1],["TRUST3",pg.TRUST3],["PG",pg.PG]].map(([k,v]) => (
                        <div key={k} className={`cv-pg-subgroup-row${isExpanded ? " cv-pg-subgroup-row--fs" : ""}`}>
                          <span className="cv-pg-subgroup-hotspot"
                            style={{ cursor: pg.subTitles[k]?.length ? "pointer" : undefined }}
                            onMouseEnter={pg.subTitles[k]?.length ? (e => {
                              const { x, y } = getTooltipXY(e.currentTarget.getBoundingClientRect());
                              setHoveredSubgroup({ pgId: pg.id, subLabel: k, titles: pg.subTitles[k], x, y });
                            }) : undefined}
                            onMouseLeave={() => setHoveredSubgroup(null)}>
                            <span className="cv-pg-subgroup-count">{v.toLocaleString()}</span>
                            <span className="cv-pg-subgroup-label">{k}</span>
                            <span className="cv-pg-subgroup-pct">
                              {pg.total ? Math.round((v / pg.total) * 100) : 0}%
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                    </div>{/* end cv-pg-card-bottom */}

                    {/* Sev row — full width, below both columns */}
                    <SevRow sevs={pg.sevs} pgId={pg.id} onHover={handleSevHover} onLeave={handleSevLeave} onClickSev={handleSevClick} />

                    {/* Fullscreen: top titles per subgroup */}
                    {isExpanded && (
                      <div className="cv-pg-fs-titles">
                        {[["AUTO",pg.AUTO],["BEST1",pg.BEST1],["TRUST3",pg.TRUST3],["PG",pg.PG]].map(([k,v]) =>
                          pg.subTitles[k]?.length ? (
                            <div key={k} className="cv-pg-fs-title-col">
                              <div className="cv-pg-fs-title-header"
                                style={{ color: SUBGROUP_COLOR[k] || "#94a3b8" }}>
                                {k} — Top Titles
                              </div>
                              {pg.subTitles[k].map((t, i) => (
                                <div key={i} className="cv-pg-fs-title-row">
                                  <span className="cv-pg-fs-title-rank">{i+1}</span>
                                  <span className="cv-pg-fs-title-name" title={t.title}>
                                    {t.title.length > 45 ? t.title.slice(0,45)+"…" : t.title}
                                  </span>
                                  <span className="cv-pg-fs-title-count">{t.count.toLocaleString()}</span>
                                  <span className="cv-pg-fs-title-pct"
                                    style={{ color: SUBGROUP_COLOR[k] || "#94a3b8" }}>
                                    {t.pct}%
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : null
                        )}
                      </div>
                    )}

                    {/* Fullscreen: Sev 1 & Sev 2 titles table */}
                    {isExpanded && (pg.sevTitlesAll?.["Sev 1"] || pg.sevTitlesAll?.["Sev 2"] || pg.sevTitlesAll?.["Sev 3"]) && (
                      <div className="cv-pg-sev-titles-wrap">
                        {["Sev 1", "Sev 2", "Sev 3"].map(sev => {
                          const sevData = pg.sevTitlesAll?.[sev];
                          if (!sevData) return null;
                          const { auto: autoRows = [], other: otherRows = [] } = sevData;
                          if (!autoRows.length && !otherRows.length) return null;
                          const color = SEV_COLOR_BY_LABEL[sev] || "#94a3b8";
                          const autoTotal  = autoRows.reduce((s, r) => s + r.count, 0);
                          const otherTotal = otherRows.reduce((s, r) => s + r.count, 0);
                          const grandTotal = autoTotal + otherTotal;

                          const WU_BASE = "https://portal.cloudfitgov.cloudfit.software/workunitsv2?workUnitId=";

                          const renderSection = (label, sectionRows, sectionTotal, accentColor) => {
                            if (!sectionRows.length) return null;
                            return (
                              <>
                                <tr className="cv-pg-sev-section-hdr">
                                  <td colSpan={wuCol ? 5 : 4}>
                                    <span className="cv-pg-sev-section-label" style={{ color: accentColor }}>{label}</span>
                                    <span className="cv-pg-sev-section-meta">
                                      {sectionTotal.toLocaleString()} incidents · {sectionRows.length} titles
                                    </span>
                                  </td>
                                </tr>
                                {sectionRows.map((t, i) => (
                                  <tr key={i} className={i % 2 === 0 ? "cv-pg-sev-row-even" : ""}>
                                    <td className="cv-pg-sev-td-rank">{i + 1}</td>
                                    <td className="cv-pg-sev-td-title">{t.title}</td>
                                    <td className="cv-pg-sev-td-count">{t.count.toLocaleString()}</td>
                                    <td className="cv-pg-sev-td-pct" style={{ color: accentColor }}>{t.pct}%</td>
                                    {wuCol && (
                                      <td className="cv-pg-sev-td-wu">
                                        {t.wuNum
                                          ? <a className="cv-pg-sev-wu-link"
                                              href={`${WU_BASE}${t.wuNum}`}
                                              target="_blank" rel="noreferrer">
                                              WU #{t.wuNum} ↗
                                            </a>
                                          : <span style={{ color:"#334155" }}>—</span>
                                        }
                                      </td>
                                    )}
                                  </tr>
                                ))}
                              </>
                            );
                          };

                          return (
                            <div key={sev} className="cv-pg-sev-titles-block">
                              <div className="cv-pg-sev-titles-header" style={{ color }}>
                                <span className="cv-pg-sev-titles-dot" style={{ background: color }} />
                                {sev} — All Titles
                                <span className="cv-pg-sev-titles-total">
                                  {grandTotal.toLocaleString()} incidents
                                </span>
                              </div>
                              <table className="cv-pg-sev-titles-table">
                                <thead>
                                  <tr>
                                    <th>#</th>
                                    <th>Title</th>
                                    <th>Count</th>
                                    <th>%</th>
                                    {wuCol && <th>Example WU</th>}
                                  </tr>
                                </thead>
                                <tbody>
                                  {renderSection("Automation", autoRows, autoTotal, "#22c55e")}
                                  {renderSection("Other (C4 / PG)", otherRows, otherTotal, color)}
                                </tbody>
                              </table>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              );

              if (isExpanded) {
                return (
                  <React.Fragment key={pg.id}>
                    <div className="cv-fullscreen-backdrop" onClick={() => toggleFullscreen(pg.id)} />
                    <div ref={el => { pgCardRefs.current[pg.id] = el; }}
                      className="cv-pg-card cv-pg-card--fs">{cardInner}</div>
                  </React.Fragment>
                );
              }

              return (
                <div key={pg.id} ref={el => { pgCardRefs.current[pg.id] = el; }}
                  className="cv-pg-card">{cardInner}</div>
              );
            })}
          </div>

        </div>
      </div>
    </div>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────

export default function App() {
  const [csvData,   setCsvData]   = useState(null);
  const [view,      setView]      = useState("dashboard"); // "dashboard" | "table" | "exec"
  const [dateFrom,  setDateFrom]  = useState("");
  const [dateTo,    setDateTo]    = useState("");

  const handleData  = (data, fields, name) => { setCsvData({ data: data.filter(r => r != null && typeof r === "object"), fields, name }); setView("dashboard"); };
  const handleReset = () => { setCsvData(null); setView("dashboard"); };

  const dateProps = { dateFrom, dateTo, setDateFrom, setDateTo };

  if (!csvData) return <UploadZone onData={handleData} />;
  if (view === "table") return (
    <TableView rows={csvData.data} columns={csvData.fields} fileName={csvData.name}
      onReset={handleReset} onSwitchView={(v) => setView(v || "dashboard")} {...dateProps} />
  );
  if (view === "exec") return (
    <ExecSummary rows={csvData.data} columns={csvData.fields} fileName={csvData.name}
      onReset={handleReset} onSwitchView={(v) => setView(v || "dashboard")} {...dateProps} />
  );
  return (
    <Dashboard rows={csvData.data} columns={csvData.fields} fileName={csvData.name}
      onReset={handleReset} onSwitchView={(v) => setView(v || "table")} {...dateProps} />
  );
}
