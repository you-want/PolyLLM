from __future__ import annotations
import asyncio
import http.server
import json
import socket
import threading
import unittest
from unittest.mock import patch

from polyllm_core import create_llm, StreamDelta
from polyllm_core.errors import PolyLLMError
from polyllm_core.retry import with_retries
from polyllm_core.transport import CancelHandle, interruptible_urlopen
from polyllm_core.types import UnifiedMessage, UnifiedContentPart, UnifiedToolCall, UnifiedRequest
from polyllm_openai import OpenAIPlugin
from polyllm_openai_compatible import OpenAICompatiblePlugin
from polyllm_deepseek import DeepSeekPlugin
from polyllm_anthropic import AnthropicPlugin
from polyllm_gemini import GeminiPlugin
from polyllm_ollama import OllamaPlugin

PROVIDERS = (OpenAIPlugin, OpenAICompatiblePlugin, DeepSeekPlugin, AnthropicPlugin, GeminiPlugin, OllamaPlugin)


def client(plugin, url='https://fixture.invalid'):
    llm = create_llm(plugins=[plugin], providers={plugin.provider:{'api_key':'RuntimeCredential1234','base_url':url,'headers':{'x-custom-token':'PrivateHeader1234'}}}, allow_unlisted_models=True)
    model = plugin.models[0].id if plugin.models else 'dynamic'
    return llm, plugin.provider+':'+model


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_http_status_precedes_json_and_masks_runtime_credentials(self):
        for cls in PROVIDERS:
            for status, category in ((401,'auth'),(429,'rate_limited'),(503,'server')):
                with self.subTest(provider=cls.__name__, status=status):
                    llm,model=client(cls(lambda *args:(status,'<html>RuntimeCredential1234 PrivateHeader1234</html>')))
                    with self.assertRaises(PolyLLMError) as caught:
                        await llm.chat(model,messages=[{'role':'user','content':'hi'}])
                    self.assertEqual(caught.exception.details['category'],category)
                    self.assertNotIn('RuntimeCredential1234',str(caught.exception))
                    self.assertNotIn('PrivateHeader1234',str(caught.exception))

    async def test_missing_usage_is_marked_for_every_provider(self):
        for cls in PROVIDERS:
            if cls is AnthropicPlugin: data={'id':'r','model':'m','content':[{'type':'text','text':'ok'}],'stop_reason':'end_turn'}
            elif cls is GeminiPlugin: data={'candidates':[{'content':{'parts':[{'text':'ok'}]},'finishReason':'STOP'}]}
            else: data={'id':'r','model':'m','choices':[{'index':0,'message':{'role':'assistant','content':'ok'},'finish_reason':'stop'}]}
            llm,model=client(cls(lambda *args:(200,json.dumps(data))))
            response=await llm.chat(model,messages=[{'role':'user','content':'hi'}])
            self.assertEqual(response.usage.total_tokens,0)
            self.assertTrue(response.provider_metadata['usageUnavailable'])

    async def test_stream_can_retry_before_the_first_visible_chunk(self):
        calls=0
        def transport(*args):
            nonlocal calls
            calls+=1
            if calls==1:return 503,'temporary'
            return 200,'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
        llm,model=client(OpenAIPlugin(transport))
        chunks=[c async for c in llm.chat_stream(model,messages=[{'role':'user','content':'hi'}],retries={'maxAttempts':1,'baseDelayMs':0})]
        self.assertEqual(chunks[0].delta.content,'ok')
        self.assertEqual(calls,2)

    async def test_missing_stream_implementation_preserves_public_error_code(self):
        class NoStreamPlugin(OpenAIPlugin):
            def chat_stream(self, *args):
                raise NotImplementedError()
        llm,model=client(NoStreamPlugin())
        with self.assertRaises(PolyLLMError) as caught:
            async for _ in llm.chat_stream(model,messages=[{'role':'user','content':'hi'}]):
                pass
        self.assertEqual(caught.exception.code,'UNSUPPORTED_PARAMETER')

    async def test_public_retry_policy_is_executed(self):
        for cls in PROVIDERS:
            calls=[]
            def transport(*args):
                calls.append(args)
                return 503,'temporarily unavailable'
            llm,model=client(cls(transport))
            with self.assertRaises(PolyLLMError):
                await llm.chat(model,messages=[{'role':'user','content':'hi'}],retries={'maxAttempts':2,'baseDelayMs':0})
            self.assertEqual(len(calls),3,cls.__name__)

    async def test_inflight_operation_is_bounded(self):
        cancelled=asyncio.Event()
        async def operation(_attempt):
            try: await asyncio.sleep(1)
            finally: cancelled.set()
        with self.assertRaises(PolyLLMError) as caught:
            await with_retries(operation,deadline_ms=10)
        self.assertEqual(caught.exception.details['category'],'timeout')
        self.assertTrue(cancelled.is_set())

    async def test_exact_deadline_does_not_skip_retry_after(self):
        now=0
        calls=0
        async def operation(_attempt):
            nonlocal now,calls
            calls+=1; now=10
            raise PolyLLMError('PROVIDER_ERROR','busy',{'category':'server','retryAfterSeconds':60})
        with self.assertRaises(PolyLLMError) as caught:
            await with_retries(operation,policy={'maxAttempts':2,'baseDelayMs':0},deadline_ms=10,now=lambda:now)
        self.assertEqual(caught.exception.details['category'],'timeout')
        self.assertEqual(calls,1)

    async def test_usage_only_and_parallel_tool_deltas(self):
        events=[{'id':'r','choices':[{'delta':{'tool_calls':[{'index':1,'function':{'arguments':'tail'}}]}}]},
                {'id':'r','choices':[],'usage':{'prompt_tokens':2,'completion_tokens':3,'total_tokens':5}}]
        raw=''.join('data: '+json.dumps(e)+'\n\n' for e in events)+'data: [DONE]\n\n'
        for cls in (OpenAIPlugin,OpenAICompatiblePlugin,DeepSeekPlugin,OllamaPlugin):
            captures=[]
            def transport(*args): captures.append(args[3]); return 200,raw
            llm,model=client(cls(transport))
            chunks=[c async for c in llm.chat_stream(model,messages=[{'role':'user','content':'hi'}])]
            self.assertEqual(chunks[0].delta.tool_calls[0]['index'],1)
            self.assertEqual(chunks[-1].usage.total_tokens,5)
            self.assertEqual(captures[0]['stream_options'],{'include_usage':True})
            self.assertIsInstance(chunks[-1].delta,StreamDelta)

    def test_tool_roundtrips_with_content_parts(self):
        request=UnifiedRequest(model='m',messages=[
            UnifiedMessage(role='assistant',content=[UnifiedContentPart(type='text',text='checking')],tool_calls=(UnifiedToolCall('call_a','function',{'name':'weather','arguments':'{}'}),)),
            UnifiedMessage(role='tool',tool_call_id='call_a',content=[UnifiedContentPart(type='text',text='sunny')]),
        ])
        messages=AnthropicPlugin()._build_body(request)['messages']
        self.assertEqual(messages[0]['content'][1]['type'],'tool_use')
        self.assertEqual(messages[1]['role'],'user')
        self.assertEqual(messages[1]['content'][0]['type'],'tool_result')
        self.assertEqual(messages[1]['content'][0]['content'][0]['text'],'sunny')
        request=UnifiedRequest(model='m',messages=[request.messages[0],UnifiedMessage(role='tool',tool_call_id='call_a',content='sunny')])
        result=GeminiPlugin()._build_body(request)['contents'][1]['parts'][0]['functionResponse']
        self.assertEqual(result,{'name':'weather','response':{'result':'sunny'}})

    def test_dynamic_capabilities_are_conservative(self):
        for cls in (OpenAIPlugin,OpenAICompatiblePlugin,DeepSeekPlugin,AnthropicPlugin):
            spec=cls().create_model_spec('unknown-model')
            self.assertFalse(spec.capabilities.vision)
            self.assertFalse(spec.capabilities.function_calling)
            self.assertFalse(spec.capabilities.json_mode)

    def test_cancellation_before_socket_registration(self):
        handle=CancelHandle();handle.cancel()
        left,right=socket.socketpair()
        try:
            with self.assertRaises(OSError):handle.register(left)
            self.assertEqual(left.fileno(),-1)
        finally:right.close()

    def test_connect_timeout_is_not_connection_failure(self):
        with patch('polyllm_core.transport._open',side_effect=socket.timeout()):
            result=interruptible_urlopen('GET','http://fixture.invalid',{},None,10,CancelHandle())
        self.assertEqual(result[3]['category'],'timeout')


class LiveHTTPTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        cls.server.daemon_threads=True
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
        cls.url=f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join()

    def prepare(self,mode):
        state={'mode':mode,'started':threading.Event(),'closed':threading.Event(),'release':threading.Event(),'calls':0}
        self.server.state=state
        return state

    async def test_task_cancel_closes_default_transport_for_all_providers(self):
        for provider in PROVIDERS:
            with self.subTest(provider=provider.__name__):
                state=self.prepare('wait')
                llm,model=client(provider(),self.url)
                task=asyncio.create_task(llm.chat(model,messages=[{'role':'user','content':'hi'}]))
                self.assertTrue(await asyncio.to_thread(state['started'].wait,2))
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):await task
                self.assertTrue(await asyncio.to_thread(state['closed'].wait,2))

    async def test_stream_delivers_first_chunk_before_eof_and_aclose_disconnects(self):
        for provider in PROVIDERS:
            with self.subTest(provider=provider.__name__):
                state=self.prepare('stream')
                llm,model=client(provider(),self.url)
                stream=llm.chat_stream(model,messages=[{'role':'user','content':'hi'}])
                first=await asyncio.wait_for(stream.__anext__(),1)
                self.assertEqual(first.delta.content,'first')
                self.assertFalse(state['closed'].is_set())
                await stream.aclose()
                self.assertTrue(await asyncio.to_thread(state['closed'].wait,2))

    async def test_timeout_closes_the_socket(self):
        state=self.prepare('wait')
        llm,model=client(OpenAIPlugin(),self.url)
        with self.assertRaises(PolyLLMError) as caught:
            await llm.chat(model,messages=[{'role':'user','content':'hi'}],timeout_ms=100)
        self.assertEqual(caught.exception.details['category'],'timeout')
        self.assertTrue(await asyncio.to_thread(state['closed'].wait,2))

    async def test_stream_timeout_closes_the_socket_after_first_chunk(self):
        state=self.prepare('stream')
        llm,model=client(OpenAIPlugin(),self.url)
        stream=llm.chat_stream(model,messages=[{'role':'user','content':'hi'}],timeout_ms=100)
        self.assertEqual((await stream.__anext__()).delta.content,'first')
        with self.assertRaises(PolyLLMError) as caught:
            await stream.__anext__()
        self.assertEqual(caught.exception.details['category'],'timeout')
        self.assertTrue(await asyncio.to_thread(state['closed'].wait,2))

    async def test_http_headers_are_preserved_for_retries_and_masked_ids(self):
        self.prepare('error')
        llm,model=client(OpenAIPlugin(),self.url)
        with self.assertRaises(PolyLLMError) as caught:
            await llm.chat(model,messages=[{'role':'user','content':'hi'}])
        self.assertEqual(caught.exception.details['retryAfterSeconds'],60)
        self.assertEqual(caught.exception.details['requestId'],'***')

    async def test_no_retry_after_first_visible_chunk(self):
        state=self.prepare('broken')
        llm,model=client(OpenAIPlugin(),self.url)
        chunks=[]
        with self.assertRaises(PolyLLMError) as caught:
            async for chunk in llm.chat_stream(model,messages=[{'role':'user','content':'hi'}],retries={'maxAttempts':2,'baseDelayMs':0}):chunks.append(chunk)
        self.assertEqual(chunks[0].delta.content,'first')
        self.assertEqual(caught.exception.details['category'],'parse')
        self.assertEqual(state['calls'],1)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def do_POST(self):
        state=self.server.state;state['calls']+=1
        data=json.loads(self.rfile.read(int(self.headers.get('content-length',0))))
        state['started'].set()
        try:
            if state['mode']=='wait':
                self.connection.settimeout(3)
                self.connection.recv(1)
                return
            if state['mode']=='error':
                self.send_response(429);self.send_header('Retry-After','60');self.send_header('X-Request-ID','RuntimeCredential1234');self.send_header('Content-Length','0');self.end_headers();return
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
            if 'streamGenerateContent' in self.path:event={'candidates':[{'content':{'parts':[{'text':'first'}]}}]}
            elif self.path.endswith('/v1/messages'):event={'type':'content_block_delta','delta':{'type':'text_delta','text':'first'}}
            else:event={'id':'r','choices':[{'delta':{'content':'first'}}]}
            self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode());self.wfile.flush()
            if state['mode']=='broken':
                self.wfile.write(b'data: {bad}\n\n');self.wfile.flush();return
            self.connection.settimeout(3);self.connection.recv(1)
        except (BrokenPipeError,ConnectionResetError,OSError):pass
        finally:
            state['closed'].set();self.close_connection=True
    def log_message(self,*args):pass
