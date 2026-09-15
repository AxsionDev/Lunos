import { Component } from '@angular/core';

@Component({
  selector: 'lunos-footer',
  standalone: true,
  template: `<footer class="footer"><span>lunos · lunos.tech</span></footer>`,
  styles: `
    .footer {
      text-align: center;
      padding: 2rem;
      color: var(--overlay1);
      font-family: var(--font-mono);
    }
  `,
})
export class FooterComponent {}
