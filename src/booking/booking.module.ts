import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { AllocationService } from './allocation.service';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

@Module({
  imports: [AvailabilityModule],
  // BookingController is listed first so POST /appointments is matched before the
  // AppointmentsController routes; Nest resolves in declaration order.
  controllers: [BookingController, AppointmentsController],
  providers: [AllocationService, BookingService, AppointmentsService],
  exports: [BookingService, AllocationService, AppointmentsService],
})
export class BookingModule {}
