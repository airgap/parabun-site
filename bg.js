// Fullscreen fragment-shader nebula. Renders at half-resolution and relies on
// CSS upscale for a free bokeh. Single frame when the user prefers reduced
// motion, paused when the tab is hidden, skipped entirely if WebGL isn't
// available — so the solid --bg on <html> is the always-safe fallback.
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

  // Domain-warped FBM nebula. Muted palette: charcoal base, a cool
  // slate-violet mid, and the site's amber accent as sparse embers.
  const FS = `
precision mediump float;
uniform float u_time;
uniform vec2  u_res;
uniform float u_scroll;   // window.scrollY, raw pixels
uniform float u_vel;      // smoothed scroll velocity, 0..1
uniform vec2  u_cursor;   // smoothed pointer in 0..1 UV space

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash(i),
        b = hash(i + vec2(1.0, 0.0)),
        c = hash(i + vec2(0.0, 1.0)),
        d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 p  = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0) * 2.6;
  // Vertical parallax — the noise field drifts with the scroll direction
  // (like distant stars sliding past behind the content, slower than the
  // foreground). 0.0008 ≈ one shader-unit of shift per ~1250px scroll.
  p.y -= u_scroll * 0.0008;

  // Cursor lensing — pull the noise sampling slightly toward the pointer
  // with a Gaussian falloff. cursor_p gets the same parallax shift as p
  // so the lens stays anchored under the cursor regardless of scroll
  // position; without this, scrolling drifted the lens center away from
  // the pointer and weakened the pull.
  vec2 cursor_p = (u_cursor - 0.5) * vec2(u_res.x / u_res.y, 1.0) * 2.6;
  cursor_p.y -= u_scroll * 0.0008;
  vec2 toCursor = cursor_p - p;
  p += toCursor * 0.18 * exp(-dot(toCursor, toCursor) * 1.5);

  float t = u_time * 0.035;

  vec2 q = vec2(fbm(p + t),
                fbm(p + vec2(5.2, 1.3) - t * 0.6));
  vec2 r = vec2(fbm(p + 3.2 * q + vec2(1.7, 9.2) + t * 0.25),
                fbm(p + 3.2 * q + vec2(8.3, 2.8) - t * 0.4));
  float f = fbm(p + 2.6 * r);

  vec3 base = vec3(0.055, 0.055, 0.070);          // slightly raised charcoal
  vec3 cool = vec3(0.175, 0.115, 0.310);          // saturated deep violet
  vec3 warm = vec3(0.962, 0.690, 0.254);          // --accent #f5b041

  vec3 col = base;
  col = mix(col, cool, smoothstep(0.18, 0.78, f));
  // Scroll velocity briefly brightens the warm embers — the scene feels
  // alive while the user drags the page, settles when they stop.
  col = mix(col, warm, smoothstep(0.52, 0.95, f) * (0.90 + u_vel * 0.55));

  // No vignette: paragraph text is opaque on its own, code blocks have an
  // opaque backdrop, and embers are what make the thing worth having.

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
  const vs = compile(gl.VERTEX_SHADER, VS);
  const fs = compile(gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const aPos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uTime = gl.getUniformLocation(prog, "u_time");
  const uRes = gl.getUniformLocation(prog, "u_res");
  const uScroll = gl.getUniformLocation(prog, "u_scroll");
  const uVel = gl.getUniformLocation(prog, "u_vel");
  const uCursor = gl.getUniformLocation(prog, "u_cursor");

  const resize = () => {
    const w = Math.max(1, Math.floor(window.innerWidth * scale));
    const h = Math.max(1, Math.floor(window.innerHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
    }
  };
  resize();
  addEventListener("resize", resize, { passive: true });

  const start = performance.now();
  let revealed = false;
  let lastY = window.scrollY;
  let vel = 0;
  // Cursor in 0..1 UV space. Default to center so the lens sits in the
  // middle of the field until the user moves the pointer (or never, on
  // touch devices). cursor lerps toward cursorTarget every frame.
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
  const draw = (tMs) => {
    const y = window.scrollY;
    // Target velocity: scroll delta scaled so ~12px/frame saturates at 1
    // (was 35 — too high to register at trackpad speeds). `max(vel * 0.92,
    // target)` snaps velocity up and decays it over ~500ms, giving the
    // oilslick a visible tail after the user stops scrolling.
    const target = Math.min(1, Math.abs(y - lastY) / 12);
    vel = Math.max(vel * 0.92, target);
    lastY = y;

    // Lerp cursor by 0.12/frame — gives the field a touch of inertia,
    // so a quick mouse jerk doesn't translate to a sharp jolt.
    cursorX += (cursorTargetX - cursorX) * 0.12;
    cursorY += (cursorTargetY - cursorY) * 0.12;

    gl.uniform1f(uTime, (tMs - start) / 1000);
    gl.uniform1f(uScroll, y);
    gl.uniform1f(uVel, vel);
    gl.uniform2f(uCursor, cursorX, cursorY);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!revealed) {
      revealed = true;
      canvas.classList.add("ready");
    }
  };

  if (reduced) {
    // One frame and done — still a pretty static nebula.
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
