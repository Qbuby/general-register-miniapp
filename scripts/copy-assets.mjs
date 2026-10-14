#!/usr/bin/env node
/**
 * 把非 TypeScript 资源复制到编译产物里。
 *
 * tsc 只处理 .ts 文件，数据库迁移用的 .sql 不会被带过去，
 * 编译后的服务启动时会因为找不到迁移目录而直接失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const assets = [{ from: 'src/db/migrations', to: 'dist/db/migrations' }];

let copied = 0;
for (const asset of assets) {
  const fromDir = path.join(root, asset.from);
  const toDir = path.join(root, asset.to);
  if (!fs.existsSync(fromDir)) {
    console.error(`找不到资源目录：${asset.from}`);
    process.exit(1);
  }
  fs.mkdirSync(toDir, { recursive: true });
  for (const file of fs.readdirSync(fromDir)) {
    fs.copyFileSync(path.join(fromDir, file), path.join(toDir, file));
    copied += 1;
  }
}

console.log(`已复制 ${copied} 个资源文件到 dist/`);
