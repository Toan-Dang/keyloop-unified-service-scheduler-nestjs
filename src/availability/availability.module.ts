import { Module } from '@nestjs/common';
import { AvailabilityService } from './availability.service';

@Module({
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
