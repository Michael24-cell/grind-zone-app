import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runDemoNarrativeRequest, REQUIRED_DISCLAIMER } from '../_shared/demo-policy.mjs';

const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type' };
const json = (body:unknown, status=200) => new Response(JSON.stringify(body), { status, headers:{ ...cors, 'Content-Type':'application/json' } });

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers:cors });
  if (request.method !== 'POST') return json({ error:'method_not_allowed' },405);
  const authHeader=request.headers.get('Authorization')||'';
  const url=Deno.env.get('SUPABASE_URL')!, anon=Deno.env.get('SUPABASE_ANON_KEY')!, service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const userClient=createClient(url,anon,{global:{headers:{Authorization:authHeader}}});
  const admin=createClient(url,service,{auth:{persistSession:false}});
  const {data:{user}}=await userClient.auth.getUser();
  let body:any={}; try{body=await request.json();}catch{return json({error:'invalid_json'},400);}
  const modelId=Deno.env.get('AI_MODEL_ID')||'claude-sonnet-4-6';
  const result=await runDemoNarrativeRequest({providerUserId:user?.id,demoKey:body.demo_key,metrics:body.metrics},{
    now:()=>new Date(), timeoutMs:Number(Deno.env.get('AI_TIMEOUT_MS')||12000),
    providerExists:async(userId:string)=>{const {data}=await admin.from('providers').select('id').eq('user_id',userId).maybeSingle();return !!data;},
    demoApproved:async(demoKey:string)=>{const {data}=await admin.from('approved_synthetic_demo_plans').select('demo_key').eq('demo_key',demoKey).eq('enabled',true).maybeSingle();return !!data;},
    consumeRateLimit:async(userId:string,demoKey:string)=>{
      const {data,error}=await admin.rpc('consume_synthetic_demo_ai_rate_limit',{p_provider_user_id:userId,p_demo_key:demoKey,p_window_minutes:60,p_max_requests:5});
      return !error&&data===true;
    },
    generate:async(metrics:unknown)=>{
      const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),Number(Deno.env.get('AI_TIMEOUT_MS')||12000));
      try{
        let response:Response;
        try {
          response=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json','x-api-key':Deno.env.get('ANTHROPIC_API_KEY')||'','anthropic-version':'2023-06-01'},body:JSON.stringify({model:modelId,max_tokens:500,system:`Return JSON only: {"narrative":"..."}. Summarize only the supplied synthetic descriptive metrics. Use patient-reported language. Do not diagnose, compare with expected medication values, infer causation, judge adherence, or recommend treatment. End exactly with: ${REQUIRED_DISCLAIMER}`,messages:[{role:'user',content:JSON.stringify(metrics)}]})});
        } catch (error) {
          if (error instanceof DOMException && error.name==='AbortError') throw new Error('timeout');
          throw error;
        }
        if(!response.ok)throw new Error('provider_unavailable');
        const payload=await response.json();
        let parsed:any;
        try { parsed=JSON.parse(payload?.content?.[0]?.text||''); }
        catch { return {narrative:null,modelId}; }
        return {narrative:parsed?.narrative,modelId};
      }finally{clearTimeout(timer);}
    }
  });
  return json(result.body,result.status);
});
