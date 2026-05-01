// Single full-viewport canvas. Stars + nebulae are positioned in a
// normalized [0, 1) y-axis that wraps; on scroll, each is redrawn at
// y = (origin - scrollY * parallax / pageH) mod 1, so they appear to
// drift at depth-dependent rates (bright stars fastest, dim stars +
// nebulae slowest). One DOM element, no CSS transforms — scrolling is
// just an rAF-throttled redraw.
(() => {
  const SEED = 1337;
  const STAR_COUNT = 700;

  const canvas = document.createElement("canvas");
  canvas.id = "__space";
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = `
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: -10;
  `;
  function mount() {
    if (document.body) document.body.insertBefore(canvas, document.body.firstChild);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // Stars. parallax: 0..1, fraction of scroll distance to drift.
  // bright/foreground stars get the larger values so they "race past."
  const rng = makeRng(SEED);
  const stars = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    const r = rng();
    let radius, alpha, halo, parallax;
    if (r > 0.985) {
      // Brightest — large halo, fastest parallax.
      radius = 1.8 + rng() * 1.2;
      alpha = 0.85 + rng() * 0.15;
      halo = true;
      parallax = 0.32 + rng() * 0.12;
    } else if (r > 0.94) {
      // Mid — small halo, mid-rate parallax.
      radius = 1.1 + rng() * 0.6;
      alpha = 0.7 + rng() * 0.2;
      halo = true;
      parallax = 0.15 + rng() * 0.1;
    } else {
      // Dim — pinprick, slow parallax (distant).
      radius = 0.5 + rng() * 0.6;
      alpha = 0.35 + rng() * 0.4;
      halo = false;
      parallax = 0.04 + rng() * 0.08;
    }
    const ct = rng();
    let color;
    if (ct > 0.93) color = [255, 168, 85];
    else if (ct > 0.86) color = [180, 210, 255];
    else color = [255, 250, 240];
    stars.push({
      x: rng(),
      y: rng(),
      radius,
      alpha,
      halo,
      parallax,
      color,
    });
  }

  // Nebulae — slowest layer (deep background).
  const nebulae = [
    { x: 0.78, y: 0.18, rx: 0.7, ry: 0.55, color: [255, 168, 85], alpha: 0.13, parallax: 0.02 },
    { x: 0.12, y: 0.75, rx: 0.55, ry: 0.45, color: [109, 180, 255], alpha: 0.08, parallax: 0.02 },
    { x: 0.55, y: 1.1, rx: 0.45, ry: 0.5, color: [180, 110, 220], alpha: 0.06, parallax: 0.015 },
  ];

  let dpr = 1;
  let cssWidth = 0;
  let cssHeight = 0;
  let pageHeight = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssWidth = window.innerWidth;
    cssHeight = window.innerHeight;
    pageHeight = Math.max(document.documentElement.scrollHeight, cssHeight);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    schedule();
  }

  // Wrap a normalized y so it stays in [0, 1).
  function wrap(y) {
    return ((y % 1) + 1) % 1;
  }

  function render() {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const scrollY = window.scrollY || 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Nebulae underneath. Their y wraps the same way as stars.
    // Sized by vmin so their shape is governed by the n.rx/ry ratio
    // alone — not pulled wide on landscape or tall on portrait.
    //
    // ctx.filter blur smears 8-bit alpha bands together — gradients
    // at alpha ~0.08 quantize to ~20 distinct steps in the 0-255
    // range, which the eye reads as "crisp lines" between bands.
    // 4-6px blur smudges the band boundaries enough to disappear.
    const vmin = Math.min(cssWidth, cssHeight);
    ctx.filter = "blur(6px)";
    for (const n of nebulae) {
      const y = wrap(n.y - (scrollY * n.parallax) / pageHeight) * cssHeight;
      const cx = n.x * cssWidth;
      const rx = n.rx * vmin;
      const ry = n.ry * vmin;
      const r = Math.max(rx, ry);
      ctx.save();
      ctx.translate(cx, y);
      ctx.scale(rx / r, ry / r);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      const [cr, cg, cb] = n.color;
      // Multi-stop with an exponential-ish falloff. Two stops produces
      // a Mach band at the gradient end where the alpha derivative
      // snaps to zero, visible as a "crisp line" — extra stops smooth
      // the curve so the derivative tapers gradually.
      grad.addColorStop(0, `rgba(${cr},${cg},${cb},${n.alpha})`);
      grad.addColorStop(0.18, `rgba(${cr},${cg},${cb},${n.alpha * 0.6})`);
      grad.addColorStop(0.4, `rgba(${cr},${cg},${cb},${n.alpha * 0.25})`);
      grad.addColorStop(0.7, `rgba(${cr},${cg},${cb},${n.alpha * 0.06})`);
      grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    }

    // Stars on top — reset the blur filter so they stay crisp.
    ctx.filter = "none";
    for (const s of stars) {
      const y = wrap(s.y - (scrollY * s.parallax) / pageHeight) * cssHeight;
      const x = s.x * cssWidth;
      const [cr, cg, cb] = s.color;
      if (s.halo) {
        const haloR = s.radius * 4;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, haloR);
        grad.addColorStop(0, `rgba(${cr},${cg},${cb},${s.alpha})`);
        grad.addColorStop(0.25, `rgba(${cr},${cg},${cb},${s.alpha * 0.35})`);
        grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, haloR, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(${cr},${cg},${cb},${s.alpha})`;
        ctx.beginPath();
        ctx.arc(x, y, s.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // rAF throttle — collapse multiple scroll events into one paint per
  // frame. Passive scroll listener so we never block the compositor.
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      render();
    });
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 80);
  });
  window.addEventListener("scroll", schedule, { passive: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", resize);
  } else {
    resize();
  }
})();
