import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { APPROVED_DEMO_KEY } from '../_shared/demo-policy.mjs';
import { DEMO_FIXTURE_VERSION, syntheticDemoSource, computeSyntheticResearchMetrics } from '../_shared/demo-fixture.mjs';

const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type' };
const json = (body:unknown, status=200) => new Response(JSON.stringify(body), { status, headers:{ ...cors, 'Content-Type':'application/json' } });

Deno.serve(async request => {
  if(request.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  const url=Deno.env.get('SUPABASE_URL')!, anon=Deno.env.get('SUPABASE_ANON_KEY')!, service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const userClient=createClient(url,anon,{global:{headers:{Authorization:request.headers.get('Authorization')||''}}});
  const admin=createClient(url,service,{auth:{persistSession:false}});
  const {data:{user}}=await userClient.auth.getUser(); if(!user)return json({error:'provider_authorization_required'},401);
  const {data:provider}=await admin.from('providers').select('id').eq('user_id',user.id).maybeSingle(); if(!provider)return json({error:'provider_authorization_required'},403);
  let body:any={};try{body=await request.json();}catch{return json({error:'invalid_json'},400);}
  if(body.demo_key!==APPROVED_DEMO_KEY)return json({error:'synthetic_demo_not_approved'},403);
  const {data:approved}=await admin.from('approved_synthetic_demo_plans').select('demo_key').eq('demo_key',APPROVED_DEMO_KEY).eq('enabled',true).eq('fixture_version',DEMO_FIXTURE_VERSION).maybeSingle();
  if(!approved)return json({error:'synthetic_demo_not_approved'},403);
  const metrics=computeSyntheticResearchMetrics(syntheticDemoSource());
  const {data,error}=await admin.rpc('complete_synthetic_demo_plan',{p_demo_key:APPROVED_DEMO_KEY,p_completion_token:`${APPROVED_DEMO_KEY}:explicit-closure:${DEMO_FIXTURE_VERSION}`,p_provider_user_id:user.id,p_fixture_version:DEMO_FIXTURE_VERSION,p_calculation_version:'clinical-observations-v1',p_descriptive_metrics:metrics});
  if(error)return json({error:'completion_unavailable'},503);
  return json({recorded:data===true,duplicate:data===false});
});
