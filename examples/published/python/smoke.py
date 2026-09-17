import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from polyllm_core import ClientConfig, ProviderConfig, create_llm
from polyllm_openai_compatible import OpenAICompatiblePlugin


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        assert self.headers["Authorization"] == "Bearer smoke-key"
        if self.path != "/v1/models":
            self.send_error(404)
            return
        self.send_json({"data": [{"id": "demo-model", "owned_by": "smoke"}]})

    def do_POST(self):
        assert self.headers["Authorization"] == "Bearer smoke-key"
        assert self.path == "/v1/chat/completions"
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert payload["model"] == "demo-model"
        assert payload["messages"][0]["content"] == "smoke test"
        if payload.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for event in (
                {"id": "stream-1", "model": "demo-model", "delta": {"content": "stream ok"}},
                {"id": "stream-1", "model": "demo-model", "delta": {}, "finish_reason": "stop"},
            ):
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            return
        self.send_json({
            "id": "response-1",
            "model": "demo-model",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "chat ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3},
        })

    def send_json(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


async def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    config = ProviderConfig(api_key="smoke-key", base_url=f"http://127.0.0.1:{server.server_port}/v1")
    plugin = OpenAICompatiblePlugin()
    try:
        models = await plugin.list_models(config)
        assert [item.id for item in models] == ["demo-model"]
        llm = create_llm(ClientConfig(
            plugins=[plugin],
            providers={plugin.provider: config},
            allow_unlisted_models=True,
            param_policy="strict",
        ))
        response = await llm.chat("openai-compatible:demo-model", messages=[{"role": "user", "content": "smoke test"}])
        assert response.choices[0].message.content == "chat ok"
        streamed = ""
        async for chunk in llm.chat_stream("openai-compatible:demo-model", messages=[{"role": "user", "content": "smoke test"}]):
            streamed += chunk.delta.get("content", "")
        assert streamed == "stream ok"
        print("published PyPI packages: smoke ok")
    finally:
        server.shutdown()
        server.server_close()


asyncio.run(main())
