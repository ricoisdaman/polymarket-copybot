import { createDbClient, setRuntimeControlState } from '../packages/db/src/index.js';
import { buildDefaultConfig } from '../packages/core/src/config.js';

const prisma = createDbClient();
const config = buildDefaultConfig();
const r = await setRuntimeControlState(prisma, 'leader2', { paused: false, killSwitch: false }, 'cli', 'Clear stale pause from old session', config);
console.log('leader2 control state cleared:', JSON.stringify(r));
await prisma.$disconnect();
