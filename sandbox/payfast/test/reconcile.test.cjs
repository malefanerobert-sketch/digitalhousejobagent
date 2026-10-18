'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {queryPaidTransaction}=require('../reconcile.cjs');const {Store}=require('../store.cjs');
const order={id:'11111111-1111-4111-8111-111111111111',amount_cents:20000};
const cfg={merchantId:'10000001',passphrase:'fixture-only-passphrase'};
const data={pf_payment_id:12345,m_payment_id:order.id,status:'COMPLETE',amount:20000,transaction_token:'not-assumed-to-be-a-subscription-token'};
const fixture=(extra={})=>async(url,options)=>{
 assert.equal(url,'https://api.payfast.co.za/process/query/12345?testing=true');assert.equal(options.redirect,'error');
 assert.equal(options.headers['merchant-id'],cfg.merchantId);assert(/^[a-f0-9]{32}$/.test(options.headers.signature));
 assert(!JSON.stringify(options).includes(cfg.passphrase));assert(options.headers.timestamp.endsWith('+00:00'));
 return {ok:true,json:async()=>({status:'success',data:{response:{...data,...extra}}})};
};
test('recovery uses an authenticated, fixed Sandbox-only read endpoint',async()=>{
 const p=await queryPaidTransaction(order,'12345',cfg,{fetch:fixture()});
 assert.equal(p.amount_gross,'200.00');assert.equal(p.payment_status,'COMPLETE');assert(!Object.hasOwn(p,'token'));
});
for(const [name,extra]of Object.entries({amount:{amount:1},order:{m_payment_id:randomUUID()},status:{status:'PENDING'},id:{pf_payment_id:999},currency:{currency:'USD'},decimalAmount:{amount:'200.00'}})){
 test('recovery rejects mismatched '+name,async()=>{await assert.rejects(queryPaidTransaction(order,'12345',cfg,{fetch:fixture(extra)}),e=>e.status===409);});
}
test('recovery network failure cannot credit anything',async()=>{await assert.rejects(queryPaidTransaction(order,'12345',cfg,{fetch:async()=>{throw Error('offline')}}),e=>e.status===503);});
test('API reconciliation credits once, then genuine ITN links the subscription without crediting again',async t=>{
 const s=new Store();t.after(()=>s.close());const now=new Date('2026-10-18T10:00:00Z');const o=s.createOrder('monthly',randomUUID(),now);
 const p={m_payment_id:o.id,pf_payment_id:'12345',payment_status:'COMPLETE',amount_gross:'200.00'};
 s.recordVerifiedPayment(p,now,'api_reconciliation');assert.equal(s.wallet().monthly,600);
 assert(s.recordVerifiedPayment(p,now,'api_reconciliation').duplicate);
 const token='11111111-1111-4111-8111-111111111111';assert(s.recordVerifiedPayment({...p,token},now).duplicate);
 assert.equal(s.wallet().monthly,600);assert.equal(s.db.prepare('SELECT subscription_token FROM sandbox_payments').get().subscription_token,token);
 assert(s.snapshot(now).history[0].reason.includes('api_reconciliation'));
 assert.throws(()=>s.recordVerifiedPayment({...p,token:'22222222-2222-4222-8222-222222222222'},now),/reused/);
});
test('ordinary notifications still require subscription token, and source cannot be an arbitrary string',t=>{
 const s=new Store();t.after(()=>s.close());const now=new Date('2026-10-18T10:00:00Z');const o=s.createOrder('monthly',randomUUID(),now);
 const p={m_payment_id:o.id,pf_payment_id:'12345',payment_status:'COMPLETE',amount_gross:'200.00'};
 assert.throws(()=>s.recordVerifiedPayment(p,now),/token/);assert.throws(()=>s.recordVerifiedPayment(p,now,'browser_redirect'),/source/);assert.equal(s.wallet().monthly,0);
});
