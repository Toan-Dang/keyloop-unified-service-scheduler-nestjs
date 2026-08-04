import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  DealershipResponse,
  ServiceBayResponse,
  ServiceTypeResponse,
  TechnicianResponse,
} from './dto/resource.response';

@Injectable()
export class ResourcesService {
  constructor(private readonly prisma: PrismaService) {}

  dealerships(dealershipId: string): Promise<DealershipResponse[]> {
    return this.prisma.$queryRawUnsafe<DealershipResponse[]>(
      `SELECT id, name, timezone, opening_hours AS "openingHours"
         FROM dealerships WHERE id = $1::uuid`,
      dealershipId,
    );
  }

  serviceTypes(dealershipId: string): Promise<ServiceTypeResponse[]> {
    return this.prisma.$queryRawUnsafe<ServiceTypeResponse[]>(
      `SELECT id, name, duration_minutes AS "durationMinutes", required_skills AS "requiredSkills"
         FROM service_types WHERE dealership_id = $1::uuid ORDER BY name`,
      dealershipId,
    );
  }

  technicians(dealershipId: string): Promise<TechnicianResponse[]> {
    return this.prisma.$queryRawUnsafe<TechnicianResponse[]>(
      `SELECT id, name, skills, working_hours AS "workingHours", is_active AS "isActive"
         FROM technicians WHERE dealership_id = $1::uuid ORDER BY name`,
      dealershipId,
    );
  }

  serviceBays(dealershipId: string): Promise<ServiceBayResponse[]> {
    return this.prisma.$queryRawUnsafe<ServiceBayResponse[]>(
      `SELECT id, name, is_active AS "isActive"
         FROM service_bays WHERE dealership_id = $1::uuid ORDER BY name`,
      dealershipId,
    );
  }
}
