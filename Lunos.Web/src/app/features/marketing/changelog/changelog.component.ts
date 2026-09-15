import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';

@Component({
  selector: 'lunos-changelog',
  standalone: true,
  imports: [NavBarComponent, FooterComponent],
  template: `
    <lunos-nav-bar />
    <main>
      <h1>Changelog</h1>
      <!-- COPY PENDING: build-in-public log entries — source from Jira release notes per PRD §7, same source as the Roadmap page. -->
    </main>
    <lunos-footer />
  `,
})
export class ChangelogComponent {}
