"""Execute shared fixtures through the Python SDK and streaming decoder."""
from __future__ import annotations
import asyncio
import json
import sys
from dataclasses import asdict
from pathlib import Path
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from polyllm_core import create_llm
from polyllm_core.errors import PolyLLMError
from polyllm_core.transport import EventDecoder
from polyllm_openai import OpenAIPlugin
from polyllm_openai_compatible import OpenAICompatiblePlugin
from polyllm_gemini import GeminiPlugin

ROOT = Path(__file__).resolve().parent.parent
MAPPING = {'toolCalls':'tool_calls','toolCallId':'tool_call_id','imageUrl':'image_url','maxTokens':'max_tokens','topP':'top_p','jsonMode':'json_mode'}

def snake(value):
    if isinstance(value, list): return [snake(v) for v in value]
    if isinstance(value, dict): return {MAPPING.get(k,k): (v if k == 'parameters' else snake(v)) for k,v in value.items()}
    return value

async def execute(case):
    capture = {}
    def transport(method, url, headers, body, timeout):
        capture['wire'] = body
        trigger = case.get('trigger', {})
        kind = trigger.get('kind')
        if kind == 'connection-failure': raise OSError('connection')
        if kind == 'timeout': raise TimeoutError()
        if kind == 'cancelled': raise asyncio.CancelledError()
        if kind == 'invalid-json-parse': return 200, 'INVALID JSON'
        if kind == 'http': return trigger['status'], '<html>failure</html>'
        if 'raw' in case: return 200, case['raw']
        if 'sourceEvents' in case:
            return 200, ''.join('data: '+json.dumps(e)+'\n\n' for e in case['sourceEvents'])+'data: [DONE]\n\n'
        return 200, json.dumps(case.get('source', {'id':'resp', 'model':'gpt-4o-mini','choices':[{'index':0,'message':{'role':'assistant','content':'ok'},'finish_reason':'stop'}], 'usage':{'prompt_tokens':0,'completion_tokens':0,'total_tokens':0}}))
    plugins = [OpenAIPlugin(transport), GeminiPlugin(transport), OpenAICompatiblePlugin(transport, provider='custom-gateway')]
    llm = create_llm(plugins=plugins, providers={p.provider:{'api_key':'fixture-key','base_url':'https://fixture.invalid/v1'} for p in plugins}, allow_unlisted_models=case['id']=='dynamic-model-conservative-capabilities')
    try:
        if 'request' in case:
            payload=snake(case['request']);model=payload.pop('model')
            response = await llm.chat(model,payload)
            spec = llm.get_model_info(model)
            return {'wire':capture['wire'], 'resolvedId':spec.provider+':'+spec.id, 'capabilities':asdict(spec.capabilities)}
        if 'sourceEvents' in case or 'raw' in case:
            chunks=[asdict(chunk) async for chunk in llm.chat_stream('openai:gpt-4o-mini',messages=[{'role':'user','content':'hi'}])]
            if 'raw' in case:
                # Independently stress UTF-8 and framing on every byte boundary.
                decoder=EventDecoder(case['wire']);events=[]
                for byte in case['raw'].encode(): events.extend(decoder.feed(bytes([byte])))
                events.extend(decoder.feed(b'',final=True))
                incremental = [asdict(chunk) for event in events if (chunk := plugins[0]._parse_stream_event(event, 'gpt-4o-mini')) is not None]
                assert incremental == chunks, case['id']+': byte fragmentation changed output' 
            return {'chunks':chunks}
        response=await llm.chat('openai:gpt-4o-mini',messages=[{'role':'user','content':'hi'}])
        return {'response':asdict(response)}
    except asyncio.CancelledError:
        return {'error':{'category':'cancelled','retryable':False}}
    except PolyLLMError as error:
        return {'error':{'code':error.code, **{k:v for k,v in error.details.items() if k in ('category','retryable','parameter','status')}}}

async def main():
    schemas=[json.loads(p.read_text()) for p in (ROOT/'schemas').glob('*.json')]
    registry=Registry().with_resources((s['$id'],Resource.from_contents(s)) for s in schemas)
    validators={s['$id'].split('/')[-1]:Draft202012Validator(s,registry=registry) for s in schemas}
    result=[]
    for path in sorted(Path(sys.argv[1]).glob('*.json')):
        for case in json.loads(path.read_text())['cases']:
            field=next((k for k in ('request','response','chunks') if k in case),None)
            schema_valid=True
            if field:
                schema={'request':'unified-request.json','response':'unified-response.json','chunks':'unified-stream-chunk.json'}[field]
                values=case[field] if field=='chunks' else [case[field]]
                schema_valid=all(validators[schema].is_valid(v) for v in values)
                if schema_valid != case['valid']: raise AssertionError(case['id']+': schema validity differs')
            actual=await execute(case) if schema_valid else {'rejected':True}
            result.append({'id':case['id'], 'actual':actual})
    Path(sys.argv[2]).write_text(json.dumps(result,ensure_ascii=False,indent=2))

asyncio.run(main())
