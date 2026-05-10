import { Controller, Get, Header } from '@nestjs/common';
import { TutorialsService } from './tutorials.service';

/**
 * Anonymous read of published tutorials (homepage / marketing). Same payload as authenticated list.
 */
@Controller('public/tutorials')
export class PublicPlatformTutorialsController {
    constructor(private readonly tutorialsService: TutorialsService) {}

    @Get()
    @Header('Cache-Control', 'public, max-age=60, s-maxage=120, stale-while-revalidate=300')
    list() {
        return this.tutorialsService.listForStudents();
    }
}
