import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { AllocatedAppointment } from '../allocation.service';

export class AppointmentResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['CONFIRMED', 'CANCELLED'] })
  status!: 'CONFIRMED' | 'CANCELLED';

  @ApiProperty({ format: 'uuid' })
  customerId!: string;

  @ApiProperty({ format: 'uuid' })
  vehicleId!: string;

  @ApiProperty({ format: 'uuid' })
  serviceTypeId!: string;

  @ApiProperty({ format: 'uuid', description: 'The technician the system allocated.' })
  technicianId!: string;

  @ApiProperty({ format: 'uuid', description: 'The service bay the system allocated.' })
  serviceBayId!: string;

  @ApiProperty({ format: 'date-time', description: 'Window start (UTC).' })
  startTime!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Window end (UTC) = start + the service type’s duration. Exclusive.',
  })
  endTime!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  cancelledAt?: string | null;

  static from(appointment: AllocatedAppointment): AppointmentResponse {
    return {
      id: appointment.id,
      status: appointment.status,
      customerId: appointment.customerId,
      vehicleId: appointment.vehicleId,
      serviceTypeId: appointment.serviceTypeId,
      technicianId: appointment.technicianId,
      serviceBayId: appointment.serviceBayId,
      startTime: appointment.startTime.toISOString(),
      endTime: appointment.endTime.toISOString(),
      createdAt: appointment.createdAt.toISOString(),
    };
  }
}
