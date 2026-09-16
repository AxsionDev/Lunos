import { Component, signal } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';
import { ContactApiService } from '../../../core/contact-api.service';
import { RequestState, idle, loading, loaded, failed } from '../../../core/request-state';

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

@Component({
  selector: 'lunos-contact',
  standalone: true,
  imports: [NavBarComponent, FooterComponent],
  template: `
    <lunos-nav-bar />
    <main class="contact">
      <h1>Design-partner / Contact</h1>

      @if (state().status === 'loaded') {
        <p class="success">Thanks — we'll be in touch.</p>
      } @else {
        <form (submit)="onSubmit($event)">
          <label>
            Email
            <input type="email" [value]="email()" (input)="email.set($any($event.target).value)" />
          </label>
          <label>
            What are you evaluating this for?
            <textarea [value]="message()" (input)="message.set($any($event.target).value)"></textarea>
          </label>
          @if (state().status === 'error') {
            <p class="error-text">{{ errorMessage() }}</p>
          }
          <button type="submit" [disabled]="state().status === 'loading'">
            {{ state().status === 'loading' ? 'Sending…' : 'Send' }}
          </button>
        </form>
      }
    </main>
    <lunos-footer />
  `,
  styles: `
    .contact { max-width: 480px; margin: 0 auto; padding: 2rem; }
    label { display: block; margin-bottom: 1rem; color: var(--subtext1); }
    input, textarea { width: 100%; background: var(--surface0); border: 1px solid var(--surface1); color: var(--text); padding: 0.5rem; border-radius: 4px; }
    .error-text { color: var(--peach); }
    .success { color: var(--green); }
  `,
})
export class ContactComponent {
  readonly email = signal('');
  readonly message = signal('');
  readonly state = signal<RequestState<{ id: string }>>(idle());

  constructor(private readonly contactApi: ContactApiService) {}

  errorMessage(): string {
    const current = this.state();
    return current.status === 'error' ? current.message : '';
  }

  onSubmit(event: Event): void {
    event.preventDefault();
    this.submit();
  }

  submit(): void {
    if (!EMAIL_PATTERN.test(this.email())) {
      this.state.set(failed('Enter a valid email address.'));
      return; // no HTTP call is made — validation fails before contactApi.submit() is ever invoked
    }
    if (this.message().trim().length === 0) {
      this.state.set(failed('Message is required.'));
      return;
    }

    this.state.set(loading());
    this.contactApi.submit({ email: this.email(), message: this.message() }).subscribe({
      next: (response) => this.state.set(loaded(response)),
      error: () => this.state.set(failed('Something went wrong — please try again.')),
    });
  }
}
