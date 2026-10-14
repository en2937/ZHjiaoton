import {open, unlink, writeFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {launchPlatform, projectRoot, captureProcess, makeNetwork} from './core.mjs';

const lockPath = path.join(projectRoot, 'platform-launcher', 'launch.lock');
let lock;
try {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('需要 Node.js 20+。');
  try {lock = await open(lockPath, 'wx');}
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const {readFile} = await import('node:fs/promises');
    const oldPid = Number(await readFile(lockPath,'utf8'));
    if (!Number.isSafeInteger(oldPid) || oldPid < 1) {
      if (Date.now() - (await stat(lockPath)).mtimeMs < 5000) throw new Error('另一个一键启动正在准备，请稍后重试。');
    } else {
      const existing = await makeNetwork()('CheckLauncher','',['-TargetProcessId',String(oldPid)]);
      if (existing.owned) throw new Error('另一个一键启动正在进行，请等待它输出地址。');
    }
    await unlink(lockPath); lock = await open(lockPath,'wx');
  }
  await lock.writeFile(String(process.pid));
  const pythonIndex = process.argv.indexOf('--python');
  const report = await launchPlatform({python:pythonIndex>=0?process.argv[pythonIndex+1]:undefined});
  if (!process.argv.includes('--no-browser')) {
    try {
      await captureProcess('powershell.exe',['-NoProfile','-Command',"Start-Process 'http://127.0.0.1:4174/login'"]);
    } catch {console.log('浏览器未自动打开，请复制上面的本机管理员地址。');}
  }
  if (!report.firewallReady) process.exitCode = 2;
} catch (error) {
  console.error('\n启动未完成：'+error.message);
  console.error('运行中的沙盘和师生服务未被本启动器停止。');
  try {await writeFile(path.join(projectRoot,'platform-launcher','last-error.txt'),new Date().toISOString()+'\n'+error.message+'\n');} catch {}
  process.exitCode = 1;
} finally {if (lock) {await lock.close(); await unlink(lockPath).catch(()=>{});}}
