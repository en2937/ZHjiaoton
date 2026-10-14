import {randomBytes,scrypt,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';

const derive=promisify(scrypt);
const kdf={N:65536,r:8,p:2,maxmem:96*1024*1024};
const token=()=>randomBytes(32).toString('base64url');
const digest=value=>createHash('sha256').update(value).digest('hex');
export class AuthError extends Error{constructor(status,message){super(message);this.status=status;}}
export function equalSecret(a,b){const first=Buffer.from(a||''),second=Buffer.from(b||'');return first.length===second.length&&first.length>0&&timingSafeEqual(first,second);}
export async function ensureBridgeKey(file){
 await mkdir(path.dirname(file),{recursive:true});
 try{await writeFile(file,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
 const value=(await readFile(file,'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(value))throw new Error('管理员内部配置无效');return value;
}
export class AdminAuth{
 constructor({file=null,now=()=>Date.now(),idleMs=30*60*1000,absoluteMs=8*60*60*1000}={}){
  Object.assign(this,{file,now,idleMs,absoluteMs});this.record=null;this.sessions=new Map();this.attempts=new Map();this.activeHashes=0;
  this.ready=this.load();
 }
 async load(){if(!this.file)return;try{const record=JSON.parse(await readFile(this.file,'utf8'));if(record.version!==1||!validUsername(record.username)||!/^[a-f0-9]{32}$/.test(record.salt)||!/^[a-f0-9]{128}$/.test(record.hash))throw new Error('管理员账号配置无效');this.record=record;}catch(error){if(error.code!=='ENOENT')throw error;}}
 async hash(password,salt){if(this.activeHashes>=2)throw new AuthError(429,'登录请求较多，请稍后重试。');this.activeHashes++;try{return await derive(password,salt,64,kdf);}finally{this.activeHashes--;}}
 async setup(username,password){
  await this.ready;if(this.record)throw new AuthError(409,'管理员账号已设置，请直接登录。');
  if(!validUsername(username))throw new AuthError(400,'账号需为 3–32 位字母、数字、点、下划线或短横线。');
  if(typeof password!=='string'||password.length<12||password.length>128)throw new AuthError(400,'密码需为 12–128 位。');
  const salt=randomBytes(16).toString('hex'),hash=(await this.hash(password,salt)).toString('hex');
  const record={version:1,username,salt,hash,createdAt:new Date(this.now()).toISOString()};
  if(this.file){await mkdir(path.dirname(this.file),{recursive:true});try{await writeFile(this.file,JSON.stringify(record,null,2),{flag:'wx',mode:0o600});}catch(error){if(error.code==='EEXIST'){await this.load();throw new AuthError(409,'管理员账号已设置，请直接登录。');}throw error;}}
  if(this.record)throw new AuthError(409,'管理员账号已设置，请直接登录。');this.record=record;
 }
 sweep(){const now=this.now();for(const [key,value]of this.sessions)if(now-value.lastUse>=this.idleMs||now-value.created>=this.absoluteMs)this.sessions.delete(key);for(const [key,value]of this.attempts)if(now-value.start>=15*60*1000)this.attempts.delete(key);}
 async login(username,password,ip,transport){
  await this.ready;this.sweep();if(!this.record)throw new AuthError(503,'请先在服务器电脑设置管理员账号。');
  const attempt=this.attempts.get(ip)||{start:this.now(),count:0};if(attempt.count>=5)throw new AuthError(429,'尝试次数较多，请 15 分钟后重试。');
  if(!this.attempts.has(ip)&&this.attempts.size>=1024)throw new AuthError(429,'登录请求较多，请稍后重试。');
  attempt.count++;this.attempts.set(ip,attempt);
  if(typeof username!=='string'||typeof password!=='string'||password.length>128)throw new AuthError(401,'账号或密码不正确。');
  const hash=await this.hash(password,this.record.salt);
  if(!timingSafeEqual(hash,Buffer.from(this.record.hash,'hex'))||!equalSecret(username,this.record.username))throw new AuthError(401,'账号或密码不正确。');
  this.attempts.delete(ip);if(this.sessions.size>=100)throw new AuthError(429,'登录会话较多，请稍后重试。');
  const value=token(),session={username:this.record.username,csrf:token(),transport,created:this.now(),lastUse:this.now()};this.sessions.set(digest(value),session);return {value,session};
 }
 authenticate(req,transport,{touch=false}={}){
  this.sweep();const name=transport==='secure'?'__Host-traffic_admin':'traffic_admin_local';
  const values=(req.headers.cookie||'').split(';').map(part=>part.trim()).filter(part=>part.startsWith(name+'='));
  if(values.length!==1)return null;const value=values[0].slice(name.length+1);if(!/^[a-zA-Z0-9_-]{43}$/.test(value))return null;
  const session=this.sessions.get(digest(value));if(!session||session.transport!==transport)return null;if(touch)session.lastUse=this.now();return {value,session};
 }
 revoke(value){this.sessions.delete(digest(value));}
 cookie(value,transport,clear=false){return (transport==='secure'?'__Host-traffic_admin':'traffic_admin_local')+'='+value+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+(clear?0:Math.floor(this.absoluteMs/1000))+(transport==='secure'?'; Secure':'');}
}
function validUsername(value){return typeof value==='string'&&/^[a-zA-Z0-9._-]{3,32}$/.test(value);}
