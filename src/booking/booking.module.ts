import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { AllocationService } from './allocation.service';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

@Module({
  imports: [AvailabilityModule],
  // BookingController owns POST /appointments; AppointmentsController owns GET /appointments,
  // GET /appointments/:id and POST /appointments/:id/cancel. No method+path pair overlaps
  // between them, so — unlike a case where two controllers register the same route — this
  // array's order is not load-bearing for routing today.
  controllers: [BookingController, AppointmentsController],
  providers: [AllocationService, BookingService, AppointmentsService],
  exports: [BookingService, AllocationService, AppointmentsService],
})
export class BookingModule {}
