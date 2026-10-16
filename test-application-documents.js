'use strict';
// Actual deployed admin HTML/JS, fake transport, local fixtures only: no real private files or writes.
const fs=require('fs'),assert=require('assert/strict');
const {setup,queue,apply,section,css,modal}=require('./test-lazy-queue');
const tests=String.raw`
(async()=>{
 const wait=async pred=>{for(let i=0;i<100;i++){if(pred())return;await new Promise(r=>setTimeout(r,5));}throw Error('Async operation did not finish');};
 const makeDoc=(id='cert',account='a',file='Diploma.pdf')=>({id,job_seeker_id:account,doc_type:id==='id'?'id':'qualification',file_name:file,file_url:SUPABASE_URL+'/storage/v1/object/sign/documents/owner-'+account+'/'+id+'-'+encodeURIComponent(file)+'?token=expired',created_at:today});
 await loadReport();await openReportAccount('a');check(!queries.some(q=>q.table==='job_seeker_documents')&&!signCalls.length,'No document or signing prefetch on overview/account list');
 docRecords=[makeDoc()];await openApplyOnBehalf('a-new');
 check(queries.filter(q=>q.table==='job_seeker_documents').length===1,'Documents fetched once on review');const dq=queries.at(-1);check(dq.filters.some(([k,v])=>k==='job_seeker_id'&&v==='a'),'Metadata restricted to exact applicant');
 check(signCalls.length===2&&signCalls.every(c=>c.expiry===3600),'CV and supporting file renewed with one-hour signing');check(signCalls.every(c=>c.path.startsWith('owner-a/')),'All signed paths belong to selected applicant');
 check($('#applyDocuments').textContent.includes('CV / resume')&&$('#applyDocuments').textContent.includes('Diploma.pdf'),'CV and supporting documents displayed');
 const links=[...document.querySelectorAll('#applyDocuments a')];check(links.length===4&&links.every(a=>a.href.includes('token=fresh-')&&!a.href.includes('expired')),'Both Open and Download links use new signatures');check(links.every(a=>a.rel.includes('noopener')&&a.rel.includes('noreferrer')&&a.referrerPolicy==='no-referrer'),'No opener/referrer leakage');check(links.filter(a=>a.textContent==='Download').every(a=>new URL(a.href).searchParams.has('download')&&a.hasAttribute('download')),'Download links have filenames');
 $('#adminOutcomeNotes').value='Keep my in-progress application notes';const before=signCalls.length;$('#applyDocuments [data-refresh-application-documents]').click();await wait(()=>signCalls.length===before+2&&$('#applyDocuments a'));check($('#adminOutcomeNotes').value.includes('Keep my'),'Refreshing links preserves outcome form');
 // Unsupported and other-applicant storage URLs must never be signed.
 const loc=(url,bucket='documents',owner='owner-a')=>applicationDocumentLocation(url,owner,bucket);
 check(loc('javascript:alert(1)').error&&loc('http://example.test/file').error,'Only HTTPS file URLs');check(loc(SUPABASE_URL+'/storage/v1/object/sign/documents/owner-b/file.pdf').error,'Reject other applicant folder');check(loc(SUPABASE_URL+'/storage/v1/object/sign/resumes/owner-a/file.pdf').error,'Reject wrong bucket');check(loc(SUPABASE_URL+'/storage/v1/object/sign/documents/owner-a/%2E%2E%2Fowner-b/file.pdf').error,'Reject encoded traversal');check(loc(SUPABASE_URL+'/storage/v1/object/sign/documents/owner-a/file.pdf','documents',null).error,'Missing owner cannot sign private file');
 const signedBefore=signCalls.length;docRecords=[{...makeDoc(),file_url:SUPABASE_URL+'/storage/v1/object/sign/documents/owner-b/secret.pdf'}];await loadApplyDocuments(applyDocumentsContext);check($('#applyDocuments').textContent.includes('does not belong')&&signCalls.length===signedBefore+1,'Invalid supporting file blocked while valid CV still loads');
 docRecords=[makeDoc('unsafe','a','<img src=x onerror="window.bad=1">.pdf')];await loadApplyDocuments(applyDocumentsContext);check(!$('#applyDocuments img')&&!window.bad&&$('#applyDocuments').textContent.includes('<img'),'Filenames escaped');
 docRecords=[{...makeDoc(),file_url:'https://legacy.example.test/document.pdf'}];await loadApplyDocuments(applyDocumentsContext);check($('#applyDocuments').textContent.includes('Open / download'),'Legacy external HTTPS links retained');
 // Partial metadata and signing errors are explicit, and do not discard application form input.
 docControl=async()=>({error:{message:'Metadata denied'}});await loadApplyDocuments(applyDocumentsContext);check($('#applyDocuments').textContent.includes('Supporting documents could not be loaded')&&$('#applyDocuments a'),'CV remains usable on metadata failure');check($('#adminOutcomeNotes').value.includes('Keep my'),'Error preserves entered outcome');docControl=null;docRecords=[makeDoc()];$('#applyDocuments [data-refresh-application-documents]').click();await wait(()=>$('#applyDocuments').textContent.includes('Diploma.pdf'));check(!$('#applyDocuments').textContent.includes('could not be loaded'),'Retry recovers metadata');
 signControl=async c=>c.bucket==='documents'?{error:{message:'Missing file'}}:{data:{signedUrl:SUPABASE_URL+'/storage/v1/object/sign/resumes/'+c.path+'?token=fresh'}};await loadApplyDocuments(applyDocumentsContext);check($('#applyDocuments').textContent.includes('Could not open this file')&&document.querySelectorAll('#applyDocuments a').length===2,'A missing supporting file does not hide the CV');signControl=null;
 // Server may cap at less than requested page size. Exact total is retained after first page.
 docRecords=Array.from({length:205},(_,i)=>makeDoc('page'+i,'a','Certificate '+i+'.pdf'));docCap=40;const pageBefore=queries.length;await loadApplyDocuments(applyDocumentsContext);const pages=queries.slice(pageBefore);check(pages.length===6&&document.querySelectorAll('.application-file-row').length===206,'All capped metadata pages loaded plus CV');check(pages.filter(q=>q.opts?.count==='exact').length===1,'Exact metadata total requested once');docCap=100;
 // Wrong metadata scope is rejected before any supporting file is signed.
 docControl=async()=>({data:[makeDoc('other','b')],count:1});await loadApplyDocuments(applyDocumentsContext);check($('#applyDocuments').textContent.includes('Supporting documents could not be loaded')&&!$('#applyDocuments').textContent.includes('owner-b'),'Reject wrong-applicant response');docControl=null;
 // Empty documents state.
 docRecords=[];const originalDetails=details(records[0]);detailControl=async()=>({data:{...originalDetails,job_seekers:{...originalDetails.job_seekers,resume_url:null}}});await openApplyOnBehalf('a-new');check($('#applyDocuments').textContent.includes('No CV uploaded')&&$('#applyDocuments').textContent.includes('No supporting documents'),'Empty state explicit');detailControl=null;
 // A closed review cannot be repopulated by late metadata/signing responses.
 let finishDocs;docControl=()=>new Promise(r=>finishDocs=r);const staleDoc=openApplyOnBehalf('a-new');await wait(()=>!!finishDocs);closeApplyModal();finishDocs({data:[makeDoc()],count:1});await staleDoc;check($('#applyBody').innerHTML===''&&applyDocumentsContext===null,'Closing clears sensitive data and blocks late metadata');docControl=null;
 docRecords=[makeDoc()];let pendingSigns=[];signControl=()=>new Promise(r=>pendingSigns.push(r));const staleSign=openApplyOnBehalf('a-new');await wait(()=>pendingSigns.length===2);await openReportAccount('b');pendingSigns.forEach(r=>r({data:{signedUrl:SUPABASE_URL+'/storage/v1/object/sign/documents/owner-a/file.pdf?token=old'}}));await staleSign;check($('#applyBody').innerHTML===''&&$('#applyModal').classList.contains('hidden'),'Switching accounts clears and blocks late signed links');signControl=null;
 // Detail mismatch must not render the wrong person's information.
 await openReportAccount('a');detailControl=async()=>({data:details(records.find(r=>r.id==='b-fail'))});await openApplyOnBehalf('a-new');check($('#applyBody').textContent.includes('Application account did not match')&&!$('#applyDocuments'),'Mismatched detail response rejected');detailControl=null;
 // Final visual states use representative fixture files, never live applicant data.
 const state=new URLSearchParams(location.search).get('state')||'normal';
 docRecords=state==='empty'?[]:[makeDoc('id','a','Identity document.pdf'),makeDoc('cert','a','Qualification certificate.pdf')];
 if(state==='empty')detailControl=async()=>({data:{...originalDetails,job_seekers:{...originalDetails.job_seekers,resume_url:null}}});
 if(state==='error')docControl=async()=>({error:{message:'Offline'}});
 await openApplyOnBehalf('a-new');
 const card=$('#applyModal .modal-card');check(card.scrollWidth<=card.clientWidth,'Review fits viewport without horizontal scroll');check($('#applyDocuments').scrollWidth<=$('#applyDocuments').clientWidth,'Document rows fit viewport');
 if(state==='lower'){card.scrollTop=card.scrollHeight;}
 const marker=document.createElement('pre');marker.id='test-result';marker.hidden=true;marker.textContent='PASS applicant documents: lazy/scoped fetch, fresh one-hour signing, open/download, escaping/path validation, errors/retry/empty, capped pagination, stale responses and responsive layout';document.body.append(marker);
})().catch(e=>{const marker=document.createElement('pre');marker.id='test-result';marker.textContent='FAIL '+e.stack;document.body.append(marker);});
`;
fs.writeFileSync(__dirname+'/documents-fixture.html',`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><main>${section}</main>${modal}<script>${(setup+queue+apply+tests).replaceAll('</script','<\\/script')}</script>`);
(async()=>{for(const [width,state] of [[1280,'normal'],[390,'normal'],[320,'normal'],[390,'error'],[390,'empty'],[390,'lower']]){
 const label=state+'-'+width;const {marker,dom}=await require('./browserTestRunner').run({url:'file://'+__dirname+'/documents-fixture.html?state='+state,width,height:900,screenshot:__dirname+'/documents-'+label+'.png'});
 fs.writeFileSync(__dirname+'/documents-'+label+'.dom.html',dom);assert(marker?.startsWith('PASS'),marker||'Browser did not finish');console.log(label+': '+marker);
}})().catch(e=>{console.error(e);process.exitCode=1;});
