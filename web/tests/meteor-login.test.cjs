const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(new URL('../app.html',`file://${__filename}`),'utf8');
function build(wallet,args){
 const code=html.match(/function walletLoginUrl\([\s\S]*?\n}/)[0];
 return vm.runInNewContext(`${code};walletLoginUrl(args)`,{URL,args,st:()=>({wallet}),walletLoginBase:()=>wallet==='mnw'?'https://testnet.mynearwallet.com':'https://wallet.meteorwallet.app/connect/testnet'});
}
const args={contractId:'guest-book.testnet',publicKey:'ed25519:11111111111111111111111111111111',successUrl:'https://stashway-arena.vercel.app/?step=create#setup',failureUrl:'https://stashway-arena.vercel.app/?step=connect#setup'};
test('Meteor receives a typed login request with key and contract; callbacks survive URL parsing',()=>{
 const value=build('meteor',args),url=new URL(value);
 assert.equal(url.origin,'https://wallet.meteorwallet.app');
 assert.equal(url.pathname,'/connect/testnet/login/');
 assert.equal(url.hash,'');assert.ok(value.includes('%23setup'));assert.ok(!value.includes('#'));
 assert.deepEqual(Object.fromEntries(url.searchParams),{contract_id:args.contractId,public_key:args.publicKey,success_url:args.successUrl,failure_url:args.failureUrl,type:'ALL_METHODS'});
});
test('vault authorization uses the same typed Meteor URL',()=>{
 const url=new URL(build('meteor',{...args,contractId:'vault.testnet'}));
 assert.equal(url.searchParams.get('contract_id'),'vault.testnet');assert.equal(url.searchParams.get('type'),'ALL_METHODS');
 assert.ok(html.includes('location.href=walletLoginUrl({contractId:st().vault,'));
});
test('MyNearWallet keeps its native NEAR login shape',()=>{
 const url=new URL(build('mnw',args));assert.equal(url.origin,'https://testnet.mynearwallet.com');
 assert.equal(url.searchParams.has('type'),false);assert.equal(url.searchParams.get('failure_url'),args.failureUrl);
});
test('old callback-only URL has encoded hashes but lacks required Meteor login fields',()=>{
 const old=new URL('https://wallet.meteorwallet.app/connect/testnet/login/?success_url='+encodeURIComponent(args.successUrl)+'&failure_url='+encodeURIComponent(args.failureUrl));
 assert.equal(old.hash,'');assert.equal(old.searchParams.get('failure_url'),args.failureUrl);
 for(const name of ['type','public_key','contract_id'])assert.equal(old.searchParams.has(name),false);
});
