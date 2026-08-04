import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CancelAppointmentDto {
  @ApiPropertyOptional({
    description: 'Optional free-text reason, stored on the appointment for audit.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
