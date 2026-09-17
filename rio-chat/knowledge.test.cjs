"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {lookup,loadKnowledge,constrainQuery}=require('./knowledge.cjs');
test('explicit red charts survive incorrect model filters and negative purple mention',()=>{
 const messages=[{role:'user',content:'推荐音击13级谱面'},{role:'user',content:'选一些红谱吧，紫谱太复杂，随便选'}];
 assert.deepEqual(constrainQuery({game:'maimai',difficulty:'MAS'},messages),{game:'ongeki',difficulty:'EXP',level:'13'});
 assert.equal(constrainQuery({game:'maimai'},[{role:'user',content:'舞萌不要红谱，推荐紫谱'}]).difficulty,'MAS');
 assert.equal(constrainQuery({game:'maimai',difficulty:'MAS'},[{role:'user',content:'推荐3首舞萌13级红谱'}]).difficulty,'EXP');
});
test('level is read without the word 级, and never from an unrelated number',()=>{
 const of=(text,guess={game:'maimai'})=>constrainQuery(guess,[{role:'user',content:text}]).level;
 // 圈内更常写「音击 13 红谱」「舞萌 13+」，不带「级」。漏掉会让模型猜错的等级
 // 一路带进检索：问 13+ 却查出 12。
 assert.equal(of('推荐几首音击 13 红谱，随便选'),'13');
 assert.equal(of('推荐几首舞萌 13+，适合练交互的',{game:'chunithm',level:'12'}),'13+');
 assert.equal(of('中二 14 紫谱推荐'),'14');
 assert.equal(of('舞萌13+ 红谱推荐',{level:'13'}),'13+');
 // 数量词和无关数字是这条规则唯一的误伤来源，必须挡住。
 assert.equal(of('推荐3首音击13红谱'),'13');
 assert.equal(of('推荐10首舞萌13+'),'13+');
 assert.equal(of('我14岁，推荐几首舞萌的歌'),undefined);
 assert.equal(of('推荐几首舞萌的歌'),undefined);
});
const {requestReply}=require('./chat.cjs');
const {needsPersonalRecords,bindingNotice}=require('./personal-recommendation.cjs');
test('personal recommendations never reach model or public lookup without records',async()=>{
 for(const content of ['宝宝来点我没鸟过的12+推荐','推荐没打过的13级','根据我的成绩推荐几首','推荐未SSS的12+','给他挑没AP的歌']){
  assert.ok(needsPersonalRecords([{role:'user',content}]));
  let called=false;
  const result=await requestReply({},[{role:'user',content}],{fetchImpl:()=>{called=true;throw Error('must not call')},personalRecommendationNotice:()=>bindingNotice(async()=>null,'u',[],'请私聊 #绑定。')});
  assert.equal(called,false);assert.match(result.text,/没有绑定/);assert.equal(result.action,undefined);
 }
 assert.ok(needsPersonalRecords([{role:'user',content:'推荐我没鸟的12+'},{role:'assistant',content:'无法读取成绩'},{role:'user',content:'那随便选'}]));
 assert.equal(needsPersonalRecords([{role:'user',content:'推荐我没鸟的12+'},{role:'user',content:'不用看成绩，普通推荐12+'}]),false);
 assert.equal(needsPersonalRecords([{role:'user',content:'推荐一些12+'}]),false);
 assert.equal(needsPersonalRecords([{role:'user',content:'没鸟过是什么意思'}]),false);
});
test('bound is not equivalent to fetched, and other player permissions are enforced',async()=>{
 assert.match(await bindingNotice(async()=>({}),'u'),/没有接入按个人成绩筛选/);
 assert.match(await bindingNotice(async()=>null,'u',['other']),/对方还没有绑定/);
 assert.match(await bindingNotice(async()=>({allowOthers:false}),'u',['other']),/没有开放/);
 assert.match(await bindingNotice(async()=>({allowOthers:true}),'u',['other']),/没有接入/);
});
const knowledge={catalogs:{ongeki:{source:'test',scope:'fixture',charts:[
 {id:'1',title:'Alpha',difficulty:'EXP',level:'13'},
 {id:'1',title:'Alpha',difficulty:'MAS',level:'13+'},
 {id:'2',title:'Beta',difficulty:'EXP',level:'13+'}
]}}};
test('strict level and difficulty; no invented fallback; normalized title',()=>{
 assert.deepEqual(lookup(knowledge,{game:'ongeki',difficulty:'EXP',level:'13'}).charts.map(x=>x.title),['Alpha']);
 assert.equal(lookup(knowledge,{game:'ongeki',difficulty:'EXP',level:'14'}).total,0);
 assert.equal(lookup(knowledge,{game:'ongeki',title:'ＡＬＰＨＡ'}).total,2);
 assert.ok(lookup(knowledge,{game:'invalid'}).error);
 assert.ok(lookup(knowledge,{game:'maimai'}).error);
});
test('queries are read-only and evidence reaches final and degraded replies',async()=>{
 for(const degrade of [false,true]){
  const requests=[];let n=0;
  const settings={knowledge,persona:'test',examples:[],manifest:{entries:[]},c:{provider:{model:'test',timeoutMs:10000,baseUrl:'https://api.deepseek.com',endpoint:'/chat/completions',apiKey:'fixture-secret'},limits:{maxReplyChars:600}}};
  const reply=await requestReply(settings,[{role:'user',content:'音击13红谱随便选'}],{fetchImpl:async(u,o)=>{
   requests.push(JSON.parse(o.body));n++;
   const content=n===1?JSON.stringify({knowledgeQuery:{game:'ongeki',difficulty:'EXP',level:'13'}}):n===2&&degrade?' ':JSON.stringify({text:'Alpha EXP 13',scene:'explanation'});
   return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content}}]}),json:async()=>({choices:[{message:{content}}]})};
  }});
  assert.equal(reply.text,'Alpha EXP 13');
  assert.ok(requests.at(-1).messages.some(m=>m.content.includes('"title":"Alpha"')));
  assert.ok(!requests.at(-1).messages.some(m=>m.content.includes('"title":"Beta"')));
 }
});
test('real snapshots provide exact expert 13 candidates for all games',()=>{
 const k=loadKnowledge(__dirname);
 for(const game of ['ongeki','chunithm','maimai']){
  const result=lookup(k,{game,difficulty:'EXP',level:'13'});
  assert.ok(result.total>0,game);assert.ok(result.charts.every(c=>c.difficulty==='EXP'&&c.level==='13'));
 }
});
test('曲名识别：真曲名命中，规范化后过短的曲名不许匹配一切',()=>{
 const {matchTitle}=require('./knowledge.cjs');
 const k=loadKnowledge(__dirname);
 // 曲库里有「+♂」这种规范化后是空串的曲名：空串 includes 恒真，会匹配每一句话。
 assert.ok(k.titles.every(t=>t.normalized.length>=3),'索引里不许有规范化后过短的曲名');
 assert.equal(matchTitle(k,'今天好累啊'),null);
 assert.equal(matchTitle(k,'呵呵，你也就这样了'),null);
 assert.equal(matchTitle(k,'PANDORA PARADOXXX 难吗').title,'PANDORA PARADOXXX');
 // 没有曲库索引（公开版克隆、测试夹具）时安全退化成不识别
 assert.equal(matchTitle({catalogs:{}}, 'PANDORA PARADOXXX'),null);
 assert.equal(matchTitle(undefined,'PANDORA PARADOXXX'),null);
});
// ── 端到端：拿用户实际会问的句子跑完整链路（真实曲库 + 桩模型）──────────
// 桩模型按脚本依次吐「工具调用 → 最终回答」，复刻 DeepSeek 的 JSON 契约，
// 这样能验证程序侧真正的行为：筛得对不对、资料有没有送到、来源有没有附上。
const flowSettings=()=>({knowledge:loadKnowledge(__dirname),persona:'test',examples:[],manifest:{entries:[]},
 search:{apiKey:'kimi-fixture',cache:new Map()},
 c:{provider:{model:'test',timeoutMs:10000,baseUrl:'https://api.deepseek.com',endpoint:'/chat/completions',apiKey:'deepseek-fixture'},limits:{maxReplyChars:600}}});
