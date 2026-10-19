"""Shared interruptible HTTP transport; injected five-argument transports remain supported."""
from __future__ import annotations

import asyncio
import codecs
import http.client
import json
import socket
import ssl
import threading
import time
from typing import Any, AsyncGenerator, AsyncIterator, Callable, Iterator
from urllib.parse import urlsplit

from .errors import PolyLLMError, provider_http_error, provider_parse_error, provider_transport_error

Transport = Callable[[str, str, dict[str, str], dict[str, Any] | None, int], tuple[int, str]]


class CancelHandle:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._socket: socket.socket | None = None
        self.cancelled = False

    def register(self, sock: socket.socket) -> None:
        with self._lock:
            if not self.cancelled:
                self._socket = sock
                return
        self._close(sock)
        raise OSError("Request cancelled")

    def clear(self) -> None:
        with self._lock:
            self._socket = None

    @staticmethod
    def _close(sock: socket.socket) -> None:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        sock.close()

    def cancel(self) -> bool:
        with self._lock:
            self.cancelled = True
            sock, self._socket = self._socket, None
        if sock is None:
            return False
        self._close(sock)
        return True


def make_cancel_handle() -> CancelHandle:
    return CancelHandle()


def _open(method: str, url: str, headers: dict[str, str], payload: dict[str, Any] | None,
          timeout_ms: int, cancel: CancelHandle) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    conn = http.client.HTTPConnection(host, port, timeout=timeout_ms / 1000)
    try:
        # Register before connect/TLS so cancellation interrupts those phases too.
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        last_error: OSError | None = None
        for family, socktype, proto, _, address in addresses:
            sock = socket.socket(family, socktype, proto)
            sock.settimeout(timeout_ms / 1000)
            try:
                cancel.register(sock)
                sock.connect(address)
                if parsed.scheme == "https":
                    sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host, do_handshake_on_connect=False)
                    cancel.register(sock)
                    sock.do_handshake()
                conn.sock = sock
                break
            except OSError as error:
                sock.close()
                last_error = error
                if cancel.cancelled:
                    raise
        else:
            raise last_error or OSError("No address")
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        conn.request(method, path, body=json.dumps(payload).encode() if payload is not None else None, headers=headers)
        return conn, conn.getresponse()
    except BaseException:
        conn.close()
        raise


def interruptible_urlopen(method: str, url: str, headers: dict[str, str], payload: dict[str, Any] | None,
                          timeout_ms: int, cancel: CancelHandle) -> tuple[int, str, dict[str, str], dict[str, str]]:
    conn: http.client.HTTPConnection | None = None
    try:
        conn, response = _open(method, url, headers, payload, timeout_ms, cancel)
        return response.status, response.read().decode("utf-8", errors="strict" if 200 <= response.status < 300 else "replace"), dict(response.getheaders()), {}
    except UnicodeError:
        return -1, "", {}, {"category": "parse"}
    except (TimeoutError, socket.timeout):
        return -1, "", {}, {"category": "timeout"}
    except (OSError, http.client.HTTPException):
        return -1, "", {}, {"category": "cancelled" if cancel.cancelled else "connection"}
    finally:
        if conn:
            conn.close()
        cancel.clear()


def _secrets(headers: dict[str, str]) -> list[str]:
    values: list[str] = []
    for key, value in headers.items():
        if any(word in key.lower() for word in ("auth", "key", "token", "secret", "cookie", "credential", "password", "session")):
            values.extend([value, value.removeprefix("Bearer ")])
    return values


async def request_text(provider: str, method: str, url: str, headers: dict[str, str], payload: dict[str, Any] | None,
                       timeout_ms: int, transport: Transport | None = None, known_secrets: list[str] | None = None) -> tuple[int, str]:
    handle = make_cancel_handle()
    try:
        if transport is not None:
            status, body = await asyncio.wait_for(asyncio.to_thread(transport, method, url, headers, payload, timeout_ms), timeout_ms / 1000)
            response_headers: dict[str, str] = {}
        else:
            status, body, response_headers, meta = await asyncio.wait_for(asyncio.to_thread(
                interruptible_urlopen, method, url, headers, payload, timeout_ms, handle), timeout_ms / 1000)
            if status == -1:
                category = meta.get("category", "connection")
                raise provider_transport_error(provider, provider, category, timeout_ms=timeout_ms)  # type: ignore[arg-type]
        if not 200 <= status < 300:
            raise provider_http_error(provider, status, body, provider, response_headers, _secrets(headers) + (known_secrets or []))
        return status, body
    except asyncio.CancelledError:
        handle.cancel()
        raise
    except (TimeoutError, socket.timeout):
        handle.cancel()
        raise provider_transport_error(provider, provider, "timeout", timeout_ms=timeout_ms) from None
    except (OSError, http.client.HTTPException):
        raise provider_transport_error(provider, provider, "connection") from None
    finally:
        handle.cancel()


