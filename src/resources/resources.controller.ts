import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator';
import type { Principal } from '../common/auth/principal';
import {
  DealershipResponse,
  ServiceBayResponse,
  ServiceTypeResponse,
  TechnicianResponse,
} from './dto/resource.response';
import { ResourcesService } from './resources.service';

/**
 * Reference data (§7). Every read is scoped to the caller's dealership — there is no "list all
 * dealerships" for a tenant-bound principal, because from inside a tenant the others do not
 * exist (§14).
 */
@ApiTags('reference')
@ApiBearerAuth('bearer')
@Controller()
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Get('dealerships')
  @ApiOperation({
    summary: 'The caller’s dealership',
    description:
      'Returns the caller’s own dealership only. The tenant comes from the token, so this is ' +
      'never a directory of other dealerships.',
  })
  @ApiOkResponse({ type: [DealershipResponse] })
  dealerships(@CurrentPrincipal() principal: Principal): Promise<DealershipResponse[]> {
    return this.resources.dealerships(principal.dealershipId);
  }

  @Get('service-types')
  @ApiOperation({ summary: 'Service catalogue for the caller’s dealership' })
  @ApiOkResponse({ type: [ServiceTypeResponse] })
  serviceTypes(@CurrentPrincipal() principal: Principal): Promise<ServiceTypeResponse[]> {
    return this.resources.serviceTypes(principal.dealershipId);
  }

  @Get('technicians')
  @ApiOperation({ summary: 'Technicians, with their skills and working hours' })
  @ApiOkResponse({ type: [TechnicianResponse] })
  technicians(@CurrentPrincipal() principal: Principal): Promise<TechnicianResponse[]> {
    return this.resources.technicians(principal.dealershipId);
  }

  @Get('service-bays')
  @ApiOperation({ summary: 'Service bays' })
  @ApiOkResponse({ type: [ServiceBayResponse] })
  serviceBays(@CurrentPrincipal() principal: Principal): Promise<ServiceBayResponse[]> {
    return this.resources.serviceBays(principal.dealershipId);
  }
}
