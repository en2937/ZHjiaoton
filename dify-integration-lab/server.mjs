import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {fixture} from './fixtures.mjs';
import {createSandboxClient,places,modes} from './sandbox-client.mjs';
import {ServiceError,withSignal,policyFromEnvironment,policyDefaults} from './request-policy.mjs';
import {createStudentChat} from './student-chat.mjs';

const root = new URL('./', import.meta.url);
const webRoot = new URL('./public/', root);
const LIMIT = 32 * 1024;
class LabError extends ServiceError {}

export async function loadConfig() {
  let saved = {};
  try {saved = JSON.parse(await readFile(new URL('.env.local', root), 'utf8'));}
  catch (e) {if (e.code !== 'ENOENT') throw new Error('本地 Dify 配置格式错误，请重新运行配置程序。');}
  return {
    apiBase: process.env.DIFY_API_BASE || saved.apiBase || 'https://dify-api.zju.edu.cn/v1',
    apiKey: process.env.DIFY_API_KEY || saved.apiKey || '',
    inputs: saved.inputs || {}, timeoutMs: 45000,
  };
}

function apiBase(config) {
  let url;
  try {url = new URL(config.apiBase);}
  catch {throw new LabError(503, 'invalid_config', '请在本地配置程序中填写学校应用的实际 API 地址。');}
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(config.allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
    throw new LabError(503, 'invalid_config', 'API 地址需要使用 HTTPS，且不能包含密钥、查询参数或账号密码。');
  }
  return url.href.replace(/\/$/, '');
}

function requireConfig(config) {
  if (!config.apiKey) throw new LabError(503, 'not_configured', '后端尚未配置应用 API 密钥。请运行独立目录中的“配置Dify.cmd”。');
  return apiBase(config);
}

function upstreamError(status) {
  const messages = {
    401: 'Dify 拒绝密钥，请核对本地配置的应用 API 密钥。',
    403: '学校平台拒绝 API 访问，请检查账号、网络和应用权限。',
    404: 'Dify 接口不存在，请核对应用页面显示的 API 基础地址。',
    429: 'Dify 调用额度或频率已达限制，请稍后再试。',
    400: 'Dify 请求被拒绝，请检查应用是否为 Chatflow／聊天助手、是否已发布，以及必填输入变量。',
  };
  return new LabError(502, 'dify_http_' + status, messages[status] || 'Dify 服务暂时无法完成请求（HTTP ' + status + '）。');
}

async function callDify(config, endpoint, payload, {signal}={}) {
  const base = requireConfig(config);
  let response;
  try {
    response = await fetch(base + endpoint, {
      method: payload ? 'POST' : 'GET', redirect: 'manual',
      headers: {Authorization: 'Bearer ' + config.apiKey, ...(payload ? {'Content-Type': 'application/json'} : {})},
      body: payload ? JSON.stringify(payload) : undefined,
      signal: signal || AbortSignal.timeout(config.timeoutMs || 45000),
    });
  } catch (error) {
    if(signal?.aborted)throw signal.reason;
    throw new LabError(502, error.name === 'TimeoutError' ? 'dify_timeout' : 'dify_network',
      error.name === 'TimeoutError' ? 'Dify 响应超时，可以保留当前状态稍后重试。' : '后端无法连接学校 Dify，请检查校园网／VPN、API 地址和网络访问权限。');
  }
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(()=>{});
    throw new LabError(502, 'dify_redirect', 'API 返回了跳转，可能指向登录页；请核对应用 API 地址和学校访问方式。');
  }
  if (!response.ok) {void response.body?.cancel().catch(()=>{});throw upstreamError(response.status);}
  return response;
}

export async function readReply(response,{signal,onTask=()=>{},onFirstChunk=()=>{}}={}) {
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const reader=response.body.getReader(),decoder=new TextDecoder();let raw='',size=0;
    try {
      while(true){const {value,done}=await withSignal(reader.read(),signal);if(done){raw+=decoder.decode();break;}
        onFirstChunk();size+=value.byteLength;
        if(size>2*1024*1024)throw new LabError(502,'reply_too_large','Dify 回答过大，请缩短问题或应用输出。');
        raw+=decoder.decode(value,{stream:true});}
    }finally{await reader.cancel().catch(()=>{});}
    let data;try{data=JSON.parse(raw);}catch{throw new LabError(502,'invalid_reply','接口返回的数据不是聊天回答。');}
    if (!data||typeof data.answer !== 'string') throw new LabError(502, 'invalid_reply', '接口返回的数据不是聊天回答。');
    return {answer: data.answer, conversationId: data.conversation_id || '', messageId: data.message_id || data.id || ''};
  }
  if (!type.includes('text/event-stream')) {
    void response.body?.cancel().catch(()=>{});
    throw new LabError(502, 'unexpected_content', 'API 返回了网页而非聊天数据，请核对地址、登录和访问权限。');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', answer = '', conversationId = '', messageId = '', size = 0, complete = false;
  function processEvent(block) {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event;
    try {event = JSON.parse(data);} catch {throw new LabError(502, 'invalid_stream', 'Dify 流式回答格式无法解析。');}
    if(typeof event.task_id==='string')onTask(event.task_id);
    if (event.event === 'error') throw new LabError(502, 'dify_run_error', 'Dify 工作流运行失败，请查看学校应用的运行日志和模型配置。');
    if (['message', 'agent_message'].includes(event.event)) answer += event.answer || '';
    if (event.event === 'message_replace') answer = event.answer || '';
    if (event.conversation_id) conversationId = event.conversation_id;
    if (event.message_id) messageId = event.message_id;
    if (event.event === 'message_end') complete = true;
  }
  try {
    while (!complete) {
      const {value, done} = await withSignal(reader.read(),signal);
      if (done) {buffer += decoder.decode(); break;}
      size += value.byteLength;
      onFirstChunk();
      if (size > 2 * 1024 * 1024) throw new LabError(502, 'reply_too_large', 'Dify 回答过大，请缩短问题或应用输出。');
      buffer += decoder.decode(value, {stream: true});
      buffer = buffer.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        processEvent(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
      }
    }
    if (!complete && buffer.trim()) processEvent(buffer);
    if (!complete) throw new LabError(502, 'incomplete_reply', 'Dify 连接中断，未收到完整回答。');
    if (!answer.trim()) throw new LabError(502, 'empty_reply', '工作流没有输出回答，请检查 Answer 节点。');
    return {answer, conversationId, messageId};
  } finally {await reader.cancel().catch(() => {});}
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMIT) throw new LabError(413, 'body_too_large', '请求内容过大。');
    chunks.push(chunk);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch {throw new LabError(400, 'bad_json', '请求需要是有效 JSON。');}
}

