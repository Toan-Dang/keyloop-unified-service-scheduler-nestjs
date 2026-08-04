import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Validates `:id` path params so a malformed uuid is a 400, never a database cast error. */
export class UuidParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;
}
