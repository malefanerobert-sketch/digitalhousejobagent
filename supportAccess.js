'use strict';
// Staff keep their own Supabase identity. This is a read-only UI safeguard,
// not a replacement for the server's admin check or existing database RLS.
window.JobAgentSupport=(()=>{
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const message='Staff troubleshooting is read-only. Return to admin for authorized changes.';
 function validId(value){return uuid.test(String(value||''));}
 function deny(){throw new Error(message);}
 function query(builder){return new Proxy(builder,{get(target,key){
  if(['insert','upsert','update','delete'].includes(key))return deny;
  const value=Reflect.get(target,key,target);
  if(typeof value!=='function')return value;
  if(['then','catch','finally'].includes(key))return value.bind(target);
  return (...args)=>{const result=value.apply(target,args);return result&&typeof result.eq==='function'?query(result):result;};
 }});}
 function readOnly(client){return new Proxy(client,{get(target,key){
  if(key==='from')return table=>query(target.from(table));
  if(key==='rpc')return (name,args)=>{if(name!=='admin_open_user_support')return deny();return target.rpc(name,args);};
  if(key==='auth')return new Proxy(target.auth,{get(auth,name){if(['updateUser','signUp','resetPasswordForEmail','setSession','exchangeCodeForSession','verifyOtp','signInWithOtp','signInWithOAuth'].includes(name))return deny;const v=Reflect.get(auth,name,auth);return typeof v==='function'?v.bind(auth):v;}});
  if(key==='storage')return new Proxy(target.storage,{get(storage,name){if(name==='from')return bucket=>new Proxy(storage.from(bucket),{get(api,method){if(['upload','update','remove','move','copy','createSignedUploadUrl','uploadToSignedUrl'].includes(method))return deny;const v=Reflect.get(api,method,api);return typeof v==='function'?v.bind(api):v;}});if(['createBucket','updateBucket','deleteBucket','emptyBucket'].includes(name))return deny;const v=Reflect.get(storage,name,storage);return typeof v==='function'?v.bind(storage):v;}});
  if(key==='functions')return {invoke:deny};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});}
 const writeControls='#view-profile input,#view-profile select,#view-profile textarea,#view-profile button,#view-docs input,#view-docs select,#view-docs button,#view-blocked input,#view-blocked button,#view-help textarea,#helpSendBtn,[data-action="apply"],[data-action="delete"],[data-quickblock-co],[data-del-app],[data-del-msg],[data-remove-doc-id],.match-select,#mSelectAll,.card-close,button[onclick*="bulkDelete"]';
 function protectUI(root=document){
  root.querySelectorAll(writeControls).forEach(el=>{if(!el.disabled)el.disabled=true;el.title=message;});
 }
 function installUI(){
  protectUI();const observer=new MutationObserver(()=>protectUI());observer.observe(document.getElementById('app'),{childList:true,subtree:true});
  document.addEventListener('click',event=>{if(event.target.closest(writeControls)){event.preventDefault();event.stopImmediatePropagation();}},true);
  document.addEventListener('submit',event=>{if(event.target.closest('#app')){event.preventDefault();event.stopImmediatePropagation();}},true);
 }
 return {validId,readOnly,protectUI,installUI,message};
})();
