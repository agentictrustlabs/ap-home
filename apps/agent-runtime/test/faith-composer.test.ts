import {describe,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({generate:vi.fn()}));
vi.mock('@agenticprimitives/model-client',()=>({createModelClient:()=>({generate:state.generate})}));
import {selectComposer} from '../src/orchestration.js';
const env={ORCHESTRATION_GATEWAY:'on',INFERENCE_URL:'https://inference.test',INFERENCE_APP_KEY:'test'} as any;
const input={intent:{goal:'Connect my next step with my church and Scripture.'},observations:[],evidence:[]};
describe('complete evidence composition',()=>{
 it('uses the explicitly allowed evidence profile and rejects a provider length stop',async()=>{
  state.generate.mockResolvedValue({stopReason:'length',content:'Dated church comparison notes indicate all',toolCalls:[],usage:{tokensIn:10,tokensOut:2048},receipt:{id:'receipt'}});
  const composer=selectComposer(env,{profile:'composer-evidence',maxTokens:8192,requireComplete:true})!;
  await expect(composer.compose(input)).rejects.toThrow('did not finish (length)');
  expect(state.generate).toHaveBeenLastCalledWith(expect.objectContaining({profile:'composer-evidence',maxOutputTokens:8192}));
 });
 it('delivers a completed response with citations intact',async()=>{
  const text='Your next step connects to [the church sermon](https://publishing.faithnet.io/example) and Philippians 3:12–16.';
  state.generate.mockResolvedValue({stopReason:'end',content:text,toolCalls:[],usage:{tokensIn:10,tokensOut:100},receipt:{id:'receipt'}});
  const composer=selectComposer(env,{profile:'composer-evidence',maxTokens:8192,requireComplete:true})!;
  await expect(composer.compose(input)).resolves.toBe(text);
 });
});
