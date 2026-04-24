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

// SIMD demo orchestration: count packets as they complete a sweep, and
// restart the parallel row's animations every 48s so its 8-iteration
// burst re-syncs with the serial row's 64-packet macro cycle.
(() => {
  const parallelRow = document.querySelector(".simd-parallel");
  const serialRow = document.querySelector(".simd-serial");
  if (!parallelRow || !serialRow) return;

  const pOut = parallelRow.querySelector(".simd-count");
  const sOut = serialRow.querySelector(".simd-count");
  const pPackets = parallelRow.querySelectorAll(".simd-packet");
  const sPackets = serialRow.querySelectorAll(".simd-packet");
  if (!pOut || !sOut) return;

  const CYCLE_MS = 48000;
  let pCount = 0;
  let sCount = 0;

  // `animationiteration` fires at the end of each iteration except the
  // last (which fires `animationend`). Wiring both covers the count-capped
  // parallel animation (8 iterations) and the infinite serial animation.
  const bump = (get, set, out) => () => {
    const n = get();
    if (n >= 64) return;
    const next = n + 1;
    set(next);
    out.textContent = String(next);
  };
  const bumpP = bump(
    () => pCount,
    (v) => (pCount = v),
    pOut,
  );
  const bumpS = bump(
    () => sCount,
    (v) => (sCount = v),
    sOut,
  );

  pPackets.forEach((p) => {
    p.addEventListener("animationiteration", bumpP);
    p.addEventListener("animationend", bumpP);
  });
  sPackets.forEach((p) => {
    p.addEventListener("animationiteration", bumpS);
  });

  const reset = () => {
    pCount = 0;
    sCount = 0;
    pOut.textContent = "0";
    sOut.textContent = "0";
    pPackets.forEach((p) => {
      p.getAnimations().forEach((a) => {
        a.cancel();
        a.play();
      });
    });
  };
  setInterval(reset, CYCLE_MS);
})();
