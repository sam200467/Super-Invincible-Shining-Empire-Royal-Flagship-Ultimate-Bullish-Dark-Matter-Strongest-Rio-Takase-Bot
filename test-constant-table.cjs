const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const assert=require('node:assert/strict');
const file=path.resolve('ongeki-exe.js');
const source=fs.readFileSync(file,'utf8');
const loaded=new Module(file,module);loaded.filename=file;loaded.paths=module.paths;
loaded._compile(source.slice(0,source.lastIndexOf('\nmain().catch'))+'\nmodule.exports={buildConstantTableData,levelScoreCharts};',file);
const {buildConstantTableData:build,levelScoreCharts:all}=loaded.exports;
for(let i=0;i<=20;i++){
 const expected=all('ABFB').filter(c=>Number.isFinite(c.constant)&&Math.floor(c.constant)===i);
 if(!expected.length){assert.throws(()=>build(String(i)));continue;}
 const data=build(String(i));assert.equal(data.total,expected.length);
 assert.deepEqual(data.groups.map(g=>Number(g.constant)),[...new Set(expected.map(c=>c.constant))]);
 for(const group of data.groups){const exact=build(group.constant);assert.equal(exact.groups.length,1);assert.deepEqual(exact.groups[0].charts,group.charts);}
 assert(data.canvas.height<32767);
}
for(const invalid of ['',null,'14+','14.20','20.1','-1','NaN','1e1','14abc'])assert.throws(()=>build(invalid));
assert.equal(build('14.2').total,40);assert(build('14').total>40);assert.equal(build('14.0').groups.length,1);
console.log('Constant table tests passed: all integer ranges, exact groups, empty and invalid queries, canvas bounds.');
