from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

from backend.app.providers.vision import ArkVisionProvider, OpenAIVisionProvider, ProviderError, provider_from_environment


class OpenAIProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.provider = OpenAIVisionProvider("test-key")

    def test_extracts_structured_output_and_usage(self) -> None:
        body = {"status":"completed","model":"test-model","output":[{"content":[{"type":"output_text","text":json.dumps({"risk_candidates":[]})}]}],"usage":{"input_tokens":10,"output_tokens":2}}
        self.assertEqual(self.provider._extract(body), {"risk_candidates": []})
        self.assertEqual(self.provider._usage(body, 1)["retry_count"], 1)

    def test_refusal_is_explicit(self) -> None:
        with self.assertRaises(ProviderError) as raised:
            self.provider._extract({"status":"completed","output":[{"content":[{"type":"refusal","refusal":"no"}]}]})
        self.assertEqual(raised.exception.code, "provider_refusal")

    def test_http_request_is_private_structured_and_retried(self) -> None:
        quality = {"usable": True, "clear": True, "floor_visible": True, "path_visible": True, "lighting_sufficient": True, "major_occlusion": False, "scene_elements": ["floor"], "missing_views": []}

        class Handler(BaseHTTPRequestHandler):
            calls = 0
            payload = None

            def do_POST(self):  # noqa: N802
                type(self).calls += 1
                length = int(self.headers["Content-Length"])
                type(self).payload = json.loads(self.rfile.read(length))
                if type(self).calls == 1:
                    self.send_response(500)
                    self.end_headers()
                    return
                body = json.dumps({"status": "completed", "model": "stub-model", "output": [{"content": [{"type": "output_text", "text": json.dumps(quality)}]}], "usage": {"input_tokens": 4, "output_tokens": 2}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "photo.jpg"
                path.write_bytes(b"\xff\xd8\xffdemo")
                provider = OpenAIVisionProvider("test-key", endpoint=f"http://127.0.0.1:{server.server_address[1]}", timeout_seconds=1)
                result, usage = provider.quality("assessment-1", {"media_id": "media-1", "path": str(path), "mime_type": "image/jpeg"})
            self.assertTrue(result["usable"])
            self.assertEqual(Handler.calls, 2)
            self.assertEqual(usage["retry_count"], 1)
            self.assertFalse(Handler.payload["store"])
            self.assertTrue(Handler.payload["text"]["format"]["strict"])
            self.assertEqual(Handler.payload["input"][0]["content"][1]["detail"], "low")
            self.assertEqual(Handler.payload["reasoning"], {"effort": "medium"})
            self.assertNotIn("thinking", Handler.payload)
            self.assertNotIn("test-key", json.dumps(Handler.payload))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_socket_timeout_is_retried_and_mapped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "photo.jpg"
            path.write_bytes(b"\xff\xd8\xffdemo")
            media = {"media_id": "media-1", "path": str(path), "mime_type": "image/jpeg"}
            with patch("backend.app.providers.vision.urlopen", side_effect=socket.timeout("read timed out")) as request:
                with patch("backend.app.providers.vision.time.sleep"):
                    with self.assertRaises(ProviderError) as raised:
                        self.provider.quality("assessment-1", media)
        self.assertEqual(raised.exception.code, "provider_timeout")
        self.assertTrue(raised.exception.retryable)
        self.assertEqual(request.call_count, 2)

    def test_ark_request_disables_thinking(self) -> None:
        quality = {"usable": True, "clear": True, "floor_visible": True, "path_visible": True, "lighting_sufficient": True, "major_occlusion": False, "scene_elements": ["floor"], "missing_views": []}
        response = {
            "status": "completed",
            "model": "doubao-test-model",
            "output": [{"content": [{"type": "output_text", "text": json.dumps(quality)}]}],
        }

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "photo.jpg"
            path.write_bytes(b"\xff\xd8\xffdemo")
            media = {"media_id": "media-1", "path": str(path), "mime_type": "image/jpeg"}
            provider = ArkVisionProvider("ark-test-key", model_name="doubao-test-model")

            class Response:
                def __enter__(self):
                    return self

                def __exit__(self, *_):
                    return False

                def read(self):
                    return json.dumps(response).encode()

            with patch("backend.app.providers.vision.urlopen", return_value=Response()) as request:
                result, _ = provider.quality("assessment-1", media)

        payload = json.loads(request.call_args.args[0].data)
        self.assertTrue(result["usable"])
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertNotIn("reasoning", payload)

    def test_ark_maps_original_image_detail_to_high(self) -> None:
        analysis = {"room_type": "bathroom", "scene_elements": ["floor"], "risk_candidates": []}
        response = {
            "status": "completed",
            "model": "doubao-test-model",
            "output": [{"content": [{"type": "output_text", "text": json.dumps(analysis)}]}],
        }

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "photo.jpg"
            path.write_bytes(b"\xff\xd8\xffdemo")
            media = [{"media_id": "media-1", "path": str(path), "mime_type": "image/jpeg"}]
            provider = ArkVisionProvider("ark-test-key", model_name="doubao-test-model")

            class Response:
                def __enter__(self):
                    return self

                def __exit__(self, *_):
                    return False

                def read(self):
                    return json.dumps(response).encode()

            with patch("backend.app.providers.vision.urlopen", return_value=Response()) as request:
                result, _ = provider.analyze("assessment-1", "bathroom", media, ["BATH_NO_GRAB_BAR"])

        payload = json.loads(request.call_args.args[0].data)
        self.assertEqual(result["room_type"], "bathroom")
        self.assertEqual(payload["input"][0]["content"][1]["detail"], "high")
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertNotIn("reasoning", payload)
        self.assertEqual(self.provider._image_detail("original"), "original")

    def test_selects_ark_provider_from_environment(self) -> None:
        environment = {
            "ANJU_MOCK_ANALYSIS": "0",
            "ANJU_VISION_PROVIDER": "ark",
            "ARK_API_KEY": "ark-test-key",
            "ANJU_ARK_MODEL": "doubao-test-model",
        }
        with patch.dict("os.environ", environment, clear=True):
            provider = provider_from_environment()
        self.assertIsInstance(provider, ArkVisionProvider)
        self.assertEqual(provider.provider_name, "ark")
        self.assertEqual(provider.model_name, "doubao-test-model")
        self.assertEqual(provider.endpoint, "https://ark.cn-beijing.volces.com/api/v3/responses")
        self.assertEqual(provider.timeout_seconds, 60)

    def test_ark_provider_requires_server_side_key(self) -> None:
        with patch.dict("os.environ", {"ANJU_VISION_PROVIDER": "ark"}, clear=True):
            with self.assertRaises(ProviderError) as raised:
                provider_from_environment()
        self.assertEqual(raised.exception.code, "provider_not_configured")


if __name__ == "__main__":
    unittest.main()
