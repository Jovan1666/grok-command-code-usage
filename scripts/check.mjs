#!/usr/bin/env node
/**
 * 一条命令给出这个仓库的结论。
 *
 *   node scripts/check.mjs            全部检查
 *   node scripts/check.mjs --quiet    每个套件只打一行
 *
 * CI 直接调这个文件，所以本地和线上是同一套判定——不会出现"本地过了 CI 挂"。
 * 不联网、不需要真实凭证。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'cc-usage.mjs');
const SETUP = path.join(ROOT, 'scripts', 'setup.mjs');
const QUIET = process.argv.includes('--quiet');

const suites = [];
const record = (name, fn) => suites.push({ name, fn });

/* ---------------------------------------------------------------- 工具 */

let failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

/** 跑一次 cc-usage.mjs（不联网）并返回去掉 ANSI 的 stdout。 */
function runScript(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  return String(r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
}

/** 显示宽度：CJK/全角算 2，其余算 1，与脚本内部口径一致。 */
function displayWidth(text) {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    w += cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    ) ? 2 : 1;
  }
  return w;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.devdeps') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* ----------------------------------------------------- 1. 状态栏渲染 */

record('statusline', () => {
  let checked = 0;

  // 按量计费套餐的输出是确定的（金额固定、没有时间），可以逐字断言。
  const provider = runScript(['--statusline', '--rows', '1', '--demo', 'provider'], { COLUMNS: '140' }).trim();
  assert(provider === 'CC Provider │ 余额 $47.66',
    `按量计费套餐应只显示余额，实际得到：${JSON.stringify(provider)}`);
  checked += 1;

  for (const scenario of ['normal', 'hot', 'max']) {
    const line = runScript(['--statusline', '--rows', '1', '--demo', scenario], { COLUMNS: '140' }).trim();
    const name = `--demo ${scenario}`;
    assert(line.startsWith('CC '), `${name}: 应以 "CC " 开头，实际 ${JSON.stringify(line.slice(0, 20))}`);
    assert(line.split('│').length === 4, `${name}: 单行模式应有 4 段（套餐名 + 三条窗口），实际 ${line.split('│').length}`);
    assert(/\d+%/.test(line), `${name}: 应含百分比`);
    assert(line.includes('重置'), `${name}: 三条窗口都该带重置时间`);
    // 绝不带 ANSI：Grok 的状态栏是纯文本行，带上会原样显示成乱码。
    assert(!/\x1b\[/.test(runScript(['--statusline', '--rows', '1', '--demo', scenario])), `${name}: 不应输出 ANSI`);
    checked += 1;

    const three = runScript(['--statusline', '--demo', scenario], { COLUMNS: '140' }).trim();
    assert(three.split('\n').length === 3, `${name}: 三行模式应输出 3 行`);
    checked += 1;
  }

  // 宽度自适应：任何终端宽度下都不能折行（折行会让整个底部错位）。
  for (const cols of ['200', '140', '120', '110', '100', '95', '90', '80']) {
    const line = runScript(['--statusline', '--rows', '1', '--demo'], { COLUMNS: cols }).trim();
    const w = displayWidth(line);
    assert(w <= Number(cols), `COLUMNS=${cols}: 行宽 ${w} 超了`);
    assert(!line.includes('\n'), `COLUMNS=${cols}: 不该折行`);
    checked += 1;
  }

  return `${checked} 项渲染断言`;
});

/* -------------------------------------------------------- 2. 隐藏逻辑 */

record('gating', async () => {
  // 直接测判定函数，不跑整条流水线：整条要凭证、要联网，CI 上两样都没有。
  const { decideRoute, normalizeModel } = await import(pathToFileURL(SCRIPT).href);
  const catalog = ['deepseek-v4.1-flash', 'claude-opus-5', 'kimi-k2.7-code'];

  assert(normalizeModel('deepseek/deepseek-v4.1-flash') === 'deepseek-v4.1-flash', '归一化应去掉 vendor 前缀');
  assert(normalizeModel('claude-opus-5[1M]') === 'claude-opus-5', '归一化应去掉 [1M] 这类后缀');
  assert(normalizeModel('K2.7 Code') === 'k2.7-code', '归一化应把空白折成连字符');

  assert(decideRoute('deepseek/deepseek-v4.1-flash', catalog) === 'yes', '目录里有的模型 -> 在用');
  assert(decideRoute('totally-made-up-xyz', catalog) === 'no', '目录里没有 -> 不在用');
  assert(decideRoute(null, catalog) === 'unknown', '拿不到模型名 -> 未知，交给下一级判据');
  assert(decideRoute('deepseek-v4.1-flash', null) === 'unknown', '没有目录 -> 未知，不猜');

  // 裸 claude-* 名字原生 Anthropic 也有，必须回避而不是当成命中
  assert(decideRoute('claude-opus-5', catalog) === 'unknown', 'claude-* 有歧义 -> 不猜');
  assert(decideRoute('claude-opus-5', catalog, { trustedSource: true }) === 'yes',
    '来自本地路由映射的 claude-* 是确定的，应当显示');

  // 用户自己补的别名优先于目录
  assert(decideRoute('kimi-k2.7-code', catalog, { modelPatterns: ['k2.7-code'] }) === 'yes', '用户别名应命中');
  assert(decideRoute('deepseek-v4.1-flash', catalog, { modelPatterns: ['k2.7-code'] }) === 'no',
    '给了别名就按别名来，不再看目录');

  // 状态栏命令可能收到的 stdin 形状必须都认：字符串 model（直接就是真实模型名）、
  // 对象 model（要去会话记录里找真实模型）、以及只给 transcript_path 的情况。
  const { routeDecision } = await import(pathToFileURL(SCRIPT).href);
  // 显式传空的 env：不然结果取决于跑测试那台机器有没有设 cc-switch 的模型映射，
  // 那正是上一个版本「本地过 CI 挂」的原因。
  const direct = routeDecision({ model: 'gpt-5.6-terra', transcript_path: '' },
    { catalog: [...catalog, 'gpt-5.6-terra'], env: {} });
  assert(direct.decision === 'yes', '字符串形式的 model 应当被认出来');

  const outside = routeDecision({ model: 'gpt-5.6-terra', transcript_path: '' }, { catalog, env: {} });
  assert(outside.decision === 'no', '给的模型不在目录里就该隐藏');

  const noModel = routeDecision({ transcript_path: '' }, { catalog, env: {} });
  assert(noModel.decision === 'unknown', '没给 model 时是未知，不是"不在用"');

  const objModel = routeDecision({ model: { id: 'claude-opus-5[1M]' }, transcript_path: '' }, { catalog, env: {} });
  assert(objModel.decision === 'unknown',
    '对象形状的 model 不该被当成模型名——真实模型在会话记录里');

  return '15 项判定断言';
});

/* ------------------------------------------------------- 3. 阈值与输出 */

record('threshold+hook', () => {
  const under = runScript(['--statusline', '--threshold', '70', '--demo']).trim();
  assert(under === '', `未过阈值不该有输出，实际：${JSON.stringify(under.slice(0, 40))}`);

  const over = runScript(['--statusline', '--threshold', '30', '--demo']).trim();
  assert(over.startsWith('CC '), '过了阈值应输出面板');

  // --hook 输出必须吐合法 JSON，且 systemMessage 是纯文本
  const hook = runScript(['--hook', '--always', '--demo']).trim();
  let parsed = null;
  try { parsed = JSON.parse(hook); } catch { /* 下面断言会报 */ }
  assert(parsed && typeof parsed.systemMessage === 'string', `钩子应输出 {"systemMessage": …}，实际：${hook.slice(0, 60)}`);
  assert(parsed && !/\x1b\[/.test(parsed.systemMessage), 'systemMessage 不能含 ANSI（会原样显示成乱码）');
  assert(parsed && !parsed.hookSpecificOutput, '钩子不该用 additionalContext——那会进模型上下文、每轮烧 token');

  return '阈值静默 + 钩子 JSON 形状';
});

/* ------------------------------------------------------------ 4. 其它输出 */

record('formats', () => {
  let n = 0;
  for (const [args, marker, name] of [
    [['--demo'], 'Command Code', '终端面板'],
    [['--md', '--demo'], '|', 'Markdown'],
    [['--compact', '--demo'], 'CC GOAT', '单行摘要'],
  ]) {
    const out = runScript(args);
    assert(out.includes(marker), `${name} 应包含 ${JSON.stringify(marker)}`);
    n += 1;
  }
  const json = runScript(['--json', '--demo']);
  let doc = null;
  try { doc = JSON.parse(json); } catch { /* 断言会报 */ }
  assert(doc && doc.plan && doc.windows && doc.monthly, '--json 应是自洽快照');
  n += 1;

  // 不联网的 demo 不该碰网络；--help 不该跑主流程
  assert(runScript(['--help']).includes('--statusline'), '--help 应列出 --statusline');
  n += 1;
  return `${n} 种输出`;
});

/* ------------------------------------------------------- 5. 全仓静态检查 */

record('static', () => {
  const files = walk(ROOT);
  let json = 0;
  let js = 0;

  for (const f of files) {
    if (f.endsWith('.json')) {
      try { JSON.parse(fs.readFileSync(f, 'utf8')); json += 1; }
      catch (err) { assert(false, `JSON 非法: ${path.relative(ROOT, f)} — ${err.message}`); }
    }
  }

  for (const f of files) {
    if (!/\.(mjs|cjs|js)$/.test(f)) continue;
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', timeout: 20_000 });
    assert(r.status === 0, `语法错误: ${path.relative(ROOT, f)}`);
    js += 1;
  }

  return `${json} 个 JSON + ${js} 个 JS`;
});

/* -------------------------------------------------------- 6. 密钥与隐私 */

record('secrets', () => {
  // 别让 API key、本机绝对路径或邮箱被提交进去——这是要公开发布的仓库。
  const patterns = [
    [/user_[A-Za-z0-9_-]{16,}/, 'Command Code key'],
    [/sk-[A-Za-z0-9]{20,}/, 'OpenAI 风格 key'],
    [/ghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
    [/github_pat_[A-Za-z0-9_]{20,}/, 'GitHub PAT'],
    [/C:[\\/]Users[\\/](?!admin[\\/]\.claude)[A-Za-z0-9._-]+/, '个人绝对路径'],
    [/[A-Za-z0-9._%+-]+@(?!example\.com|users\.noreply)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, '邮箱'],
  ];
  let scanned = 0;
  for (const f of walk(ROOT)) {
    if (/\.(png|jpg|ico|woff2?|lock)$/.test(f)) continue;
    // 本文件自己的规则里就写着这些形态，跳过它
    if (f === fileURLToPath(import.meta.url)) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const [re, label] of patterns) {
      const hit = text.match(re);
      if (hit) assert(false, `${label} 出现在 ${path.relative(ROOT, f)}: ${hit[0].slice(0, 24)}…`);
    }
    scanned += 1;
  }
  return `${scanned} 个文件已扫描`;
});

/* ------------------------------------------------- 7. Grok 的安装器与清单 */

record('grok', () => {
  let checked = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-grok-'));

  /**
   * 一个隔离的安装场景：把两个脚本复制进临时目录再跑，这样 setup.mjs 生成的
   * cc-usage.cmd 落在临时目录里，不会污染工作区（它在 .gitignore 里，但检查不该弄脏仓库）。
   */
  const makeCase = () => {
    const dir = fs.mkdtempSync(path.join(root, 'case-'));
    const scripts = path.join(dir, 'scripts');
    const home = path.join(dir, 'grok');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    for (const source of [SETUP, SCRIPT]) {
      fs.copyFileSync(source, path.join(scripts, path.basename(source)));
    }
    const setup = path.join(scripts, 'setup.mjs');
    const launcher = path.join(scripts, 'cc-usage.cmd');
    const config = path.join(home, 'config.toml');
    // platform 传了就伪造一个：Windows 那条分支（生成 cc-usage.cmd）在三个平台上都能跑到，
    // 否则 Linux / macOS 的 CI 永远覆盖不了它。
    const run = (args = [], platform = null) => {
      let preload = null;
      if (platform) {
        preload = path.join(dir, `platform-${platform}.cjs`);
        fs.writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)}, configurable: true });\n`);
      }
      const argv = preload ? ['-r', preload, setup, ...args] : [setup, ...args];
      const r = spawnSync(process.execPath, argv, {
        encoding: 'utf8',
        timeout: 20_000,
        env: { ...process.env, GROK_HOME: home },
      });
      if (r.error) throw r.error;
      return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
    };
    return { dir, scripts, home, setup, launcher, config, run };
  };

  const readIfAny = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

  try {
    /* ---- 装上：写 [ui.status_line]，其余内容原样保留 ---- */
    const a = makeCase();
    fs.writeFileSync(a.config, '[model.x]\nbase_url = "https://example.com"\n');
    const installed = a.run();
    assert(installed.status === 0, `装上应以 0 退出，实际 ${installed.status}: ${installed.stderr}`);
    const cfg1 = readIfAny(a.config) ?? '';
    assert(cfg1.includes('[ui.status_line]'), '应写入 [ui.status_line] 小节');
    assert(/type = "command"/.test(cfg1), 'type 应是 command');
    assert(/refresh_interval = 300/.test(cfg1), '默认应带 refresh_interval = 300');
    assert(cfg1.includes('cc-usage'), 'command 应指向本仓库的脚本');
    assert(cfg1.includes('[model.x]'), '用户原有的配置必须原样保留');
    checked += 1;

    /* ---- 别人写的状态栏：拒绝覆盖，且一个字节都不动 ---- */
    const foreign = '[ui.status_line]\ntype = "command"\ncommand = "echo 别人的状态栏"\n';
    fs.writeFileSync(a.config, foreign);
    const refused = a.run();
    assert(refused.status === 2, `别人的状态栏应以 2 退出（拒绝），实际 ${refused.status}`);
    assert(readIfAny(a.config) === foreign, '拒绝覆盖时不能改动配置文件');
    assert(refused.stderr.includes('没有动它'), '应说明没有动别人的状态栏');
    assert(refused.stderr.includes('--force'), '应告诉用户 --force 才是覆盖它的办法');
    checked += 1;

    /* ---- --force：先备份，再覆盖 ---- */
    const forced = a.run(['--force']);
    assert(forced.status === 0, `--force 应以 0 退出，实际 ${forced.status}: ${forced.stderr}`);
    const backups = fs.readdirSync(a.home).filter((n) => n.startsWith('config.toml.bak-'));
    assert(backups.length === 1, `--force 应留下一个 .bak-<时间戳> 备份，实际 ${JSON.stringify(backups)}`);
    assert(readIfAny(path.join(a.home, backups[0])) === foreign, '备份里应是原来那份配置');
    assert((readIfAny(a.config) ?? '').includes('cc-usage'), '--force 之后配置应指向本插件');
    checked += 1;

    /* ---- --remove：停用并把生成的包装脚本清掉 ---- */
    const removed = a.run(['--remove']);
    assert(removed.status === 0, `--remove 应以 0 退出，实际 ${removed.status}: ${removed.stderr}`);
    const cfgAfterRemove = readIfAny(a.config) ?? '';
    assert(/type = "disabled"/.test(cfgAfterRemove), '--remove 后应留 Grok 的默认值 type = "disabled"');
    assert(!cfgAfterRemove.includes('cc-usage'), '--remove 后配置里不该再指向本插件');
    checked += 1;

    /* ---- 卸完还能再装上（装一次、卸一次就装不回去是踩过的坑） ---- */
    const again = a.run();
    assert(again.status === 0, `卸掉之后重装应以 0 退出，实际 ${again.status}: ${again.stderr}`);
    assert((readIfAny(a.config) ?? '').includes('cc-usage'), '重装后配置应重新指向本插件');
    checked += 1;

    /* ---- --print：只打印，不写文件 ---- */
    const b = makeCase();
    const printed = b.run(['--print', '--rows', '3']);
    assert(printed.status === 0, `--print 应以 0 退出，实际 ${printed.status}: ${printed.stderr}`);
    assert(!fs.existsSync(b.config), '--print 不该创建配置文件');
    assert(printed.stdout.includes('[ui.status_line]'), '--print 应打印将要写入的小节');
    assert(printed.stdout.includes('--rows 3'), '--print 应反映 --rows 3');
    checked += 1;

    /* ---- Windows：config.toml 只写一条裸路径，node 调用放进纯 ASCII 的 .cmd ---- */
    const c = makeCase();
    const win = c.run([], 'win32');
    assert(win.status === 0, `Windows 分支应以 0 退出，实际 ${win.status}: ${win.stderr}`);
    const launcherText = readIfAny(c.launcher);
    assert(launcherText !== null, 'Windows 上应生成 cc-usage.cmd');
    if (launcherText !== null) {
      // 批处理必须纯 ASCII：cmd.exe 用 OEM 代码页读它，UTF-8 注释会被当成命令执行。
      assert(/^[\x20-\x7e\r\n]*$/.test(launcherText), '包装脚本必须是纯 ASCII');
      assert(launcherText.includes('\r\n') && !/[^\r]\n/.test(launcherText), '包装脚本必须是 CRLF 行尾');
      assert(launcherText.includes('node "%~dp0cc-usage.mjs" --statusline --rows 1'),
        '包装脚本里应是 node + %~dp0 定位的脚本');
      assert((readIfAny(c.config) ?? '').includes(`command = ${JSON.stringify(c.launcher.split(path.sep).join('/'))}`),
        'config.toml 里应写一条不加引号的裸包装路径（加引号会让 Grok 报 os error 123）');
      checked += 1;

      // 行数参数跟着 --rows 走，_remove 时把包装脚本也清掉
      const win3 = c.run(['--rows', '3'], 'win32');
      assert(win3.status === 0, `Windows + --rows 3 应以 0 退出，实际 ${win3.status}`);
      assert((readIfAny(c.launcher) ?? '').includes('--statusline --rows 3'), '--rows 3 应写进包装脚本');
      const winRemove = c.run(['--remove'], 'win32');
      assert(winRemove.status === 0, `Windows 上 --remove 应以 0 退出，实际 ${winRemove.status}`);
      assert(!fs.existsSync(c.launcher), '--remove 应删掉生成的包装脚本');
      assert(/type = "disabled"/.test(readIfAny(c.config) ?? ''), '--remove 后配置应回到默认值');
      checked += 1;
    }

    /* ---- 非 Windows：直接写 node + 脚本路径，不生成批处理 ---- */
    const d = makeCase();
    const posix = d.run([], 'linux');
    assert(posix.status === 0, `非 Windows 分支应以 0 退出，实际 ${posix.status}: ${posix.stderr}`);
    const expected = `node "${path.join(d.scripts, 'cc-usage.mjs').split(path.sep).join('/')}" --statusline --rows 1`;
    assert((readIfAny(d.config) ?? '').includes(`command = ${JSON.stringify(expected)}`),
      `非 Windows 上应直接写 node + 脚本路径，实际 ${JSON.stringify(readIfAny(d.config))}`);
    assert(!fs.existsSync(d.launcher), '非 Windows 上不该生成 cc-usage.cmd');
    checked += 1;

    /* ---- 清单：插件指向仓库根，命令目录里确实有 /quota ---- */
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
    assert(manifest.name === 'commandcode-usage', `plugin.json 的 name 应是 commandcode-usage，实际 ${manifest.name}`);
    assert(manifest.commands === './commands', `plugin.json 应把命令目录指向 ./commands，实际 ${manifest.commands}`);
    assert(fs.existsSync(path.join(ROOT, 'commands', 'quota.md')), 'commands/quota.md 应当存在');
    const market = JSON.parse(fs.readFileSync(path.join(ROOT, '.grok-plugin', 'marketplace.json'), 'utf8'));
    const entry = market.plugins?.[0];
    assert(entry?.source?.path === '.', `市场清单的 source.path 应是 "."（插件就在仓库根），实际 ${entry?.source?.path}`);
    assert(entry?.version === manifest.version, `市场清单与 plugin.json 的版本号应一致（${entry?.version} vs ${manifest.version}）`);
    // CHANGELOG 顶上那条就是当前版本——三处不一致时，用户看到的版本号会各说各话。
    const logTop = /^## (\d+\.\d+\.\d+)/m.exec(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'));
    assert(logTop?.[1] === manifest.version, `CHANGELOG 顶部版本应是 ${manifest.version}，实际 ${logTop?.[1]}`);
    checked += 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  return `${checked} 项安装与清单断言`;
});

/* ------------------------------------------------------------ 执行 */

console.log('Command Code Usage（Grok Build）— 仓库检查\n');
let failed = 0;

for (const { name, fn } of suites) {
  failures = [];
  const started = Date.now();
  let summary = '';
  try {
    summary = (await fn()) ?? '';
  } catch (err) {
    failures.push(`套件抛错：${err instanceof Error ? err.message : String(err)}`);
  }
  const ms = Date.now() - started;

  if (failures.length === 0) {
    console.log(`${QUIET ? '' : '  ok    '}${name.padEnd(14)} ${summary}  (${ms}ms)`);
  } else {
    failed += 1;
    console.log(`${QUIET ? '' : '  FAIL  '}${name.padEnd(14)} —  (${ms}ms)`);
    for (const f of failures) console.log(`          ${f}`);
  }
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 个套件失败。`);
  process.exit(1);
}
console.log(`${suites.length} 个套件全部通过。`);
