import { getDb, migrate, closeDb } from './index.js';
import { config } from '../config.js';

const db = getDb();
const applied = migrate(db);
console.log(`数据库：${config.databaseFile}`);
console.log(applied.length > 0 ? `已应用迁移：${applied.join(', ')}` : '数据库结构已是最新，无需迁移。');
closeDb();