class EventDecoder:
    """Incremental SSE/NDJSON decoder, including CRLF, multiline data and EOF."""
    def __init__(self, wire: str = "text/event-stream"):
        self.decoder = codecs.getincrementaldecoder("utf-8")("strict")
        self.buffer = ""
        self.data: list[str] = []
        self.ndjson = "ndjson" in wire
        self.saw_field = False
        self.done = False

    def feed(self, chunk: bytes, final: bool = False) -> Iterator[dict[str, Any]]:
        if self.done:
            return
        self.buffer += self.decoder.decode(chunk, final=final)
        lines = self.buffer.split("\n")
        self.buffer = lines.pop()
        if final:
            if self.buffer:
                lines.append(self.buffer)
            self.buffer = ""
            lines.append("")
        for line in lines:
            line = line.removesuffix("\r")
            value: str | None = None
            if self.ndjson:
                value = line.strip() or None
            elif line == "":
                value = "\n".join(self.data) if self.data else None
                self.data = []
            elif line.startswith("data:"):
                self.data.append(line[5:].removeprefix(" "))
                self.saw_field = True
            elif line.startswith((":", "event:", "id:", "retry:")):
                self.saw_field = True
            elif line.strip():
                raise ValueError("Invalid SSE field")
            if value == "[DONE]":
                self.done = True
                break
            if value:
                event = json.loads(value)
                if not isinstance(event, dict):
                    raise ValueError("Expected JSON event object")
                yield event
        if final and not self.ndjson and not self.saw_field:
            raise ValueError("Empty SSE response")


async def request_events(provider: str, method: str, url: str, headers: dict[str, str], payload: dict[str, Any] | None,
                         timeout_ms: int, transport: Transport | None = None, known_secrets: list[str] | None = None) -> AsyncGenerator[dict[str, Any], None]:
    handle = make_cancel_handle()
    conn: http.client.HTTPConnection | None = None
    response: http.client.HTTPResponse | None = None
    started = time.monotonic()

    async def bounded(call: Callable[[], Any]) -> Any:
        remaining = timeout_ms / 1000 - (time.monotonic() - started)
        if remaining <= 0:
            raise TimeoutError()
        return await asyncio.wait_for(asyncio.to_thread(call), remaining)

    try:
        if transport is not None:
            status, text = await bounded(lambda: transport(method, url, headers, payload, timeout_ms))
            if not 200 <= status < 300:
                raise provider_http_error(provider, status, text, provider, known_secrets=_secrets(headers) + (known_secrets or []))
            decoder = EventDecoder("application/x-ndjson" if text.lstrip().startswith("{") else "text/event-stream")
            for event in decoder.feed(text.encode(), final=True):
                if event.get("error"):
                    raise provider_http_error(provider, event.get("status", 500), event, provider, known_secrets=_secrets(headers) + (known_secrets or []))
                yield event
            return
        conn, response = await bounded(lambda: _open(method, url, headers, payload, timeout_ms, handle))
        if not 200 <= response.status < 300:
            text = (await bounded(response.read)).decode("utf-8", errors="replace")
            raise provider_http_error(provider, response.status, text, provider, dict(response.getheaders()), _secrets(headers) + (known_secrets or []))
        decoder = EventDecoder(response.getheader("content-type") or "text/event-stream")
        while not decoder.done:
            chunk = await bounded(lambda: response.read1(8192))
            for event in decoder.feed(chunk, final=not chunk):
                if event.get("error"):
                    raise provider_http_error(provider, event.get("status", 500), event, provider, known_secrets=_secrets(headers) + (known_secrets or []))
                yield event
            if not chunk:
                break
    except asyncio.CancelledError:
        raise
    except (TimeoutError, socket.timeout):
        raise provider_transport_error(provider, provider, "timeout", timeout_ms=timeout_ms) from None
    except (ValueError, UnicodeError):
        raise provider_parse_error(provider, None, provider) from None
    except (OSError, http.client.HTTPException):
        raise provider_transport_error(provider, provider, "connection") from None
    finally:
        handle.cancel()
        if response:
            response.close()
        if conn:
            conn.close()