const evidenceOf=body=>body.messages
 .filter(m=>typeof m.content==='string'&&m.content.startsWith('【程序检索结果'))
 .map(m=>JSON.parse(m.content.slice(m.content.indexOf('\n')+1)));
const scripted=replies=>{const state={bodies:[],urls:[]};state.fetchImpl=async(u,o)=>{
 state.bodies.push(JSON.parse(o.body));
 const content=replies[Math.min(state.bodies.length-1,replies.length-1)];
 return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content}}]}),json:async()=>({choices:[{message:{content}}]})};};return state;};
// 注意返回的是「取数据的函数」而不是数据本身：fetchImpl 必须是可调用的。
const webStub=(urls,data)=>async url=>{urls.push(String(url));return {ok:true,json:async()=>data};};
test('端到端：推荐音击13红谱随便选 —— 按用户明说的条件筛，答完不再追问',async()=>{
 // 模型故意猜错成「舞萌 / 紫谱 / 12」，程序必须用用户说的「音击 / 红谱 / 13」压过去
 const m=scripted([JSON.stringify({knowledgeQuery:{game:'maimai',difficulty:'MAS',level:'12'}}),
   JSON.stringify({text:'给你挑了 3 首音击红谱 13 的曲子。',scene:'explanation'})]);
 const reply=await requestReply(flowSettings(),[{role:'user',content:'推荐几首音击 13 红谱，随便选'}],{fetchImpl:m.fetchImpl});
 const ev=evidenceOf(m.bodies.at(-1));
 assert.equal(ev.length,1);
 assert.deepEqual(ev[0].query,{game:'ongeki',difficulty:'EXP',level:'13'});
 assert.ok(ev[0].total>0,'真实曲库应命中候选');
 assert.ok(ev[0].charts.every(c=>c.difficulty==='EXP'&&c.level==='13'));
 assert.equal(reply.text,'给你挑了 3 首音击红谱 13 的曲子。');
 assert.equal(reply.action,undefined);
});
test('端到端：推荐舞萌13+适合练交互的 —— 曲库先筛，再联网，来源由程序附上',async()=>{
 const m=scripted([JSON.stringify({knowledgeQuery:{game:'maimai',level:'13+'}}),
   JSON.stringify({webQuery:{query:'maimai 13+ 交互 练习 谱面',kind:'article'}}),
   JSON.stringify({text:'这几首 13+ 的交互段比较规整，适合先摸。',sourceIds:['S1'],scene:'explanation'})]);
 const webUrls=[];
 const reply=await requestReply(flowSettings(),[{role:'user',content:'推荐几首舞萌 13+，适合练交互的'}],{
  fetchImpl:m.fetchImpl,
  webFetchImpl:webStub(webUrls,{search_results:[{title:'舞萌13+ 交互谱面整理',url:'https://example.com/maimai-13',snippet:'介绍',chunks:[{text:'正文片段'}]}]})});
 assert.ok(webUrls[0].endsWith('/search_pro'),'有正文需求的攻略查询走 Pro');
 const ev=evidenceOf(m.bodies.at(-1));
 assert.equal(ev.length,2,'曲库结果和联网资料都要进证据');
 assert.deepEqual(ev[0].query,{game:'maimai',level:'13+'});
 assert.ok(ev[0].charts.every(c=>c.level==='13+'),'13 和 13+ 不能混');
 assert.equal(ev[1].sources[0].url,'https://example.com/maimai-13');
 assert.equal(ev[1].sources[0].evidence,'body');
 assert.match(reply.text,/舞萌13\+ 交互谱面整理/);
 assert.match(reply.text,/https:\/\/example\.com\/maimai-13/);
});
test('端到端：找手元视频 —— 只给真实标题和链接，不假装看过视频',async()=>{
 const m=scripted([JSON.stringify({webQuery:{query:'オンゲキ BATTLE NO.1 EXPERT 手元',kind:'video'}}),
   JSON.stringify({text:'找到这支手元，点开自己看。',sourceIds:['S1'],scene:'explanation'})]);
 const webUrls=[];
 const reply=await requestReply(flowSettings(),[{role:'user',content:'找一下这首歌的手元视频'}],{
  fetchImpl:m.fetchImpl,
  webFetchImpl:webStub(webUrls,{search_results:[{title:'【音击】BATTLE NO.1 EXPERT 手元',url:'https://www.bilibili.com/video/BV1xx',snippet:'手元动画'}]})});
 const ev=evidenceOf(m.bodies.at(-1));
 assert.ok(webUrls[0].endsWith('/search'),'视频走 Basic 搜索，不消耗 Pro 的正文抓取');
 assert.equal(ev[0].sources[0].kind,'video');
 assert.equal(ev[0].sources[0].content,'','没有读取视频内容，正文必须为空');
 assert.match(reply.text,/BV1xx/);
 assert.doesNotMatch(reply.text,/\d+:\d+/,'没有证据就不能编时间点');
});
test('端到端：搜索失败时明说没资料，不退化成编造',async()=>{
 const m=scripted([JSON.stringify({webQuery:{query:'音击 冷门曲 攻略',kind:'article'}}),
   JSON.stringify({text:'这首的攻略我没找到可靠资料。',scene:'explanation'})]);
 const reply=await requestReply(flowSettings(),[{role:'user',content:'这首冷门歌有什么攻略？'}],{
  fetchImpl:m.fetchImpl,webFetchImpl:async()=>{throw Error('boom')}});
 assert.match(reply.text,/没有拿到可核实的网页资料/);
});
