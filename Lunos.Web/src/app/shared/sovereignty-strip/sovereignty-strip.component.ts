import { Component, Input } from '@angular/core';

@Component({
  selector: 'lunos-sovereignty-strip',
  standalone: true,
  template: `<div class="strip"><p><span class="emphasis">{{ statement }}</span></p></div>`,
  styles: `
    .strip {
      background: var(--mantle);
      border-top: 1px solid var(--surface1);
      border-bottom: 1px solid var(--surface1);
      padding: 1.5rem 2rem;
      text-align: center;
      color: var(--subtext1);
      font-family: var(--font-sans);
    }
    .emphasis { color: var(--peach); }
  `,
})
export class SovereigntyStripComponent {
  @Input({ required: true }) statement!: string;
}
