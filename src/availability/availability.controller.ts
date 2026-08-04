import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator';
import type { Principal } from '../common/auth/principal';
import { AvailabilityPreviewService } from './availability-preview.service';
import { AvailabilityQueryDto, AvailabilityResponse } from './dto/availability.dto';

@ApiTags('availability')
@ApiBearerAuth('bearer')
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly preview: AvailabilityPreviewService) {}

  @Get()
  @ApiOperation({
    summary: 'Preview open slots for a service on a given day (advisory)',
    description:
      '**Advisory / best-effort.** Computed by the same `findCandidates` rule the booking path ' +
      'uses, so the preview and the booking decision can never disagree about what "available" ' +
      'means — but the authoritative decision happens at POST time under the exclusion ' +
      'constraint, so a slot shown open here may still return 409 if someone takes it in between.',
  })
  @ApiOkResponse({ type: AvailabilityResponse })
  @ApiNotFoundResponse({ description: 'NOT_FOUND — no such service type in this dealership.' })
  async preview_(
    @CurrentPrincipal() principal: Principal,
    @Query() query: AvailabilityQueryDto,
  ): Promise<AvailabilityResponse> {
    return this.preview.previewDay(principal.dealershipId, query);
  }
}
