import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';
import { FeatureCardComponent } from '../../../shared/feature-card/feature-card.component';

@Component({
  selector: 'lunos-roadmap',
  standalone: true,
  imports: [NavBarComponent, FooterComponent, FeatureCardComponent],
  template: `
    <lunos-nav-bar />
    <main class="grid">
      <h1>Roadmap</h1>
      <!-- COPY PENDING: five-phase roadmap content mirrors product-vision-roadmap.md's current shipped/in-progress state; generate from the same source as the Jira-derived release notes per PRD §7, not hand-duplicated. -->
    </main>
    <lunos-footer />
  `,
  styles: `.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; padding: 2rem; } @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }`,
})
export class RoadmapComponent {}
