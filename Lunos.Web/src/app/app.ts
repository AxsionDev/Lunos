import { Component, signal } from '@angular/core';

@Component({
  imports: [],
  selector: 'lunos-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('Lunos.Web');
}
