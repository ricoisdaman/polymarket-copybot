import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const current = await prisma.configVersion.findFirst({
    where: { active: true },
    orderBy: { createdAt: "desc" }
  });

  if (!current) {
    console.log("No active config version found.");
    return;
  }

  const config = JSON.parse(current.json);
  config.safety = config.safety ?? {};
  config.safety.paused = false;
  config.safety.killSwitch = false;

  await prisma.configVersion.updateMany({
    where: { active: true },
    data: { active: false }
  });

  await prisma.configVersion.create({
    data: {
      json: JSON.stringify(config),
      active: true
    }
  });

  console.log("Runtime control reset: paused=false, killSwitch=false");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
