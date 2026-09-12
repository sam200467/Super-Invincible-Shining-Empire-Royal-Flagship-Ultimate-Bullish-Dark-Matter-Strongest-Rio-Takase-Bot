"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Converter } = require('opencc-js');
const { SongAliasStore } = require('./song-alias-store.cjs');
const simplify = Converter({from:'tw',to:'cn'});
const normalize = value => simplify(value.normalize('NFKC').trim().toLowerCase());
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takase-alias-test-'));
const file = path.join(dir,'aliases.json');
try {
 const store = new SongAliasStore(file,normalize);
 store.load();
 assert.deepEqual(store.list(870), []);
 assert.equal(store.add(870,'愛探險','user').added,true);
 assert.equal(store.add(870,'爱探险','user').added,false);
 assert.equal(store.matches(870,normalize('爱探'),false),true);
 assert.equal(store.matches(870,normalize('爱探'),true),false);
 store.add(168,'愛探險','other');
 const reload = new SongAliasStore(file,normalize);
 reload.load();
 assert.deepEqual(reload.list(870),['愛探險']);
 assert.equal(reload.matches(168,normalize('爱探险'),true),true);
 for(const invalid of ['', '  ', 'id870', '８７０', 'x'.repeat(81), 'a\u200bb']) assert.throws(()=>store.add(870,invalid,'user'));
 const before = fs.readFileSync(file,'utf8');
 const rename = fs.renameSync;
 try {fs.renameSync = () => {throw Error('simulated disk failure');}; assert.throws(()=>store.add(870,'failed write','user')); assert.throws(()=>store.remove(870,'爱探险')); }
 finally {fs.renameSync = rename;}
 assert.equal(fs.readFileSync(file,'utf8'),before);
 assert.equal(store.matches(870,'failed write'),false);
 assert.equal(store.matches(870,normalize('爱探险'),true),true);
 assert.equal(store.remove(870,'爱探险').removed,true);
 assert.equal(store.remove(870,'爱探险').removed,false);
 reload.load();
 assert.deepEqual(reload.list(870),[]);
 assert.deepEqual(reload.list(168),['愛探險']);
 fs.writeFileSync(file,'broken json');
 assert.throws(()=>reload.load(),/原文件未修改/);
 assert.equal(fs.readFileSync(file,'utf8'),'broken json');
 console.log('SONG_ALIAS_STORE_TEST_OK');
} finally {
 // Only remove the exact files created in the fresh test directory.
 for(const entry of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir,entry));
 fs.rmdirSync(dir);
}
