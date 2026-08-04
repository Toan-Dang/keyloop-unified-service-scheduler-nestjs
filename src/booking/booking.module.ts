import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { AllocationService } from './allocation.service';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

@Module({
  imports: [AvailabilityModule],
  controllers: [BookingController],
  providers: [AllocationService, BookingService],
  exports: [BookingService, AllocationService],
})
export class BookingModule {}
