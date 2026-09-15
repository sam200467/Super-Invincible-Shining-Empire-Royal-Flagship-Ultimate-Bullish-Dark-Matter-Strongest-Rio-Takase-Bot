const {test} = require("node:test");
const assert = require("node:assert/strict");
const {registerCommands, detail} = require("./discord-startup.cjs");
const options = {log:()=>{},sleep:async()=>{}};
test("transient registration error retries and recovers", async()=>{
 let calls=0;
 assert.equal(await registerCommands(async()=>{if(++calls<3) throw {status:500};},options),true);
 assert.equal(calls,3);
});
test("persistent server failure allows gateway connection", async()=>{
 let calls=0;
 assert.equal(await registerCommands(async()=>{calls++;throw new Error("Internal Server Error");},options),false);
 assert.equal(calls,3);
});
test("permission and credential errors fail immediately without leaking secrets", async()=>{
 for(const status of [401,403,404]){
 let calls=0;
 await assert.rejects(registerCommands(async()=>{calls++;throw {status,message:"sensitive",requestBody:{token:"secret"}};},options),e=>e.message.includes(String(status))&&!e.message.includes("secret")&&!e.message.includes("sensitive"));
 assert.equal(calls,1);
 }
});
test("network cause retries and diagnostics include only safe codes",async()=>{
 let calls=0;
 assert.equal(await registerCommands(async()=>{if(++calls===1)throw {cause:{code:"ECONNRESET"}};},options),true);
 assert.equal(detail({status:502,code:"sensitive value"}),"HTTP 502");
});
