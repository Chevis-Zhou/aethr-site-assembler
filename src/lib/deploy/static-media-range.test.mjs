import test from 'node:test';
import assert from 'node:assert/strict';
import {createStaticMediaRangeHandler} from './static-media-range.mjs';
const encode = text => new TextEncoder().encode(text);
function fixture({status=200, headers={}, chunks=['012','3456','789'], length='10'}={}) {
  const state={calls:[],reads:0,cancelled:0};
  const body=new ReadableStream({pull(controller){state.reads++;if(chunks.length)controller.enqueue(encode(chunks.shift()));else controller.close()},cancel(){state.cancelled++}}, {highWaterMark:0});
  const response=new Response(body,{status,headers:{'content-type':'video/mp4','content-length':length,etag:'"asset-v1"','last-modified':'Wed, 04 Nov 2026 12:00:00 GMT',...headers}});
  return {state,response,env:{ASSETS:{fetch:async request=>{state.calls.push(request);return response}}}};
}
const request=(range,method='GET',extra={})=>new Request('https://media.example/media/demo.mp4',{method,headers:{...(range?{range}:{}),...extra}});
const handler=createStaticMediaRangeHandler();

test('single-byte and boundary-spanning ranges preserve asset headers and cancel remaining bytes',async()=>{
 for(const [range,expected,contentRange]of [['bytes=0-0','0','bytes 0-0/10'],['bytes=2-7','234567','bytes 2-7/10'],['bytes=3-6','3456','bytes 3-6/10']]){
  const f=fixture();const r=await handler(request(range),f.env);assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),contentRange);assert.equal(r.headers.get('content-length'),String(expected.length));assert.equal(r.headers.get('accept-ranges'),'bytes');assert.equal(r.headers.get('etag'),'"asset-v1"');assert.equal(r.headers.get('content-type'),'video/mp4');assert.equal(await r.text(),expected);assert.equal(f.state.cancelled,1);assert.equal(f.state.calls[0].headers.get('accept-encoding'),'identity');
 }
});
test('suffix, open, clamped and large decimal ranges',async()=>{
 for(const [range,expected]of [['bytes=-3','789'],['bytes=7-','789'],['bytes=8-999999999999999999999999','89'],['bytes=-999999999999999999999999','0123456789']]){const f=fixture();const r=await handler(request(range),f.env);assert.equal(r.status,206);assert.equal(await r.text(),expected)}
});
test('invalid, multiple and unsatisfiable ranges return empty 416 with complete size',async()=>{
 for(const value of ['bytes=10-','bytes=8-2','bytes=-0','bytes=-','bytes=0-1,4-5','items=0-1','bytes=x-2','bytes=1.5-3','bytes=999999999999999999999999-']){const f=fixture();const r=await handler(request(value),f.env);assert.equal(r.status,416,value);assert.equal(r.headers.get('content-range'),'bytes */10');assert.equal(r.headers.get('content-length'),'0');assert.equal(await r.text(),'');assert.equal(f.state.cancelled,1);assert.equal(f.state.reads,0)}
 const f=fixture({length:'0',chunks:[]});assert.equal((await handler(request('bytes=0-0'),f.env)).status,416);
});
test('stream reads only as far as requested, handles skip chunks and caller cancellation',async()=>{
 const f=fixture({chunks:['01','23','45','67','89']});const r=await handler(request('bytes=4-5'),f.env);assert.equal(f.state.reads,0);assert.equal(await r.text(),'45');assert.equal(f.state.reads,3);assert.equal(f.state.cancelled,1);
 const c=fixture();const output=await handler(request('bytes=0-8'),c.env);const reader=output.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'012');await reader.cancel('viewer closed');assert.equal(c.state.reads,1);assert.equal(c.state.cancelled,1);
});
test('HEAD ignores Range, retains representation headers and reads no bytes',async()=>{
 const f=fixture();const r=await handler(request('bytes=2-4','HEAD'),f.env);assert.equal(r.status,200);assert.equal(r.body,null);assert.equal(r.headers.get('content-length'),'10');assert.equal(r.headers.get('etag'),'"asset-v1"');assert.equal(r.headers.get('accept-ranges'),'bytes');assert.equal(f.state.calls[0].headers.has('range'),false);assert.equal(f.state.reads,0);assert.equal(f.state.cancelled,1);
});
test('existing upstream 206, missing assets and other statuses are untouched',async()=>{
 for(const status of [206,404,403]){const f=fixture({status});assert.equal(await handler(request('bytes=1-3'),f.env),f.response);assert.equal(f.state.reads,0)}
});
test('encoded or unknown representation size falls back without unsafe slicing',async()=>{
 for(const headers of [{'content-encoding':'gzip'},{'content-encoding':'br'},{'content-length':'unknown'},{'content-length':'9007199254740992'}]){const f=fixture({headers});assert.equal(await handler(request('bytes=0-0'),f.env),f.response);assert.equal(f.state.reads,0)}
 const f=fixture();f.response.headers.delete('content-length');assert.equal(await handler(request('bytes=0-0'),f.env),f.response);
});
test('uses the deployed asset length only when the binding omits an identity length', async () => {
 const paths = [];
 const handler = createStaticMediaRangeHandler({
  getAssetSize(pathname) {
   paths.push(pathname);
   return pathname === '/media/demo.mp4' ? 10 : undefined;
  },
 });
 const missingLength = fixture();
 missingLength.response.headers.delete('content-length');
 const partial = await handler(request('bytes=7-'), missingLength.env);
 assert.equal(partial.status, 206);
 assert.equal(partial.headers.get('content-range'), 'bytes 7-9/10');
 assert.equal(await partial.text(), '789');

 const encoded = fixture({headers:{'content-encoding':'br'}});
 encoded.response.headers.delete('content-length');
 assert.equal(await handler(request('bytes=0-0'), encoded.env), encoded.response);

 const declaredLength = fixture();
 const declared = await handler(request('bytes=0-0'), declaredLength.env);
 assert.equal(await declared.text(), '0');
 assert.deepEqual(paths, ['/media/demo.mp4']);
});
test('If-Range only slices matching strong validator or unmodified date',async()=>{
 for(const [value,status]of [['"asset-v1"',206],['"other"',200],['W/"asset-v1"',200],['Wed, 04 Nov 2026 13:00:00 GMT',206],['Wed, 04 Nov 2026 11:00:00 GMT',200],['not-a-date',200]]){const f=fixture();assert.equal((await handler(request('bytes=0-0','GET',{'if-range':value}),f.env)).status,status,value)}
});
test('no Range advertises support and preserves the entire representation',async()=>{const f=fixture();const r=await handler(request(),f.env);assert.equal(r.status,200);assert.equal(r.headers.get('accept-ranges'),'bytes');assert.equal(await r.text(),'0123456789')});
test('non-media and non-read methods delegate original request unchanged; selection is configurable',async()=>{
 const f=fixture();const req=new Request('https://media.example/page.html');assert.equal(await handler(req,f.env),f.response);assert.equal(f.state.calls[0],req);
 const p=fixture();const post=new Request('https://media.example/demo.mp4',{method:'POST',body:'x'});assert.equal(await handler(post,p.env),p.response);assert.equal(p.state.calls[0],post);
 const custom=createStaticMediaRangeHandler({matches:pathname=>pathname==='/clip'}),c=fixture();assert.equal((await custom(new Request('https://media.example/clip',{headers:{range:'bytes=1-2'}}),c.env)).status,206);
});
test('premature asset stream termination errors rather than silently claiming a full range',async()=>{const f=fixture({chunks:['01']});const r=await handler(request('bytes=0-5'),f.env);await assert.rejects(r.text(),/ended before/)});

test('an upstream cancellation rejection does not corrupt already completed selected bytes',async()=>{
 const body=new ReadableStream({pull(c){c.enqueue(encode('0123456789'))},cancel(){throw Error('upstream cancel failed')}},{highWaterMark:0});
 const env={ASSETS:{fetch:async()=>new Response(body,{headers:{'content-length':'10'}})}};
 const r=await handler(request('bytes=0-0'),env);assert.equal(await r.text(),'0');
});
