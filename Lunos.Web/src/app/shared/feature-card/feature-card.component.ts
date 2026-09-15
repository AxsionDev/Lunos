import { Component, Input } from '@angular/core';

@Component({
  selector: 'lunos-feature-card',
  standalone: true,
  template: `
    <article class="card">
      <span class="phase-tag">{{ phase }}</span>
      <h3>{{ heading }}</h3>
      <p>{{ body }}</p>
    </article>
  `,
  styles: `
    .card {
      background: var(--surface0);
      border: 1px solid var(--surface1);
      border-radius: 8px;
      padding: 1.5rem;
    }
    .phase-tag {
      display: inline-block;
      font-family: var(--font-mono);
      background: var(--mauve);
      color: var(--crust);
      padding: 0.15rem 0.6rem;
      border-radius: 999px;
      font-size: 0.75rem;
      margin-bottom: 0.75rem;
    }
    h3 { color: var(--text); font-family: var(--font-sans); }
    p { color: var(--subtext0); }
  `,
})
export class FeatureCardComponent {
  @Input({ required: true }) phase!: string;
  @Input({ required: true }) heading!: string;
  @Input({ required: true }) body!: string;
}
