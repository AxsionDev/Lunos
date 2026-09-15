import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';
import { HeroSceneComponent } from '../../../shared/hero-scene/hero-scene.component';
import { SovereigntyStripComponent } from '../../../shared/sovereignty-strip/sovereignty-strip.component';

@Component({
  selector: 'lunos-home',
  standalone: true,
  imports: [NavBarComponent, FooterComponent, HeroSceneComponent, SovereigntyStripComponent],
  template: `
    <lunos-nav-bar />
    <lunos-hero-scene />
    <lunos-sovereignty-strip
      statement="lunos.tech itself runs on self-hosted EU infrastructure — the sovereignty pitch, checkable." />
    <lunos-footer />
  `,
})
export class HomeComponent {}
