import { useEffect, useRef } from "react";

const PRISM = ["#00b8d9", "#6d3df5", "#f0268f", "#f59300"];
const LINES = 12;

/** Thin lines of coloured light drift behind the page, with money moves travelling along them. Sits behind everything and takes no clicks. */
export function FlowBackground() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let w = 0, h = 0, frame = 0, last = 0;
    let gradients: CanvasGradient[] = [];
    const resize = () => {
      const k = Math.min(devicePixelRatio || 1, 1.5);
      w = innerWidth; h = innerHeight;
      canvas.width = w * k; canvas.height = h * k;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      gradients = Array.from({ length: LINES }, (_, i) => {
        const g = ctx.createLinearGradient(0, 0, w, 0);
        PRISM.forEach((c, n) => g.addColorStop(((n + i) % PRISM.length) / (PRISM.length - 1), c));
        return g;
      });
    };
    const curve = (x: number, i: number, t: number) => {
      const y0 = (h * (i + 0.5)) / LINES;
      return y0 + 46 * Math.sin(x * 0.0031 + t * 0.32 + i * 1.3) + 22 * Math.sin(x * 0.0083 - t * 0.5 + i * 2.1);
    };
    const draw = (t: number) => {
      const dark = document.documentElement.classList.contains("dark");
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 1;
      for (let i = 0; i < LINES; i++) {
        ctx.strokeStyle = gradients[i];
        ctx.globalAlpha = dark ? 0.28 : 0.34;
        ctx.beginPath();
        for (let x = -20; x <= w + 20; x += 20) { const y = curve(x, i, t); if (x < 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        ctx.stroke();
        ctx.fillStyle = PRISM[i % PRISM.length];
        ctx.globalAlpha = dark ? 0.75 : 0.7;
        for (let n = 0; n < 3; n++) {
          const x = ((t * (46 + i * 7) + n * 613 + i * 257) % (w + 80)) - 40;
          ctx.beginPath(); ctx.arc(x, curve(x, i, t), 2.4, 0, 6.2832); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };
    resize();
    addEventListener("resize", resize);
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The demo film steps this by its own clock, one frame at a time.
    const filmed = "__filmInit" in window;
    (window as unknown as { __flow?: (t: number) => void }).__flow = draw;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      if (document.hidden || now - last < 33) return;
      last = now;
      draw(now / 1000);
    };
    if (still || filmed) draw(40);
    else frame = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(frame); removeEventListener("resize", resize); };
  }, []);
  return <canvas ref={ref} className="flow-background" aria-hidden="true" />;
}
