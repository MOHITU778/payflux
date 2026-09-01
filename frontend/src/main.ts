import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

bootstrapApplication(AppComponent, appConfig)
  // A bootstrap failure is otherwise a blank white page with nothing in the console.
  .catch((err) => console.error('PayFlux console failed to bootstrap', err));
