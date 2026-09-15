import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ContactComponent } from './contact.component';
import { environment } from '../../../../environments/environment';

describe('ContactComponent', () => {
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ContactComponent, HttpClientTestingModule],
      providers: [provideRouter([])],
    });
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('blocks submission and sends no HTTP request when the email is invalid', () => {
    const fixture = TestBed.createComponent(ContactComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.email.set('not-an-email');
    component.message.set('Evaluating this for a pilot.');
    component.submit();

    httpMock.expectNone(() => true); // asserts zero HTTP calls were made, not just that the visible outcome looks right
    expect(component.state().status).toBe('error');
  });

  it('submits and transitions to loaded on success', () => {
    const fixture = TestBed.createComponent(ContactComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.email.set('dev@example.com');
    component.message.set('Evaluating this for a pilot.');
    component.submit();

    expect(component.state().status).toBe('loading');

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/contact`);
    req.flush({ id: '11111111-1111-1111-1111-111111111111' });

    expect(component.state().status).toBe('loaded');
  });

  it('transitions to error with a retry path on API failure', () => {
    const fixture = TestBed.createComponent(ContactComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.email.set('dev@example.com');
    component.message.set('Evaluating this for a pilot.');
    component.submit();

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/contact`);
    req.flush({ error: { code: 'internal_error', message: 'boom' } }, { status: 500, statusText: 'Server Error' });

    expect(component.state().status).toBe('error');
  });
});
