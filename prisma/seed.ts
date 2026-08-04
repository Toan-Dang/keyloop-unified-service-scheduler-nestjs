/**
 * Seed fixture — `docs/database-design.md` §6.
 *
 * Deliberately shaped so the concurrency test has a **genuine single bottleneck**: exactly one
 * technician holds the `brakes` skill, so a burst of parallel *Brake Inspection* bookings for one
 * window can place exactly one appointment and the rest must lose (§6.5). Booking an *Oil
 * Change* instead would legitimately place two (both technicians qualify, two bays are free) and
 * would prove nothing about exclusivity.
 *
 * IDs are fixed rather than generated so tests, cURL examples and the README can reference them
 * directly. They are still valid v7-shaped UUIDs.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '../generated/prisma/client';

const envFile = path.join(__dirname, '..', '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/** Mon–Sat 08:00–18:00, closed Sunday. Local wall-clock, read in the dealership timezone. */
const OPENING_HOURS = {
  mon: [['08:00', '18:00']],
  tue: [['08:00', '18:00']],
  wed: [['08:00', '18:00']],
  thu: [['08:00', '18:00']],
  fri: [['08:00', '18:00']],
  sat: [['08:00', '18:00']],
  sun: [],
};

/**
 * A split shift with a lunch close. This is not decoration: it is what makes the
 * "the window must fit inside a *single* contiguous range" rule (§6.7) testable — an 11:30
 * Oil Change straddles the gap and must not match this technician.
 */
const SPLIT_SHIFT = {
  mon: [
    ['08:00', '12:00'],
    ['13:00', '17:00'],
  ],
  tue: [
    ['08:00', '12:00'],
    ['13:00', '17:00'],
  ],
  wed: [
    ['08:00', '12:00'],
    ['13:00', '17:00'],
  ],
  thu: [
    ['08:00', '12:00'],
    ['13:00', '17:00'],
  ],
  fri: [
    ['08:00', '12:00'],
    ['13:00', '17:00'],
  ],
  sat: [
    ['08:00', '12:00'],
    ['13:00', '17:00'],
  ],
  sun: [],
};

/** A straight shift covering the dealership's whole opening day. */
const FULL_SHIFT = OPENING_HOURS;

export const SEED = {
  dealership: {
    id: '01900000-0000-7000-8000-00000000d001',
    name: 'Saigon Auto Service',
    timezone: 'Asia/Ho_Chi_Minh',
  },
  /**
   * A second tenant, not in db §6. Two things in the design need it and neither is servable by a
   * single dealership: the tenant-isolation guarantee ("out-of-tenant reference → 404", §14)
   * needs somewhere to *be* out of, and the DST enumeration case (§6.7, §12) needs a zone that
   * actually observes DST — `Asia/Ho_Chi_Minh` never has. Kept strictly separate; nothing in the
   * primary fixture references it.
   */
  otherDealership: {
    id: '01900000-0000-7000-8000-00000000d002',
    name: 'Berlin Motorwerk',
    timezone: 'Europe/Berlin',
  },
  serviceTypes: {
    oilChange: {
      id: '01900000-0000-7000-8000-00000000cc01',
      name: 'Oil Change',
      durationMinutes: 60,
      requiredSkills: ['general'],
    },
    /** The concurrency test's target: 90 minutes, and only one technician can perform it. */
    brakeInspection: {
      id: '01900000-0000-7000-8000-00000000cc02',
      name: 'Brake Inspection',
      durationMinutes: 90,
      requiredSkills: ['brakes'],
    },
  },
  technicians: {
    general: {
      id: '01900000-0000-7000-8000-00000000aa01',
      name: 'An Nguyen',
      skills: ['general'],
      workingHours: SPLIT_SHIFT,
    },
    /** The ONLY holder of `brakes` — the single bottleneck the signature test races for. */
    brakes: {
      id: '01900000-0000-7000-8000-00000000aa02',
      name: 'Binh Tran',
      skills: ['general', 'brakes'],
      workingHours: FULL_SHIFT,
    },
  },
  bays: {
    one: { id: '01900000-0000-7000-8000-00000000bb01', name: 'Bay 1' },
    two: { id: '01900000-0000-7000-8000-00000000bb02', name: 'Bay 2' },
  },
  customers: {
    one: {
      id: '01900000-0000-7000-8000-00000000ee01',
      name: 'Chi Pham',
      email: 'chi.pham@example.com',
      phone: '+84900000001',
    },
    two: {
      id: '01900000-0000-7000-8000-00000000ee02',
      name: 'Dung Le',
      email: 'dung.le@example.com',
      phone: '+84900000002',
    },
  },
  vehicles: {
    one: {
      id: '01900000-0000-7000-8000-00000000ff01',
      vin: 'JH4KA7561PC001234',
      make: 'Toyota',
      model: 'Vios',
      year: 2021,
    },
    two: {
      id: '01900000-0000-7000-8000-00000000ff02',
      vin: 'JH4KA7561PC009876',
      make: 'Honda',
      model: 'City',
      year: 2023,
    },
  },
  /** Reference data on the *other* tenant, used only to prove cross-tenant reads return 404. */
  otherTenant: {
    customerId: '01900000-0000-7000-8000-00000000ee99',
    vehicleId: '01900000-0000-7000-8000-00000000ff99',
    serviceTypeId: '01900000-0000-7000-8000-00000000cc99',
    technicianId: '01900000-0000-7000-8000-00000000aa99',
    bayId: '01900000-0000-7000-8000-00000000bb99',
  },
} as const;

