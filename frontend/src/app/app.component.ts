import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastContainerComponent } from './shared/components/toast.component';

/** Root shell: a router outlet plus the global toast host. */
@Component({
  selector: 'pf-root',
  standalone: true,
  imports: [RouterOutlet, ToastContainerComponent],
  template: `
    <router-outlet />
    <pf-toasts />
  `,
})
export class AppComponent {}
