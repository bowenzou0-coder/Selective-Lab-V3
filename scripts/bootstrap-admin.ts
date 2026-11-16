import dotenv from 'dotenv';
import { getAdminAuth } from '../src/server/firebaseAdmin.ts';
import { getBootstrappedAdminEmail } from '../src/server/firebaseVerify.ts';
import { createRepository } from '../src/server/storage/index.ts';

dotenv.config();

async function main() {
  const emailArg = process.argv.find((a) => a.startsWith('--email='))?.split('=')[1];
  const uidArg = process.argv.find((a) => a.startsWith('--uid='))?.split('=')[1];
  const targetEmail = (emailArg || getBootstrappedAdminEmail()).trim();

  const auth = getAdminAuth();
  const repo = createRepository();

  let userRecord;
  if (uidArg) {
    userRecord = await auth.getUser(uidArg);
  } else {
    userRecord = await auth.getUserByEmail(targetEmail);
  }

  await auth.setCustomUserClaims(userRecord.uid, {
    ...(userRecord.customClaims || {}),
    role: 'admin',
    admin: true,
  });

  await repo.upsertUserFromAuth({
    uid: userRecord.uid,
    email: userRecord.email || targetEmail,
    displayName: userRecord.displayName || undefined,
    isBootstrappedAdmin: true,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        uid: userRecord.uid,
        email: userRecord.email || targetEmail,
        role: 'admin',
        backendName: repo.backendName,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('Admin bootstrap failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
