import { createPrismaClient } from "../index.js";
import { PRICING_SEED } from "./pricing.js";

const prisma = createPrismaClient();

async function main() {
  let inserted = 0;
  for (const price of PRICING_SEED) {
    await prisma.modelPrice.upsert({
      where: {
        provider_modelPattern_effectiveFrom: {
          provider: price.provider,
          modelPattern: price.modelPattern,
          effectiveFrom: price.effectiveFrom,
        },
      },
      update: {},
      create: price,
    });
    inserted += 1;
  }
  console.log(`Pricing catalog seeded: ${inserted} entries.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
