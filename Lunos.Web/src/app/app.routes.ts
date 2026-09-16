import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./features/marketing/home/home.component').then(m => m.HomeComponent) },
  { path: 'product', loadComponent: () => import('./features/marketing/product/product.component').then(m => m.ProductComponent) },
  { path: 'roadmap', loadComponent: () => import('./features/marketing/roadmap/roadmap.component').then(m => m.RoadmapComponent) },
  { path: 'docs', loadComponent: () => import('./features/marketing/docs-install/docs-install.component').then(m => m.DocsInstallComponent) },
  { path: 'sovereignty', loadComponent: () => import('./features/marketing/sovereignty/sovereignty.component').then(m => m.SovereigntyComponent) },
  { path: 'faq', loadComponent: () => import('./features/marketing/faq/faq.component').then(m => m.FaqComponent) },
  { path: 'changelog', loadComponent: () => import('./features/marketing/changelog/changelog.component').then(m => m.ChangelogComponent) },
  { path: 'contact', loadComponent: () => import('./features/marketing/contact/contact.component').then(m => m.ContactComponent) },
  { path: 'about', loadComponent: () => import('./features/marketing/about/about.component').then(m => m.AboutComponent) },
  { path: 'license', loadComponent: () => import('./features/marketing/license/license.component').then(m => m.LicenseComponent) },
  // '/marketplace', '/marketplace/:id', '/plugins', '/plugins/:id' are Phase 2 — do not add until Phase 2 starts.
  { path: '**', loadComponent: () => import('./features/marketing/not-found/not-found.component').then(m => m.NotFoundComponent) },
];
