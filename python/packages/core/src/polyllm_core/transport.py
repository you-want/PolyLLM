"""Interruptible HTTP transport for PolyLLM Python plugins (v0.4.0 T3).

The default plugin transport (``urllib_transport``) runs
``urllib.request.urlopen`` inside a thread via ``asyncio.to_thread``.
M1's feasibility study (docs/protocol.md §9.1) showed that cancelling the
awaiting coroutine does *not* interrupt that blocking call — the worker
thread keeps reading until the server responds or the socket-level timeout
expires, so the connection leaks.

This module provides ``interruptible_urlopen``, a drop-in replacement that
registers its live socket so an external ``cancel()`` can force-close it.
When cancelled, the worker's blocking read raises ``OSError`` and the
worker returns within one poll tick, releasing the connection immediately
(docs/protocol.md §9.2). It is still built on ``asyncio.to_thread``, keeps
the existing injectable-``transport`` constructor signature, and adds no
new dependencies (standard-library ``http.client`` / ``socket`` only).

A worker call returns ``(status_code, body_text, response_headers)``:

* ``status_code`` of ``-1`` with empty body means no status line was ever
  received — either the connection was cancelled before the response or a
  socket-level timeout fired. The caller decides which of those happened by
  checking ``handle.cancelled``.
* ``response_headers`` are included so the classifier can read
  ``Retry-After`` / request ids (see ``polyllm_core.errors``).

Usage inside a plugin::

    handle = make_cancel_handle()
    status, body, headers = await asyncio.to_thread(
        interruptible_urlopen, method, url, headers, payload, timeout_ms, handle,
    )
    # On the async side, when the calling task is cancelled:
    handle.cancel()
"""

from __future__ import annotations

import http.client
import json
import socket
import threading
from typing import Any


class CancelHandle:
    """Holds the live socket of a running worker so it can be force-closed.

    ``cancel()`` is safe to call from the async side or the worker's own
    thread; it is idempotent and a no-op once the socket already closed.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._socket: socket.socket | None = None
        self.cancelled = False

    def register(self, sock: socket.socket) -> None:
        with self._lock:
            self._socket = sock

    def clear(self) -> None:
        with self._lock:
            self._socket = None

    def cancel(self) -> bool:
        """Force-close the registered socket. Returns True if one was closed."""
        self.cancelled = True
        with self._lock:
            sock = self._socket
            self._socket = None
        if sock is None:
            return False
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            sock.close()
        except OSError:
            pass
        return True


def make_cancel_handle() -> CancelHandle:
    return CancelHandle()


def interruptible_urlopen(
    method: str,
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any] | None,
    timeout_ms: int,
    cancel: CancelHandle,
) -> tuple[int, str, dict[str, str]]:
    """Blocking fetch in a worker thread whose socket can be force-closed.

    See module docstring for the return contract.
    """
    scheme, netloc_path = url.split("://", 1)
    hostport, _, path_query = netloc_path.partition("/")
    host, _, port_str = hostport.partition(":")
    default_port = 443 if scheme == "https" else 80
    port = int(port_str) if port_str else default_port
    path = "/" + path_query if path_query else "/"

    use_ssl = scheme == "https"
    conn = http.client.HTTPConnection(host, port, timeout=timeout_ms / 1000)

    # Establish the socket explicitly so we can register the live handle and
    # later force-close it. Reuse the connection object's own socket.
    try:
        conn.connect()
    except Exception:
        cancel.clear()
        return -1, "", {}

    sock = conn.sock
    if sock is None:
        cancel.clear()
        return -1, "", {}
    if use_ssl:
        import ssl

        try:
            context = ssl.create_default_context()
            sock = context.wrap_socket(sock, server_hostname=host)
            conn.sock = sock
        except OSError:
            cancel.clear()
            return -1, "", {}
    cancel.register(sock)

    body_bytes = json.dumps(payload).encode("utf-8") if payload is not None else None
    try:
        conn.request(method, path, body=body_bytes, headers=headers)
        response = conn.getresponse()
        status = response.status
        raw = response.read()
        resp_headers = {k: v for k, v in response.getheaders()}
        cancel.clear()
        return status, raw.decode("utf-8", errors="replace"), resp_headers
    except (OSError, http.client.HTTPException, socket.timeout):
        # A cancellation, a socket-level timeout, or a mid-stream reset all
        # land here. The caller distinguishes them via handle.cancelled.
        cancel.clear()
        return -1, "", {}
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001 - cleanup only
            pass
