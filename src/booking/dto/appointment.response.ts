import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The row shape every appointment read returns. */
export interface AppointmentRow {
  id: string;
  dealershipId: string;
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  technicianId: string;
  serviceBayId: string;
  startTime: Date;
  endTime: Date;
  status: 'CONFIRMED' | 'CANCELLED';
  idempotencyKey?: string | null;
  requestHash?: string | null;
  cancelledAt?: Date | null;
  cancelReason?: string | null;
  createdAt: Date;
}

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

  @ApiProperty({ format: 'date-time', description: 'Window start (UTC), inclusive.' })
  startTime!: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'Window end (UTC) = start + the service type’s duration. **Exclusive** — an appointment ' +
      'ending at 10:00 does not conflict with one starting at 10:00.',
  })
  endTime!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  cancelledAt?: string | null;

  @ApiPropertyOptional({ nullable: true })
  cancelReason?: string | null;

  static from(appointment: AppointmentRow): AppointmentResponse {
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
      cancelledAt: appointment.cancelledAt ? appointment.cancelledAt.toISOString() : null,
      cancelReason: appointment.cancelReason ?? null,
    };
  }
}

export class AppointmentPageResponse {
  @ApiProperty({ type: [AppointmentResponse] })
  items!: AppointmentResponse[];

  @ApiProperty({
    nullable: true,
    description:
      'Opaque keyset cursor for the next page, or null when this is the last page. Pass it back ' +
      'as `?cursor=`.',
  })
  nextCursor!: string | null;
}
