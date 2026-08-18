import { Controller, Get, Head, HttpCode } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) { }

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /** Quiet probe requests to raw backend host (Vercel); real favicon lives on the web app. */
  @Get('favicon.ico')
  @Head('favicon.ico')
  @HttpCode(204)
  favicon(): void {
    return;
  }
}
