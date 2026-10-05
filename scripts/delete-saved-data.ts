import fs from 'node:fs';
import path from 'node:path';
import { Storage, DATA_DIR, DB_FILE } from '../src/server/storage.ts';

async function main() {
  console.log('🗑️  Initiating full deletion of saved trading data...');

  try {
    await Storage.ensureReady();
    const result = await Storage.clearAllSavedData({ resetSettings: false, wipeLogs: true });

    console.log('✅ Storage clear completed:');
    console.log(`   Positions cleared: ${result.positionsCleared}`);
    console.log(`   Orders cleared: ${result.ordersCleared}`);
    console.log(`   Trades cleared: ${result.tradesCleared}`);
    console.log(`   Paper wallet restored: ${result.paperWalletReset ? '1,000.00 USDT' : 'No'}`);
    console.log(`   Files removed: ${result.filesRemoved.length}`);
    for (const f of result.filesRemoved) {
      console.log(`     - ${f}`);
    }

    // Double-check explicit files
    const targets = [
      DB_FILE,
      path.join(DATA_DIR, 'database.json'),
      path.resolve(process.cwd(), '.data', 'database.json'),
      path.resolve(process.cwd(), 'data', 'database.json'),
      '/data/database.json',
      path.join(DATA_DIR, 'app.log'),
      path.resolve(process.cwd(), '.data', 'app.log'),
    ];

    for (const target of targets) {
      if (fs.existsSync(target)) {
        try {
          fs.unlinkSync(target);
          console.log(`   Directly unlinked: ${target}`);
        } catch (err: any) {
          console.warn(`   Could not delete ${target}: ${err.message}`);
        }
      }
    }

    const stats = Storage.getDatabaseStats();
    console.log('\n📊 Updated Storage State:');
    console.log(`   Storage Engine: ${stats.storageEngine}`);
    console.log(`   Open Positions: ${stats.openPositionsCount}`);
    console.log(`   Total Positions: ${stats.positionsCount}`);
    console.log(`   Orders: ${stats.ordersCount}`);
    console.log(`   Trades: ${stats.tradesCount}`);
    console.log(`   Paper Wallet Balance: ${stats.paperBalance} USDT`);
    console.log('\n✨ All saved data successfully deleted.');
    process.exit(0);
  } catch (err: any) {
    console.error('❌ Failed to delete saved data:', err);
    process.exit(1);
  }
}

main();
