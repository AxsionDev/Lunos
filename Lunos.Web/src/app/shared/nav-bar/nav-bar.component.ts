import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'lunos-nav-bar',
  standalone: true,
  imports: [RouterLink],
  template: `
    <nav class="nav-bar">
      <a routerLink="/" class="wordmark">lunos</a>
      <div class="nav-links">
        <a routerLink="/product">Product</a>
        <a routerLink="/roadmap">Roadmap</a>
        <a routerLink="/docs">Docs</a>
        <a routerLink="/sovereignty">Sovereignty</a>
        <a routerLink="/faq">FAQ</a>
        <a routerLink="/changelog">Changelog</a>
        <a routerLink="/about">About</a>
        <!-- Marketplace link intentionally omitted: not built until Phase 2, don't link to a 404. -->
      </div>
      <a routerLink="/docs" class="install-cta">$ install</a>
    </nav>
  `,
  styles: `
    .nav-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 2rem;
      background: var(--crust);
    }
    .wordmark {
      font-family: var(--font-mono);
      font-weight: 700;
      color: var(--text);
      text-decoration: none;
    }
    .nav-links {
      display: flex;
      gap: 1.5rem;
    }
    .nav-links a {
      color: var(--subtext1);
      text-decoration: none;
      font-family: var(--font-sans);
    }
    .install-cta {
      font-family: var(--font-mono);
      color: var(--crust);
      background: var(--mauve);
      padding: 0.4rem 0.9rem;
      border-radius: 4px;
      text-decoration: none;
    }
    @media (max-width: 640px) {
      .nav-links { display: none; }
    }
  `,
})
export class NavBarComponent {}