export async function seed(prisma: PrismaClient): Promise<void> {
  const d = SEED.dealership;
  const o = SEED.otherDealership;

  await prisma.dealership.upsert({
    where: { id: d.id },
    update: { name: d.name, timezone: d.timezone, openingHours: OPENING_HOURS },
    create: { id: d.id, name: d.name, timezone: d.timezone, openingHours: OPENING_HOURS },
  });

  await prisma.dealership.upsert({
    where: { id: o.id },
    update: { name: o.name, timezone: o.timezone, openingHours: OPENING_HOURS },
    create: { id: o.id, name: o.name, timezone: o.timezone, openingHours: OPENING_HOURS },
  });

  for (const st of Object.values(SEED.serviceTypes)) {
    await prisma.serviceType.upsert({
      where: { id: st.id },
      update: {
        name: st.name,
        durationMinutes: st.durationMinutes,
        requiredSkills: [...st.requiredSkills],
      },
      create: {
        id: st.id,
        dealershipId: d.id,
        name: st.name,
        durationMinutes: st.durationMinutes,
        requiredSkills: [...st.requiredSkills],
      },
    });
  }

  for (const t of Object.values(SEED.technicians)) {
    await prisma.technician.upsert({
      where: { id: t.id },
      update: {
        name: t.name,
        skills: [...t.skills],
        workingHours: t.workingHours,
        isActive: true,
      },
      create: {
        id: t.id,
        dealershipId: d.id,
        name: t.name,
        skills: [...t.skills],
        workingHours: t.workingHours,
        isActive: true,
      },
    });
  }

  for (const b of Object.values(SEED.bays)) {
    await prisma.serviceBay.upsert({
      where: { id: b.id },
      update: { name: b.name, isActive: true },
      create: { id: b.id, dealershipId: d.id, name: b.name, isActive: true },
    });
  }

  const customers = [SEED.customers.one, SEED.customers.two];
  const vehicles = [SEED.vehicles.one, SEED.vehicles.two];

  for (const [index, c] of customers.entries()) {
    await prisma.customer.upsert({
      where: { id: c.id },
      update: { name: c.name, email: c.email, phone: c.phone },
      create: { id: c.id, dealershipId: d.id, name: c.name, email: c.email, phone: c.phone },
    });

    const v = vehicles[index];
    if (!v) continue;
    await prisma.vehicle.upsert({
      where: { id: v.id },
      update: { vin: v.vin, make: v.make, model: v.model, year: v.year, customerId: c.id },
      create: {
        id: v.id,
        dealershipId: d.id,
        customerId: c.id,
        vin: v.vin,
        make: v.make,
        model: v.model,
        year: v.year,
      },
    });
  }

  // --- the other tenant's mirror set (existence-leak tests) ---
  const t = SEED.otherTenant;
  await prisma.customer.upsert({
    where: { id: t.customerId },
    update: {},
    create: {
      id: t.customerId,
      dealershipId: o.id,
      name: 'Erika Mustermann',
      email: 'erika@example.de',
    },
  });
  await prisma.vehicle.upsert({
    where: { id: t.vehicleId },
    update: {},
    create: {
      id: t.vehicleId,
      dealershipId: o.id,
      customerId: t.customerId,
      vin: 'WVWZZZ1JZXW000111',
      make: 'Volkswagen',
      model: 'Golf',
      year: 2022,
    },
  });
  await prisma.serviceType.upsert({
    where: { id: t.serviceTypeId },
    update: {},
    create: {
      id: t.serviceTypeId,
      dealershipId: o.id,
      name: 'Oil Change',
      durationMinutes: 60,
      requiredSkills: ['general'],
    },
  });
  await prisma.technician.upsert({
    where: { id: t.technicianId },
    update: {},
    create: {
      id: t.technicianId,
      dealershipId: o.id,
      name: 'Hans Schmidt',
      skills: ['general', 'brakes'],
      workingHours: FULL_SHIFT,
    },
  });
  await prisma.serviceBay.upsert({
    where: { id: t.bayId },
    update: {},
    create: { id: t.bayId, dealershipId: o.id, name: 'Halle 1' },
  });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to seed');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    await seed(prisma);
    // eslint-disable-next-line no-console
    console.log(
      `Seeded: ${SEED.dealership.name} (${SEED.dealership.timezone}) — ` +
        `2 service types, 2 technicians (only "${SEED.technicians.brakes.name}" holds "brakes"), ` +
        `2 bays, 2 customers with 1 vehicle each; plus tenant "${SEED.otherDealership.name}".`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main();
}