export function createLabServer(configProvider = loadConfig,{studentProvider=createSandboxClient(),policy={},onMetric=()=>{}}={}) {
  const options={...policyDefaults,...policy};
  const chat=createStudentChat({studentProvider,configProvider,callDify,readReply,policy:options,onMetric});
  const server = http.createServer(async (req, res) => {
    const send = (status, body,headers={}) => {
      if(res.destroyed||res.writableEnded)return;
      res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',...headers});
      res.end(JSON.stringify(body));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'");
    try {
      const host = req.headers.host || '';
      if (!/^127\.0\.0\.1:\d+$/.test(host)) throw new LabError(403, 'host_rejected', '请使用本机 127.0.0.1 地址。');
      const origin = req.headers.origin;
      if (origin && origin !== 'http://' + host) throw new LabError(403, 'origin_rejected', '仅接受本机测试页面发起的请求。');
      const path = new URL(req.url, 'http://' + host).pathname;
      if (req.method === 'GET' && path === '/api/student/options') {
        const config = await configProvider();
        return send(200,{places,modes,configured:Boolean(config.apiKey),localRoutingEnabled:options.localRoutingEnabled,sourceLabel:'沙盘合成仿真 · 用时与距离为估算'});
      }
      if(req.method==='GET'&&path==='/api/student/state'){
        const params=new URL(req.url,'http://'+host).searchParams;
        const state=await studentProvider({origin:params.get('origin')||'1',destination:params.get('destination')||'2',mode:params.get('mode')||'electric'});
        if(!state)throw new LabError(422,'unknown_trip','这个行程暂时没有路线数据。');
        return send(200,state);
      }
      if (req.method === 'POST' && path === '/api/student/chat') {
        const reply=await chat.handle(req,res,()=>readBody(req),'student');
        return send(reply.status,reply.body,reply.headers);
      }
      if (req.method === 'GET' && path === '/api/status') {
        const config = await configProvider();
        const base = apiBase(config);
        return send(200, {configured: Boolean(config.apiKey), apiBase: base, schoolUrl: 'https://dify.zju.edu.cn/apps', mode: 'real-dify', fixtureNotice: '人工构造接口样例，非沙盘计算'});
      }
      if (req.method === 'GET' && /^\/api\/fixtures\/[AB]$/.test(path)) return send(200, fixture(path.at(-1)));
      if (req.method === 'POST' && path === '/api/check') {
        await readBody(req);
        const response = await callDify(await configProvider(), '/parameters');
        if (!(response.headers.get('content-type') || '').includes('application/json')) throw new LabError(502, 'unexpected_content', 'API 返回了网页，请核对实际 API 地址。');
        const data = await response.json();
        return send(200, {connected: true, requiredInputs: (data.user_input_form || []).map(item => Object.values(item)[0]).filter(Boolean).map(item => ({variable: item.variable, type: item.type, required: item.required}))});
      }
      if (req.method === 'POST' && path === '/api/chat') {
        const reply=await chat.handle(req,res,()=>readBody(req),'lab');
        return send(reply.status,reply.body,reply.headers);
      }
      if (req.method === 'GET' && path === '/') {
        res.writeHead(302, {Location: '/student/', 'Cache-Control': 'no-store'}); res.end(); return;
      }
      const files = {
        '/student/':['student/index.html','text/html'],'/student':['student/index.html','text/html'],
        '/student/app.mjs':['student/app.mjs','text/javascript'],'/student/style.css':['student/style.css','text/css'],
        '/student/emblem.png':['student/emblem.png','image/png']};
      if (req.method === 'GET' && files[path]) {
        const [file, type] = files[path];
        const data = await readFile(new URL(file, webRoot));
        res.writeHead(200, {'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(data); return;
      }
      throw new LabError(404, 'not_found', '路径不存在。');
    } catch (error) {
      send(error.status || 500, {error: error.code || 'internal_error', message: error instanceof LabError ? error.message : '服务暂不可用，请稍后重试。'});
    }
  });
  const close=server.close;
  server.close=function(...args){chat.close();return close.apply(this,args);};
  server.chatStats=chat.stats;
  server.requestTimeout = 65000;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.DIFY_LAB_PORT || 4183);
  const server = createLabServer(loadConfig,{policy:policyFromEnvironment(),onMetric:record=>console.log(JSON.stringify({type:'student-request',...record}))});
  server.on('error', e => {console.error(e.code === 'EADDRINUSE' ? '独立测试端口已占用，请使用 DIFY_LAB_PORT 指定其他端口。' : '独立测试服务无法启动。'); process.exitCode = 1;});
  server.listen(port, '127.0.0.1', () => console.log('Dify integration lab: http://127.0.0.1:' + port));
}
