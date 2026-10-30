// Shared helpers: a shot fades in and out and drifts slowly, driven only by the scene clock so every frame is reproducible.
const clamp = (v) => Math.max(0, Math.min(1, v));
const smooth = (p) => p * p * (3 - 2 * p);
function shot(id, t, from, to, { fade = 0.9, zoom = [1.09, 1.0], drift = [0, 0] } = {}) {
  const el = document.getElementById(id), img = el.querySelector('img');
  el.style.opacity = smooth(clamp((t - from) / fade)) * (1 - smooth(clamp((t - to) / fade)));
  const p = clamp((t - from) / (to + fade - from));
  img.style.transform = `translate(${drift[0] * p}px, ${drift[1] * p}px) scale(${zoom[0] + (zoom[1] - zoom[0]) * p})`;
}
function rise(id, t, at, dist = 22, dur = 0.8) {
  const e = document.getElementById(id), p = smooth(clamp((t - at) / dur));
  e.style.opacity = p; e.style.transform = `${e.dataset.base ?? ''} translateY(${dist * (1 - p)}px)`;
}
function stamp(id, t, at) {
  const e = document.getElementById(id), p = clamp((t - at) / 0.22);
  e.style.opacity = p; e.style.transform = `rotate(-7deg) scale(${1.5 - 0.5 * p * p})`;
}
