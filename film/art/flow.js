// The same drifting lines of coloured light as the site's background (web/src/components/FlowBackground.tsx), on the film clock.
const PRISM = ['#00b8d9', '#6d3df5', '#f0268f', '#f59300'], LINES = 12, W = 1920, H = 1080;
export function flow(canvas, alpha = 0.55) {
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  const grads = Array.from({ length: LINES }, (_, i) => { const g = c.createLinearGradient(0, 0, W, 0); PRISM.forEach((p, n) => g.addColorStop(((n + i) % 4) / 3, p)); return g; });
  const y = (x, i, t) => (H * (i + 0.5)) / LINES + 66 * Math.sin(x * 0.0023 + t * 0.32 + i * 1.3) + 30 * Math.sin(x * 0.006 - t * 0.5 + i * 2.1);
  return t => {
    c.clearRect(0, 0, W, H); c.lineWidth = 1.4;
    for (let i = 0; i < LINES; i++) {
      c.strokeStyle = grads[i]; c.globalAlpha = alpha; c.beginPath();
      for (let x = -20; x <= W + 20; x += 20) { const v = y(x, i, t); if (x < 0) c.moveTo(x, v); else c.lineTo(x, v); }
      c.stroke();
      c.fillStyle = PRISM[i % 4]; c.globalAlpha = Math.min(1, alpha * 1.6);
      for (let n = 0; n < 3; n++) { const x = ((t * (90 + i * 13) + n * 813 + i * 257) % (W + 80)) - 40; c.beginPath(); c.arc(x, y(x, i, t), 3.2, 0, 6.2832); c.fill(); }
    }
    c.globalAlpha = 1;
  };
}
