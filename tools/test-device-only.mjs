import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const read=n=>fs.readFileSync(`tools/patches/${n}.replace`,'utf8');
let stored;
const context=vm.createContext({window:{CineCloud:{blockEmptyOverwrite:()=>false,noteQueueCount(){},putVault:async(k,v)=>{stored=v},getVaultCipher:async()=>({data:stored}),markReadFailure(){}}},bS:async v=>JSON.stringify(v),Gm:async v=>JSON.parse(v)});
vm.runInContext(read('28-device-vault-write')+read('29-device-vault-read')+';this.api={Km,SS}',context);
const queue=[{id:'1',status:'scheduled',scheduledAt:'2026-10-04T12:00',videoBlob:'local'},{id:'2',status:'published'},{id:'3',status:'error'}];
await context.api.Km({}, {queue});
assert.equal(JSON.parse(stored).queue[0].status,'device_scheduled');
assert.equal(JSON.parse(stored).queue[0].videoBlob,undefined);
assert.equal(queue[0].status,'scheduled');
const restored=await context.api.SS({});
assert.equal(restored.queue[0].status,'scheduled');
assert.equal(restored.queue[1].status,'published');
assert.equal(restored.queue[2].status,'error');
for(const file of ['index.html','app-pronto.html','404.html']) {
 const html=fs.readFileSync(file,'utf8');
 assert.ok(html.includes(read('28-device-vault-write').trim()));
 assert.ok(html.includes(read('29-device-vault-read').trim()));
 assert.ok(!html.includes('Outro aparelho ou o Robô 24h está a publicar'));
}
console.log('✅ Fila preservada; robô antigo ignora agendamentos sincronizados; leitura restaura publicação local.');
