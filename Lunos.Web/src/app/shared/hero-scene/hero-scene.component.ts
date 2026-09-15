import { Component } from '@angular/core';

@Component({
  selector: 'lunos-hero-scene',
  standalone: true,
  template: `
    <section class="hero">
      <p class="eyebrow">SOVEREIGN AI TOOLING</p>
      <h1 class="wordmark">lunos</h1>
      <p class="tagline">Own your AI coding agent, end to end.</p>
      <div class="scene" aria-hidden="true">
        <div class="cloud cloud-a"></div>
        <div class="cloud cloud-b"></div>
        <div class="moon"></div>
        <div class="water"></div>
        <div class="reflection"></div>
      </div>
      <div class="terminal-card">
        <span class="prompt">$ curl -fsSL https://lunos.tech/install.sh | sh</span><span class="cursor">▌</span>
      </div>
    </section>
  `,
  styles: `
    .hero {
      text-align: center;
      padding: 4rem 1rem;
      background: var(--crust);
    }
    .eyebrow {
      font-family: var(--font-mono);
      text-transform: uppercase;
      color: var(--sapphire);
      letter-spacing: 0.08em;
      font-size: 0.85rem;
    }
    .wordmark {
      font-family: var(--font-mono);
      font-weight: 700;
      font-size: clamp(40px, 8vw, 72px);
      color: var(--text);
      margin: 0.5rem 0;
    }
    .tagline {
      color: var(--subtext1);
      font-family: var(--font-sans);
    }
    .scene {
      position: relative;
      height: 220px;
      margin: 2rem auto;
      max-width: 640px;
    }
    .cloud {
      position: absolute;
      background: var(--lavender);
      filter: blur(12px);
      opacity: 0.5;
      border-radius: 50%;
    }
    .cloud-a { width: 140px; height: 40px; top: 10px; left: 10%; }
    .cloud-b { width: 100px; height: 30px; top: 40px; right: 15%; }
    .moon {
      position: absolute;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      width: 70px;
      height: 70px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 35%, var(--yellow), var(--peach));
      box-shadow: 0 0 40px 10px var(--peach);
    }
    .water {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 40%;
      background: var(--surface0);
      border-top: 1px solid var(--overlay0);
    }
    .reflection {
      position: absolute;
      bottom: 5px;
      left: 50%;
      transform: translateX(-50%);
      width: 40px;
      height: 20px;
      border-radius: 50%;
      background: var(--peach);
      opacity: 0.4;
      animation: shimmer 2.6s ease-in-out infinite;
    }
    @keyframes shimmer {
      0% { opacity: 0.4; }
      50% { opacity: 0.95; }
      100% { opacity: 0.4; }
    }
    @media (prefers-reduced-motion: reduce) {
      .reflection { animation: none; opacity: 0.6; }
    }
    .terminal-card {
      display: inline-block;
      background: var(--mantle);
      color: var(--green);
      font-family: var(--font-mono);
      padding: 0.75rem 1.25rem;
      border-radius: 6px;
      border: 1px solid var(--surface1);
    }
    .cursor {
      animation: blink 1s step-end infinite;
    }
    @keyframes blink {
      50% { opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .cursor { animation: none; }
    }
  `,
})
export class HeroSceneComponent {}
