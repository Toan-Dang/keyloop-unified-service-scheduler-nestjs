import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';

type ComponentState = 'up' | 'down' | 'degraded';

interface ReadinessBody {
  status: 'ready' | 'not-ready' | 'degraded';
  checks: Record<string, ComponentState>;
}

@ApiTags('operations')
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness — is the process up? Deliberately checks nothing else. */
  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({ description: 'The process is alive.' })
  health(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /**
   * Readiness — hard-depends on **PostgreSQL only** (§13). Redis is checked but non-fatal:
   * bookings stay correct with Redis down (§10.1), so failing readiness on it would turn a
   * tolerable degradation into an outage.
   */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe (DB hard-dependency, Redis non-fatal)' })
  @ApiOkResponse({ description: 'Ready, possibly degraded if Redis is unavailable.' })
  @ApiServiceUnavailableResponse({ description: 'The database is unreachable.' })
  async ready(@Res() res: Response): Promise<void> {
    const [database, cache] = await Promise.all([this.prisma.isHealthy(), this.redis.ping()]);

    const body: ReadinessBody = {
      status: !database ? 'not-ready' : cache ? 'ready' : 'degraded',
      checks: {
        database: database ? 'up' : 'down',
        redis: cache ? 'up' : 'degraded',
      },
    };

    res.status(database ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json(body);
  }
}
