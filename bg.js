// Fullscreen fragment-shader background. Two looks shipped:
//   "lanes" — vertical SIMD-pipeline lanes with comet-shaped pulses.
//   "grid"  — compute-fabric tile heatmap; cells fire as if dispatched.
// User toggles between them via #bg-fab; choice persists in localStorage
// under "parabun-bg". Both share the same uniforms (time, resolution,
// scroll position, scroll velocity, cursor) so the toggle is a pure
// program swap inside the same rAF loop.
//
// Renders at half-resolution and CSS-upscales for free bokeh. Single
// frame under prefers-reduced-motion, paused when the tab is hidden,
// skipped entirely if WebGL is unavailable — html's solid --bg is the
// always-safe fallback.
(() => {
  const canvas = document.getElementById("bg-canvas");
  if (!canvas) return;

  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  });
  if (!gl) return;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scale = 0.5;

  const VS = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

  // Shared uniform block, repeated at the top of each fragment shader.
  const COMMON = `
precision mediump float;
uniform float u_time;
uniform vec2  u_res;
uniform float u_scroll;
uniform float u_vel;
uniform vec2  u_cursor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float hash1(float n) {
  return fract(sin(n * 17.5341) * 43758.5453);
}
`;

  // -----------------------------------------------------------------
  // LANES — N vertical pipelines. Each lane is a thin baseline rule
  // with a single comet-shaped pulse cycling top-to-bottom. Pulse
  // speed and phase vary per lane (deterministic from laneIdx) so
  // the pattern looks alive without coordinated flashes. Cursor
  // boosts the warm head; scroll velocity speeds every pulse.
  // -----------------------------------------------------------------
  const FS_LANES =
    COMMON +
    `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  float aspect = u_res.x / u_res.y;

  // Wider screens get more lanes so density stays roughly constant.
  float N = floor(aspect * 14.0 + 6.0);   // ~24 lanes at 16:9, ~14 on portrait
  float laneIdx = floor(uv.x * N);
  float laneCenter = (laneIdx + 0.5) / N;
  // dxPx is in canvas pixels; canvas is half-res so /2 ≈ CSS px.
  float dxPx = abs(uv.x - laneCenter) * u_res.x;
  // Baseline rule line, ~2 canvas-px wide.
  float laneLine = exp(-dxPx * dxPx / 4.0);

  float seedSpeed  = hash1(laneIdx);
  float seedPhase  = hash1(laneIdx + 13.7);
  float seedBright = hash1(laneIdx + 27.3);

  // Pulse moves down (toward smaller uv.y, since gl_FragCoord origin
  // is bottom-left). Speed: 0.15..0.45 cycles/sec, +scroll velocity.
  float speed = 0.15 + seedSpeed * 0.30 + u_vel * 0.5;
  float pulsePos = fract(u_time * speed + seedPhase);
  float pulseY = 1.0 - pulsePos;

  // Comet shape: short sharp head, long soft trail above.
  float dy = uv.y - pulseY;
  float headLen = 0.012;
  float tailLen = 0.10;
  float lenSq = mix(headLen * headLen, tailLen * tailLen, step(0.0, dy));
  float pulse = exp(-dy * dy / lenSq);

  // Cursor brightens whatever lane(s) it's near (aspect-corrected).
  vec2 dCur = (uv - u_cursor) * vec2(aspect, 1.0);
  float cursorBoost = exp(-dot(dCur, dCur) * 5.0);

  vec3 base     = vec3(0.030, 0.030, 0.038);
  vec3 laneCol  = vec3(0.090, 0.080, 0.140);   // dim violet
  vec3 pulseCol = vec3(0.962, 0.690, 0.254);   // --accent

  vec3 col = base;
  col += laneCol * laneLine * (0.45 + 0.35 * seedBright);
  col += pulseCol * laneLine * pulse * (0.85 + cursorBoost * 0.6);

  gl_FragColor = vec4(col, 1.0);
}
`;

  // -----------------------------------------------------------------
  // GRID — fixed-pixel cells (so they look square regardless of
  // aspect ratio). Only ~30% of cells are "active"; each active
  // cell pulses sharply on its own period (sin^18 = thin spikes).
  // Cursor area boosts spike intensity; scroll velocity flashes the
  // whole field briefly.
  // -----------------------------------------------------------------
  const FS_GRID =
    COMMON +
    `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  float aspect = u_res.x / u_res.y;

  const float CELL_PX = 16.0; // canvas pixels — 32 CSS px after upscale
  vec2 cellPx = gl_FragCoord.xy / CELL_PX;
  vec2 cell = floor(cellPx);
  vec2 inCell = fract(cellPx);

  // Square cell mask with a small gutter so the grid reads as tiles.
  vec2 d = abs(inCell - 0.5);
  float cellD = max(d.x, d.y);
  float cellMask = smoothstep(0.46, 0.40, cellD);

  // Per-cell parameters. seed/seed2 differ from the active mask so
  // active cells aren't biased to certain timings.
  float seed   = hash(cell);
  float seed2  = hash(cell + vec2(31.7, 17.3));
  float active = step(0.70, hash(cell + vec2(99.1, 77.7)));

  // Sharp-spike pulse — sin^18 is essentially zero except for a
  // brief flash near each peak. Period 1.8..6.8s.
  float period = 1.8 + seed2 * 5.0;
  float phase  = seed * 6.28318;
  float spike  = pow(max(0.0, sin(u_time / period * 6.28318 + phase)), 18.0);

  // Cursor boosts both spike intensity and the baseline brightness
  // around the pointer, so the cells beneath it always read warm.
  vec2 dCur = (uv - u_cursor) * vec2(aspect, 1.0);
  float cursorBoost = exp(-dot(dCur, dCur) * 5.0);
  spike *= 1.0 + cursorBoost * 1.6;

  // Scrolling momentarily kicks every cell.
  spike *= 1.0 + u_vel * 0.5;

  vec3 base     = vec3(0.030, 0.030, 0.038);
  vec3 cellCool = vec3(0.090, 0.080, 0.140);
  vec3 cellHot  = vec3(0.962, 0.690, 0.254);

  vec3 col = base;
  col += cellCool * cellMask * (0.30 + cursorBoost * 0.25);
  col += cellHot  * cellMask * active * spike * 0.85;

  gl_FragColor = vec4(col, 1.0);
}
`;

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("bg.js shader compile failed:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };

  // Returns { prog, uTime, uRes, uScroll, uVel, uCursor } or null.
  const buildProgram = (fsSrc) => {
    const vs = compile(gl.VERTEX_SHADER, VS);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    // Lock a_pos to attribute location 0 in both programs so the same
    // vertex pointer state works for either active program.
    gl.bindAttribLocation(prog, 0, "a_pos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("bg.js program link failed:", gl.getProgramInfoLog(prog));
      return null;
    }
    return {
      prog,
      uTime: gl.getUniformLocation(prog, "u_time"),
      uRes: gl.getUniformLocation(prog, "u_res"),
      uScroll: gl.getUniformLocation(prog, "u_scroll"),
      uVel: gl.getUniformLocation(prog, "u_vel"),
      uCursor: gl.getUniformLocation(prog, "u_cursor"),
    };
  };

  const lanes = buildProgram(FS_LANES);
  const grid = buildProgram(FS_GRID);
  if (!lanes || !grid) return;

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  let active = (() => {
    try {
      return localStorage.getItem("parabun-bg") === "grid" ? grid : lanes;
    } catch {
      return lanes;
    }
  })();

  const resize = () => {
    const w = Math.max(1, Math.floor(window.innerWidth * scale));
    const h = Math.max(1, Math.floor(window.innerHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  };
  resize();
  addEventListener("resize", resize, { passive: true });

  let lastY = window.scrollY;
  let vel = 0;
  let cursorX = 0.5;
  let cursorY = 0.5;
  let cursorTargetX = 0.5;
  let cursorTargetY = 0.5;
  addEventListener(
    "mousemove",
    (e) => {
      cursorTargetX = e.clientX / window.innerWidth;
      cursorTargetY = 1 - e.clientY / window.innerHeight;
    },
    { passive: true },
  );

  const start = performance.now();
  let revealed = false;

  const draw = (tMs) => {
    const y = window.scrollY;
    const target = Math.min(1, Math.abs(y - lastY) / 12);
    vel = Math.max(vel * 0.92, target);
    lastY = y;

    cursorX += (cursorTargetX - cursorX) * 0.12;
    cursorY += (cursorTargetY - cursorY) * 0.12;

    gl.useProgram(active.prog);
    gl.uniform1f(active.uTime, (tMs - start) / 1000);
    gl.uniform2f(active.uRes, canvas.width, canvas.height);
    gl.uniform1f(active.uScroll, y);
    gl.uniform1f(active.uVel, vel);
    gl.uniform2f(active.uCursor, cursorX, cursorY);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (!revealed) {
      revealed = true;
      canvas.classList.add("ready");
    }
  };

  // FAB hookup. The HTML ships with the lanes label as default; sync()
  // overrides it from the loaded preference, then click toggles + saves.
  const fab = document.getElementById("bg-fab");
  if (fab) {
    const sync = () => {
      const isGrid = active === grid;
      fab.textContent = isGrid ? "bg: grid" : "bg: lanes";
      fab.setAttribute("aria-pressed", isGrid ? "true" : "false");
    };
    sync();
    fab.addEventListener("click", () => {
      active = active === lanes ? grid : lanes;
      try {
        localStorage.setItem("parabun-bg", active === grid ? "grid" : "lanes");
      } catch {}
      sync();
    });
  }

  if (reduced) {
    draw(performance.now());
    return;
  }

  let raf = 0;
  const loop = (t) => {
    if (!document.hidden) draw(t);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) raf = requestAnimationFrame(loop);
  });
})();
