import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { DatasetsPageComponent } from './features/datasets/datasets-page.component';

const routes: Routes = [
  {
    path: '',
    component: DatasetsPageComponent,
  },
];

@NgModule({
  imports: [RouterModule.forRoot(routes, { useHash: true })],
  exports: [RouterModule],
})
export class AppRoutingModule {}
