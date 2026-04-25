// Scroll-triggered polish for benchmark tables: numbers count up from zero
// when the table scrolls into view, and .winner rows get a one-shot accent
// pulse. Values are parsed out of the existing text (prefix / number /
// suffix), so there's no markup to keep in sync.
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const fmt = (v, d) =>
    v.toLocaleString(undefined, {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });

  const parse = (cell) => {
    const raw = cell.textContent.trim();
    const m = raw.match(/^([~<>]?)\s*([\d][\d,._ ]*(?:\.\d+)?)(.*)$/);
    if (!m) return null;
    const clean = m[2].replace(/[,_ ]/g, "");
    const target = parseFloat(clean);
    if (!isFinite(target)) return null;
    const decimals = clean.includes(".") ? clean.split(".")[1].length : 0;
    return { raw, prefix: m[1], target, suffix: m[3], decimals };
  };

  const cells = new Map();
  document.querySelectorAll("table.bench td.num-cell").forEach((cell) => {
    const info = parse(cell);
    if (!info) return;
    cells.set(cell, info);
    if (!reduced) {
      cell.textContent = `${info.prefix}${fmt(0, info.decimals)}${info.suffix}`;
    }
  });

  const animate = (cell, info) => {
    const dur = 900;
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      cell.textContent = `${info.prefix}${fmt(info.target * e, info.decimals)}${info.suffix}`;
      if (t < 1) requestAnimationFrame(step);
      else cell.textContent = info.raw;
    };
    requestAnimationFrame(step);
  };

  const played = new WeakSet();
  const play = (table) => {
    if (played.has(table)) return;
    played.add(table);
    table.querySelectorAll("td.num-cell").forEach((cell) => {
      const info = cells.get(cell);
      if (!info) return;
      if (reduced) return;
      animate(cell, info);
    });
    table.querySelectorAll("tr.winner").forEach((row) => {
      row.classList.add("pulse");
      setTimeout(() => row.classList.remove("pulse"), 1500);
    });
  };

  if (!("IntersectionObserver" in window)) {
    document.querySelectorAll("table.bench").forEach(play);
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) play(e.target);
    },
    { threshold: 0.25 },
  );
  document.querySelectorAll("table.bench").forEach((t) => io.observe(t));
})();

// SIMD demo orchestration: tick the counters every STEP_MS (the time one
// packet takes to cross its lane) and restart the parallel row's 8-
// iteration burst every 48s so it re-syncs with the serial row's 64-
// packet macro cycle. Counters are time-driven rather than event-driven
// because `animationiteration` fires per full 6s iteration (not per
// sweep), which would leave the serial counter stuck at 0 for 6s.
(() => {
  const parallelRow = document.querySelector(".simd-parallel");
  const serialRow = document.querySelector(".simd-serial");
  if (!parallelRow || !serialRow) return;

  const pOut = parallelRow.querySelector(".simd-count");
  const sOut = serialRow.querySelector(".simd-count");
  const pPackets = parallelRow.querySelectorAll(".simd-packet");
  if (!pOut || !sOut) return;

  const STEP_MS = 750;
  const CYCLE_MS = 48000; // 64 * STEP_MS — exactly 8 serial iterations
  const TOTAL = 64;

  let cycleTimers = [];
  const clearCycle = () => {
    cycleTimers.forEach(clearTimeout);
    cycleTimers = [];
  };

  // First tick lands at STEP_MS — when the first packet has finished
  // crossing — and then every STEP_MS until `n` saturates at TOTAL.
  const drive = (el, inc) => {
    let n = 0;
    el.textContent = "0";
    const bump = () => {
      if (n >= TOTAL) return;
      n = Math.min(TOTAL, n + inc);
      el.textContent = String(n);
    };
    cycleTimers.push(
      setTimeout(() => {
        bump();
        if (n >= TOTAL) return;
        const id = setInterval(() => {
          bump();
          if (n >= TOTAL) clearInterval(id);
        }, STEP_MS);
        cycleTimers.push(id);
      }, STEP_MS),
    );
  };

  const startCycle = () => {
    clearCycle();
    drive(pOut, 8);
    drive(sOut, 1);
  };

  startCycle();
  setInterval(() => {
    pPackets.forEach((p) => {
      p.getAnimations().forEach((a) => {
        a.cancel();
        a.play();
      });
    });
    startCycle();
  }, CYCLE_MS);
})();
