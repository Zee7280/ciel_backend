import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Setting } from './entities/setting.entity';
import { PlatformSettingsService } from './platform-settings.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Setting])],
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class PlatformSettingsModule {}
