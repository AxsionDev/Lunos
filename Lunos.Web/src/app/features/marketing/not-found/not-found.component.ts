import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';

@Component({
  selector: 'lunos-not-found',
  standalone: true,
  imports: [NavBarComponent, RouterLink],
  template: `
    <lunos-nav-bar />
    <main class="not-found">
      <h1>404</h1>
      <p>That page doesn't exist. <a routerLink="/">Back home</a>.</p>
    </main>
  `,
  styles: `.not-found { text-align: center; padding: 4rem; }`,
})
export class NotFoundComponent {}
