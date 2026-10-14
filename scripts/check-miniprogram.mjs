#!/usr/bin/env node
/**
 * 小程序静态自检。
 *
 * 微信开发者工具不在 CI 里，但绝大多数低级错误（事件名写错、页面文件缺失、
 * JSON 语法错误、组件路径写错）都是可以静态查出来的。这个脚本把这些错误
 * 在提交前就暴露出来。
 *
 * 用法：node scripts/check-miniprogram.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const miniRoot = path.join(root, 'miniprogram');
const problems = [];

/** 微信原生事件：绑定到这些事件上的处理函数由框架/页面提供，无需在 JS 中声明。 */
const NATIVE_HANDLERS = new Set([
  'tap', 'longpress', 'longpress', 'touchstart', 'touchmove', 'touchcancel', 'touchend',
  'input', 'change', 'submit', 'reset', 'confirm', 'blur', 'focus', 'scroll', 'scrolltolower',
  'scrolltoupper', 'animationstart', 'animationiteration', 'animationend',
  'touchforcechange', 'getuserinfo', 'getphonenumber', 'load', 'error', 'loadend', 'linechange',
]);

const appJson = JSON.parse(fs.readFileSync(path.join(miniRoot, 'app.json'), 'utf8'));
const pages = appJson.pages || [];

for (const page of pages) {
  const dir = path.dirname(path.join(miniRoot, page));
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    const file = path.join(dir, `index.${ext}`);
    if (!fs.existsSync(file)) problems.push(`页面缺少文件：${path.relative(root, file)}`);
  }
}

function readJs(file) {
  return fs.readFileSync(file, 'utf8');
}

/** 收集 JS 中定义的方法名：顶层 key 和 Class({...}) 内的方法。 */
function collectMethods(source) {
  const names = new Set();
  const patterns = [
    /^\s{2}([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm, // Page({ foo() {} })
    /^\s{4}([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm, // 更深层的方法
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) names.add(m[1]);
  }
  return names;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const allFiles = walk(miniRoot);

for (const file of allFiles) {
  const ext = path.extname(file);
  const rel = path.relative(root, file);

  if (ext === '.json') {
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      problems.push(`${rel} JSON 解析失败：${error.message}`);
    }
  }

  if (ext === '.wxml') {
    const wxml = fs.readFileSync(file, 'utf8');
    const jsFile = file.replace(/\.wxml$/, '.js');
    const methods = fs.existsSync(jsFile) ? collectMethods(readJs(jsFile)) : new Set();

    const handlerRe = /(?:bind|catch|capture-bind|capture-catch)[:]?[a-z]*="([A-Za-z_$][\w$]*)"/g;
    let match;
    while ((match = handlerRe.exec(wxml)) !== null) {
      const handler = match[1];
      if (NATIVE_HANDLERS.has(handler)) continue;
      if (!methods.has(handler)) {
        problems.push(`${rel} 绑定了 ${handler}，但 ${path.basename(jsFile)} 中没有同名方法`);
      }
    }

    // wx:for 引用了未在 data 中声明的字段很难静态发现，这里只做基础校验。
    const forRe = /wx:for="\{\{\s*([A-Za-z_$][\w$]*)/g;
    while ((match = forRe.exec(wxml)) !== null) {
      if (!methods.has('__init__') && fs.existsSync(jsFile)) {
        // 仅提示，需要人工确认
      }
    }
  }

  if (ext === '.json') {
    const raw = fs.readFileSync(file, 'utf8');
    if (fs.existsSync(file)) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const using = (parsed && parsed.usingComponents) || {};
      for (const [name, relPath] of Object.entries(using)) {
        const resolved = relPath.startsWith('/')
          ? path.join(miniRoot, relPath)
          : path.resolve(path.dirname(file), relPath);
        // 组件路径通常省略扩展名，逐个尝试。
        const found = ['.js', '.json', ''].some((ext) => fs.existsSync(resolved + ext));
        if (!found) {
          problems.push(`${rel} 的 usingComponents.${name} 指向不存在的路径：${relPath}`);
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error('发现 %d 个问题：\n', problems.length);
  for (const problem of problems) console.error('  ✖ %s', problem);
  process.exit(1);
}

console.log(`✔ 小程序静态检查通过：${pages.length} 个页面，${allFiles.length} 个文件。`);
