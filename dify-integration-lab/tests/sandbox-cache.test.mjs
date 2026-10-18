import test from 'node:test';
import assert from 'node:assert/strict';
import {SharedSimulation} from '../../traffic-sandbox/shared-simulation.mjs';
import {createSandboxClient} from '../sandbox-client.mjs';

const trip={origin:'1',destination:'2',mode:'electric'};
const packet=()=>new SharedSimulation({running:false}).packet();
const response=value=>({ok:true,json:async()=>value});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('polling shares snapshots for 500ms, fresh bypasses stored snapshots, trip conversion is bounded',async()=>{
  let now=0,calls=0;const snapshot=packet();
  const client=createSandboxClient({now:()=>now,maxCacheEntries:2,fetcher:async()=>{calls++;return response(snapshot);}});
  const first=await client(trip);assert.equal(await client(trip),first);assert.equal(calls,1);
  now=499;assert.equal(await client(trip),first);assert.equal(calls,1);
  const second=await client({...trip,mode:'bicycle'});assert.notEqual(second,first);
  await client({...trip,origin:'2',destination:'1'});
  assert.notEqual(await client(trip),first,'oldest derived value was evicted');
  now=500;await client(trip);assert.equal(calls,2);
  await client(trip,{fresh:true});assert.equal(calls,3);
  await client({...trip,untrusted:'x'});assert.equal(calls,3);
  assert.equal(await client({...trip,origin:'unexpected'}),null);assert.equal(calls,3);
});

test('concurrent polling and fresh reads share one fetch and one cancelled subscriber does not cancel peers',async()=>{
  const gate=deferred();let calls=0,upstreamSignal;
  const client=createSandboxClient({fetcher:async(_url,{signal})=>{calls++;upstreamSignal=signal;await gate.promise;return response(packet());}});
  const cancel=new AbortController();
  const a=client(trip,{signal:cancel.signal}),b=client(trip,{fresh:true});
  cancel.abort();await assert.rejects(a,{name:'AbortError'});
  assert.equal(upstreamSignal.aborted,false);gate.resolve();assert.equal((await b).routes.length,3);assert.equal(calls,1);
});

test('last subscriber cancellation aborts upstream and a new request starts a new fetch',async()=>{
  const gate=deferred();let calls=0,firstSignal;
  const client=createSandboxClient({fetcher:async(_url,{signal})=>{calls++;if(calls===1){firstSignal=signal;await gate.promise;}return response(packet());}});
  const cancel=new AbortController(),waiting=client(trip,{signal:cancel.signal});
  cancel.abort();await assert.rejects(waiting,{name:'AbortError'});assert.equal(firstSignal.aborted,true);
  const next=await client(trip);assert.equal(next.routes.length,3);assert.equal(calls,2);gate.resolve();
});

test('failed refresh clears stale data and subsequent reads must retry, timeouts are bounded',async()=>{
  let calls=0;const client=createSandboxClient({fetcher:async()=>{calls++;if(calls===2)throw Error('offline');return response(packet());}});
  await client(trip);await assert.rejects(client(trip,{fresh:true}),{code:'sandbox_unavailable'});
  await client(trip);assert.equal(calls,3);
  const hung=createSandboxClient({timeoutMs:20,fetcher:async()=>new Promise(()=>{})});
  await assert.rejects(hung(trip),{code:'sandbox_unavailable'});
  const cancel=new AbortController();cancel.abort();
  await assert.rejects(client(trip,{signal:cancel.signal}),{name:'AbortError'});assert.equal(calls,3);
});

test('fresh subscribers coalesce while stale snapshot is never returned after a failed pending refresh',async()=>{
  let calls=0;const gate=deferred();
  const client=createSandboxClient({fetcher:async()=>{if(++calls===1)return response(packet());await gate.promise;throw Error('offline');}});
  await client(trip);const a=client(trip,{fresh:true}),b=client(trip);
  gate.resolve();await Promise.all([assert.rejects(a,{code:'sandbox_unavailable'}),assert.rejects(b,{code:'sandbox_unavailable'})]);
  assert.equal(calls,2);
});

test('invalid sandbox packets fail clearly and are not cached',async()=>{
  let calls=0;const client=createSandboxClient({fetcher:async()=>response(++calls===1?{source:'fixture'}:packet())});
  await assert.rejects(client(trip),{code:'sandbox_unavailable'});
  assert.equal((await client(trip)).routes.length,3);assert.equal(calls,2);
});
