// Isolated browser acceptance harness. Never loads or changes the production account.
import {createAdminServer} from '../server.mjs';
import {IsolatedAdminAuth} from './isolated-auth.mjs';
import {loadAdminAiConfig} from '../ai.mjs';
import {SharedSimulation} from '../../traffic-sandbox/shared-simulation.mjs';
import {createSandboxServer} from '../../traffic-sandbox/server.mjs';
const mock=process.argv.includes('--mock');
const config=mock?{apiKey:'browser-test-only'}:await loadAdminAiConfig();
if(!config.apiKey)throw new Error('Configure the admin application before a live browser test, or explicitly select --mock.');
const runtime=new SharedSimulation({running:false,settings:{demand:30,northBypassShare:60}});runtime.sim.step(360);
const bridgeKey='isolated-browser-test-bridge',sandbox=createSandboxServer({runtime,clock:false,controlKey:bridgeKey});
await new Promise(resolve=>sandbox.listen(0,'127.0.0.1',resolve));
const auth=new IsolatedAdminAuth();await auth.setup('ai_browser_test','only-isolated-browser-test');
const model=async(_,payload)=>{
 const query=JSON.parse(payload.query),question=query.question;
 const answer={protocol:'campus-admin-v2',status:'ok',intent:'inspect',state_version:query.state.stateVersion,reply:'当前为模拟交通。A路口可比较配时与北侧绕行策略。',basis:query.state.behavior?.enabled?'本次参考了路线认知、尝试意愿和引导触达；{{behavior.facts.eligible}}。':'当前未启用认知与意愿分组，本次仍按原选路规则分析',changes:{},suggested_settings:{},evidence:query.state.behavior?.enabled?['behavior.facts.eligible']:['settings.northBypassShare']};
 if(/优化/.test(question)){Object.assign(answer,{intent:'suggest',reply:'建议比较北侧绕行策略目标，观察各路口队列。此处为浏览器测试回复。',suggested_settings:{northBypassShare:80}});}
 else if(/(?:150|灯.*10|宽度)/.test(question)){Object.assign(answer,{status:'invalid_request',reply:'这项调整不在可用范围内，参数未改变。'});}
 else if(/绕行/.test(question)&&/80/.test(question)){Object.assign(answer,{intent:'set',changes:{northBypassShare:80}});}
 else if(/电动车/.test(question)&&/50/.test(question)){Object.assign(answer,{intent:'set',changes:{electric:50}});}
 return {answer:JSON.stringify(answer),conversationId:'isolated-test-conversation'};
};
const server=createAdminServer({auth,bridgeKey,sandboxPort:sandbox.address().port,port:4194,aiConfigProvider:async()=>config,...(mock?{aiModel:model}:{})});
await new Promise(resolve=>server.listen(4194,'127.0.0.1',resolve));
console.log(JSON.stringify({mode:mock?'mock-browser-fixture':'school-dify-browser-fixture',url:'http://127.0.0.1:4194/login',pid:process.pid}));
const stop=()=>{server.closeAllConnections();sandbox.closeAllConnections();server.close();sandbox.close();};
setTimeout(stop,20*60*1000).unref();for(const event of ['SIGINT','SIGTERM'])process.once(event,stop);
