/**
 * xray.js: the "X-ray" view, i.e. what the face matcher actually sees.
 *
 *  1. Embedding strip: the 128 numbers of the enrolled descriptor, the live
 *     descriptor and their difference, one cell per number. Diverging colour
 *     (blue = negative, grey = 0, red = positive) for the values, one hue
 *     (grey -> cyan) for the size of the difference.
 *  2. Distance timeline: the live match distance over the last 20 seconds
 *     against the threshold line. Below the line = match.
 *
 * Both are plain <canvas> drawings with a hover tooltip. Colours come from
 * CSS custom properties so the palette lives in style.css.
 */

const WINDOW_MS = 20000;
const VALUE_RANGE = 0.2;   // descriptor values are roughly -0.25..0.25
const DIFF_RANGE = 0.15;

export function createXray({ embedCanvas, embedTip, diffText, chartCanvas, chartTip }) {
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const C = {
    neg: hexToRgb(color('--viz-neg')),
    pos: hexToRgb(color('--viz-pos')),
    mid: hexToRgb(color('--viz-mid')),
    seq: hexToRgb(color('--accent')),
    line: color('--accent'),
    ok: color('--ok'),
    ink: color('--text'),
    muted: color('--muted'),
    grid: 'rgba(216, 243, 255, 0.10)',
    surface: color('--bg-2'),
  };

  // Last data drawn, so hover can redraw without new data
  let embed = { enrolled: null, live: null };
  let chart = { samples: [], threshold: 0.5, now: 0 };
  let hoverCell = -1;
  let hoverX = null;

  // ---------- Embedding strip ----------

  function drawEmbedding(enrolled = embed.enrolled, live = embed.live) {
    embed = { enrolled, live };
    const { ctx, w, h } = fit(embedCanvas);
    ctx.clearRect(0, 0, w, h);
    if (!enrolled) return;

    const n = enrolled.length;
    const cellW = w / n;
    const gap = cellW > 4 ? 1 : 0;       // thin surface gap between cells when there is room
    const rowGap = 4;
    const rowH = (h - rowGap * 2) / 3;

    for (let r = 0; r < 3; r++) {
      const y = r * (rowH + rowGap);
      for (let i = 0; i < n; i++) {
        let fill;
        if (r === 0) fill = diverging(enrolled[i]);
        else if (!live) fill = 'rgba(255,255,255,0.04)';
        else if (r === 1) fill = diverging(live[i]);
        else fill = sequential(Math.abs(live[i] - enrolled[i]));
        ctx.fillStyle = fill;
        ctx.fillRect(i * cellW, y, Math.max(1, cellW - gap), rowH);
      }
    }

    // Hovered column: outline across all three rows
    if (hoverCell >= 0) {
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(hoverCell * cellW - 0.5, 0.75, cellW + 1, h - 1.5);
    }

    // Text summary of the biggest differences (keeps the data readable without hovering)
    if (live) {
      const top = [...enrolled.keys()]
        .map((i) => ({ i, d: Math.abs(live[i] - enrolled[i]) }))
        .sort((a, b) => b.d - a.d)
        .slice(0, 3)
        .map(({ i, d }) => `#${i} (${d.toFixed(3)})`);
      diffText.textContent = `Largest differences: ${top.join(', ')}`;
    } else {
      diffText.textContent = 'Waiting for a live face…';
    }
  }

  function diverging(v) {
    const t = Math.min(1, Math.abs(v) / VALUE_RANGE);
    return mix(C.mid, v < 0 ? C.neg : C.pos, t);
  }

  function sequential(v) {
    return mix(C.mid, C.seq, Math.min(1, v / DIFF_RANGE));
  }

  embedCanvas.addEventListener('pointermove', (e) => {
    if (!embed.enrolled) return;
    const rect = embedCanvas.getBoundingClientRect();
    const i = Math.min(embed.enrolled.length - 1, Math.max(0, Math.floor((e.clientX - rect.left) / rect.width * embed.enrolled.length)));
    if (i !== hoverCell) {
      hoverCell = i;
      drawEmbedding();
    }
    const { enrolled, live } = embed;
    showTip(embedTip, e.clientX - rect.left, [
      [enrolled[i].toFixed(3), 'enrolled'],
      [live ? live[i].toFixed(3) : '-', 'live'],
      [live ? Math.abs(live[i] - enrolled[i]).toFixed(3) : '-', 'difference'],
    ], `dimension ${i}`, rect.width);
  });
  embedCanvas.addEventListener('pointerleave', () => {
    hoverCell = -1;
    embedTip.hidden = true;
    drawEmbedding();
  });

  // ---------- Distance timeline ----------

  const PAD = { l: 34, r: 44, t: 10, b: 22 };

  function drawChart(samples = chart.samples, threshold = chart.threshold, now = chart.now) {
    chart = { samples, threshold, now };
    const { ctx, w, h } = fit(chartCanvas);
    ctx.clearRect(0, 0, w, h);
    const pw = w - PAD.l - PAD.r;
    const ph = h - PAD.t - PAD.b;
    const xOf = (t) => PAD.l + (1 - (now - t) / WINDOW_MS) * pw;
    const yOf = (d) => PAD.t + Math.min(1, d) * ph;   // 0 at the top = closest match

    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';

    // Match zone: everything above the threshold line (distance < threshold)
    ctx.fillStyle = 'rgba(52, 245, 160, 0.07)';
    ctx.fillRect(PAD.l, PAD.t, pw, yOf(threshold) - PAD.t);
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'left';
    ctx.fillText('match zone', PAD.l + 6, PAD.t + 9);

    // Recessive grid + y labels
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    for (const d of [0, 0.25, 0.5, 0.75, 1]) {
      ctx.beginPath();
      ctx.moveTo(PAD.l, yOf(d) + 0.5);
      ctx.lineTo(PAD.l + pw, yOf(d) + 0.5);
      ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.fillText(d.toFixed(d % 0.5 ? 2 : 1), PAD.l - 6, yOf(d));
    }
    ctx.textAlign = 'left';
    ctx.fillText('-20 s', PAD.l, h - 8);
    ctx.textAlign = 'right';
    ctx.fillText('now', PAD.l + pw, h - 8);

    // Threshold line, labelled at the right edge
    ctx.strokeStyle = C.ok;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PAD.l, yOf(threshold));
    ctx.lineTo(PAD.l + pw, yOf(threshold));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.ink;
    ctx.textAlign = 'left';
    ctx.fillText(threshold.toFixed(2), PAD.l + pw + 6, yOf(threshold));

    // The distance line (gaps where no face was seen)
    const visible = samples.filter((s) => now - s.t <= WINDOW_MS);
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (const s of visible) {
      if (s.d == null) { pen = false; continue; }
      const x = xOf(s.t);
      const y = yOf(s.d);
      if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();

    // Latest value: marker with a surface ring + direct label
    const last = [...visible].reverse().find((s) => s.d != null);
    if (last && now - last.t < 1500) {
      dot(ctx, xOf(last.t), yOf(last.d), C.line);
    }

    // Crosshair + tooltip, snapped to the nearest sample
    if (hoverX != null && visible.length) {
      const t = now - (1 - (hoverX - PAD.l) / pw) * WINDOW_MS;
      const s = visible.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
      const x = xOf(s.t);
      ctx.strokeStyle = 'rgba(216, 243, 255, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, PAD.t);
      ctx.lineTo(x + 0.5, PAD.t + ph);
      ctx.stroke();
      if (s.d != null) dot(ctx, x, yOf(s.d), C.line);
      showTip(chartTip, x, [
        [s.d == null ? 'no face' : s.d.toFixed(3), 'distance'],
        [s.d == null ? '-' : s.d < threshold ? 'match' : 'no match', 'result'],
        [`${((now - s.t) / 1000).toFixed(1)} s ago`, 'time'],
      ], null, chartCanvas.clientWidth);
    }

    function dot(c, x, y, fill) {
      c.beginPath();
      c.arc(x, y, 5, 0, Math.PI * 2);
      c.fillStyle = fill;
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = C.surface;
      c.stroke();
    }
  }

  chartCanvas.addEventListener('pointermove', (e) => {
    const rect = chartCanvas.getBoundingClientRect();
    hoverX = Math.min(rect.width - PAD.r, Math.max(PAD.l, e.clientX - rect.left));
    drawChart();
  });
  chartCanvas.addEventListener('pointerleave', () => {
    hoverX = null;
    chartTip.hidden = true;
    drawChart();
  });

  return { drawEmbedding, drawChart };
}

// ---------- helpers ----------

/** Size a canvas to its CSS box at device pixel ratio; returns a ready context. */
function fit(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/**
 * Fill a tooltip: value first (strong), label second. textContent only.
 * `rows` = [[value, label], ...]; positioned at `x` inside its card.
 */
function showTip(tip, x, rows, title, width) {
  tip.replaceChildren();
  if (title) {
    const t = document.createElement('div');
    t.className = 'tip-title';
    t.textContent = title;
    tip.append(t);
  }
  for (const [value, label] of rows) {
    const row = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = value;
    const s = document.createElement('span');
    s.textContent = label;
    row.append(b, s);
    tip.append(row);
  }
  tip.hidden = false;
  const tw = tip.offsetWidth;
  tip.style.left = `${Math.max(0, Math.min(width - tw, x - tw / 2))}px`;
}

function hexToRgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function mix(a, b, t) {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
