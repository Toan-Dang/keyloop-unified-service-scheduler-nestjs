import { Module } from '@nestjs/common';
import { AvailabilityController } from './availability.controller';
import { AvailabilityPreviewService } from './availability-preview.service';
import { AvailabilityService } from './availability.service';

@Module({
  controllers: [AvailabilityController],
  providers: [AvailabilityService, AvailabilityPreviewService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
