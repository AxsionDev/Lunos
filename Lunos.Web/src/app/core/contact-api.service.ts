import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface ContactPayload {
  email: string;
  message: string;
  context?: string;
}

export interface ContactResponse {
  id: string;
}

@Injectable({ providedIn: 'root' })
export class ContactApiService {
  constructor(private readonly http: HttpClient) {}

  submit(payload: ContactPayload): Observable<ContactResponse> {
    return this.http.post<ContactResponse>(`${environment.apiBaseUrl}/contact`, payload);
  }
}
