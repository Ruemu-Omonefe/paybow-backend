/** Creates three test accounts (mirror wallets at ₦0). Password for all: Test@1234. Fund them from the app. */
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import config from './config';
import { User, Wallet } from './models';

const USERS = [
  { name: 'Ada Okafor', email: 'ada@paybow.test', walletId: 'PBW100000001' },
  { name: 'Tunde Bello', email: 'tunde@paybow.test', walletId: 'PBW100000002' },
  { name: 'Ngozi Eze', email: 'ngozi@paybow.test', walletId: 'PBW100000003' },
];

(async () => {
  await mongoose.connect(config.mongoUri);
  await mongoose.syncIndexes();
  const passwordHash = await bcrypt.hash('Test@1234', 10);
  for (const u of USERS) {
    let user = await User.findOne({ email: u.email });
    if (!user) user = await User.create({ name: u.name, email: u.email, passwordHash, walletId: u.walletId });
    await Wallet.updateOne({ userId: user._id }, { $setOnInsert: { userId: user._id, walletId: user.walletId, balance: 0, currency: config.currency } }, { upsert: true });
    console.log(`seeded ${u.email} (${user.walletId})`);
  }
  console.log('Done. Log in with password Test@1234; the device key + certificate are created on first login. Wallets start at ₦0.');
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
