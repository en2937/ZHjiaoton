import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AdminAuth} from '../admin-access/auth.mjs';

// Run interactively by the server owner; passwords never enter command history.
if(!process.stdin.isTTY||!process.stdout.isTTY){console.error('请在交互终端运行此命令，由服务器所有者自行输入账号和密码。');process.exitCode=1;}
else{
  const dataDir=path.resolve(process.env.TRAFFIC_DATA_DIR||fileURLToPath(new URL('./private/',import.meta.url)));
  let muted=false;
  const output=new Writable({write(chunk,encoding,callback){if(!muted)process.stdout.write(chunk,encoding);callback();}});
  const rl=createInterface({input:process.stdin,output,terminal:true});
  try{
    const auth=new AdminAuth({file:path.join(dataDir,'admin.json')});await auth.ready;
    if(auth.record)throw new Error('管理员已存在，未覆盖或修改。');
    const username=(await rl.question('设置管理员账号（3–32位字母/数字等）：')).trim();
    process.stdout.write('设置密码（12–128位，输入不显示）：');muted=true;const password=await rl.question('');muted=false;process.stdout.write('\n');
    process.stdout.write('再次输入密码：');muted=true;const confirmation=await rl.question('');muted=false;process.stdout.write('\n');
    if(password!==confirmation)throw new Error('两次密码不一致，未创建账号。');
    await auth.setup(username,password);console.log('管理员初始化完成。密码未保存为明文，公网初始化接口保持关闭。');
  }catch(error){muted=false;console.error(error.message);process.exitCode=1;}
  finally{rl.close();}
}
