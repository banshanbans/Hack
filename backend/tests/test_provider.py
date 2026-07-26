from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

from backend.app.providers.vision import CAMERA_SCHEMA, ArkVisionProvider, OpenAIVisionProvider, ProviderError, provider_from_environment, schema_with_allowed_risks


class OpenAIProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.provider = OpenAIVisionProvider("test-key")

    def test_extracts_structured_output_and_usage(self) -> None:
        body = {"status":"completed","model":"test-model","output":[{"content":[{"type":"output_text","text":json.dumps({"risk_candidates":[]})}]}],"usage":{"input_tokens":10,"output_tokens":2}}
        self.assertEqual(self.provider._extract(body), {"risk_candidates": []})
        self.assertEqual(self.provider._usage(body, 1)["retry_count"], 1)

    def test_request_schema_constrains_risk_codes_without_mutating_shared_schema(self) -> None:
        constrained = schema_with_allowed_risks(CAMERA_SCHEMA, ["RISK_B", "RISK_A", "RISK_A"])
        risk_schema = constrained["properties"]["suggestions"]["items"]["properties"]["risk_code"]
        self.assertEqual(risk_schema["enum"], ["RISK_A", "RISK_B"])
        self.assertNotIn("enum", CAMERA_SCHEMA["properties"]["suggestions"]["items"]["properties"]["risk_code"])

        with self.assertRaises(ProviderError) as raised:
            schema_with_allowed_risks(CAMERA_SCHEMA, [])
        self.assertEqual(raised.exception.code, "provider_invalid_request")

    def test_refusal_is_explicit(self) -> None:
        with self.assertRaises(ProviderError) as raised:
            self.provider._extract({"status":"completed","output":[{"content":[{"type":"refusal","refusal":"no"}]}]})
        self.assertEqual(raised.exception.code, "provider_refusal")

    def test_http_request_is_private_structured_and_retried(self) -> None:
        quality = {"usable": True, "clear": True, "floor_visible": True, "path_visible": True, "lighting_sufficient": True, "major_occlusion": False, "scene_elements": ["floor"], "missing_element_ids": []}

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
            self.assertIsInstance(usage["latency_ms"], int)
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

    def test_realtime_camera_timeout_does_not_start_a_second_model_call(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "camera.jpg"
            path.write_bytes(b"\xff\xd8\xffdemo")
            media = {"media_id": "frame-1", "path": str(path), "mime_type": "image/jpeg"}
            camera_rules = [{"risk_code": "floor_clutter", "visual_cue": "通道中有杂物"}]
            with patch("backend.app.providers.vision.urlopen", side_effect=socket.timeout("read timed out")) as request:
                with self.assertRaises(ProviderError) as raised:
                    self.provider.inspect_camera("assessment-1", "bathroom", media, camera_rules, {}, [])
        self.assertEqual(raised.exception.code, "provider_timeout")
        self.assertEqual(request.call_count, 1)

    def test_h5_live_camera_uses_dedicated_camera_model(self) -> None:
        provider = ArkVisionProvider("ark-test-key", model_name="pro-model")
        media = {"media_id": "frame-1", "path": "/tmp/not-read.jpg", "mime_type": "image/jpeg"}
        camera_rules = [{"risk_code": "floor_clutter", "visual_cue": "通道中有杂物"}]
        with patch.dict("os.environ", {
            "ANJU_ARK_H5_CAMERA_MODEL": "h5-camera-model",
            "ANJU_ARK_TURBO_MODEL": "ios-turbo-model",
        }), patch.object(
            provider, "_request", return_value=({}, {})
        ) as request:
            provider.inspect_camera("assessment-1", "living_room", media, camera_rules, {}, [])

        self.assertEqual(request.call_args.kwargs["model_name"], "h5-camera-model")
        self.assertEqual(request.call_args.kwargs["max_attempts"], 1)
        prompt = request.call_args.args[1]
        self.assertIn("豆包/懒人沙发/椅子", prompt)
        self.assertIn("裸露线缆、延长线或插排", prompt)
        self.assertIn("平台或舞台边缘、临时台阶或门槛", prompt)
        self.assertIn("电缆保护槽", prompt)
        self.assertIn("同一物理问题在同一帧只输出一个最具体的 risk_code", prompt)

    def test_h5_live_camera_falls_back_to_shared_turbo_model(self) -> None:
        provider = ArkVisionProvider("ark-test-key", model_name="pro-model")
        media = {"media_id": "frame-1", "path": "/tmp/not-read.jpg", "mime_type": "image/jpeg"}
        camera_rules = [{"risk_code": "floor_clutter", "visual_cue": "通道中有杂物"}]
        with patch.dict("os.environ", {"ANJU_ARK_TURBO_MODEL": "shared-turbo-model"}, clear=True), patch.object(
            provider, "_request", return_value=({}, {})
        ) as request:
            provider.inspect_camera("assessment-1", "living_room", media, camera_rules, {}, [])

        self.assertEqual(request.call_args.kwargs["model_name"], "shared-turbo-model")

    def test_ios_camera_uses_dedicated_turbo_model_and_constrains_schema(self) -> None:
        provider = ArkVisionProvider("ark-test-key", model_name="pro-model")
        media = {"media_id": "fair-frame", "path": "/tmp/not-read.jpg", "mime_type": "image/jpeg"}
        rules = [{
            "risk_code": "marked_exit_obstruction", "title": "明确标识的出口通道被占用",
            "visual_cue": "出口标识与障碍同时可见",
            "evidence_codes": ["marked_exit_visible", "localized_obstruction_visible"],
            "required_evidence_codes": ["marked_exit_visible", "localized_obstruction_visible"],
        }]
        with patch.dict("os.environ", {
            "ANJU_ARK_IOS_CAMERA_MODEL": "doubao-seed-2-1-turbo-260628",
            "ANJU_ARK_PRO_MODEL": "pro-direct-model",
        }), patch.object(
            provider, "_request", return_value=({}, {})
        ) as request:
            provider.fair_analyze("scan-1", "entrance", media, rules)

        schema = request.call_args.args[3]
        candidate = schema["properties"]["candidates"]["items"]
        self.assertEqual(candidate["properties"]["risk_code"]["enum"], ["marked_exit_obstruction"])
        self.assertEqual(candidate["properties"]["evidence_codes"]["items"]["enum"], ["localized_obstruction_visible", "marked_exit_visible"])
        self.assertIn("evidence_codes", candidate["required"])
        self.assertEqual(request.call_args.args[7], "doubao-seed-2-1-turbo-260628")
        self.assertEqual(request.call_args.args[6], "anju_ios_fair_camera_direct_v3")
        prompt = request.call_args.args[1]
        self.assertIn("豆包/懒人沙发/椅子", prompt)
        self.assertIn("裸露线缆、延长线或插排", prompt)
        self.assertIn("舞台边缘、临时台阶或门槛", prompt)
        self.assertIn("电缆保护槽", prompt)
        self.assertIn("同一物理问题在同一帧只输出一个最具体的 risk_code", prompt)

    def test_ios_camera_falls_back_to_shared_turbo_model(self) -> None:
        provider = ArkVisionProvider("ark-test-key", model_name="pro-model")
        media = {"media_id": "fair-frame", "path": "/tmp/not-read.jpg", "mime_type": "image/jpeg"}
        rules = [{
            "risk_code": "floor_clutter", "title": "低位物体侵入通行区域", "visual_cue": "通道中有杂物",
            "evidence_codes": ["localized_obstruction_visible", "path_intrusion_visible"],
            "required_evidence_codes": ["localized_obstruction_visible", "path_intrusion_visible"],
        }]
        with patch.dict("os.environ", {"ANJU_ARK_TURBO_MODEL": "shared-turbo-model"}, clear=True), patch.object(
            provider, "_request", return_value=({}, {})
        ) as request:
            provider.fair_analyze("scan-1", "entrance", media, rules)

        self.assertEqual(request.call_args.args[7], "shared-turbo-model")

    def test_ios_camera_defaults_to_requested_turbo_model(self) -> None:
        provider = ArkVisionProvider("ark-test-key", model_name="pro-model")
        media = {"media_id": "fair-frame", "path": "/tmp/not-read.jpg", "mime_type": "image/jpeg"}
        rules = [{
            "risk_code": "floor_clutter", "title": "低位物体侵入通行区域", "visual_cue": "通道中有杂物",
            "evidence_codes": ["localized_obstruction_visible", "path_intrusion_visible"],
            "required_evidence_codes": ["localized_obstruction_visible", "path_intrusion_visible"],
        }]
        with patch.dict("os.environ", {}, clear=True), patch.object(
            provider, "_request", return_value=({}, {})
        ) as request:
            provider.fair_analyze("scan-1", "entrance", media, rules)

        self.assertEqual(request.call_args.args[7], "doubao-seed-2-1-turbo-260628")

    def test_ark_request_disables_thinking(self) -> None:
        quality = {"usable": True, "clear": True, "floor_visible": True, "path_visible": True, "lighting_sufficient": True, "major_occlusion": False, "scene_elements": ["floor"], "missing_element_ids": []}
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
        risk_schema = payload["text"]["format"]["schema"]["properties"]["risk_candidates"]["items"]["properties"]["risk_code"]
        self.assertEqual(risk_schema["enum"], ["BATH_NO_GRAB_BAR"])
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

    def test_ark_uses_pro_model_and_disables_thinking_by_default(self) -> None:
        with patch.dict("os.environ", {"ANJU_MOCK_ANALYSIS": "0", "ANJU_VISION_PROVIDER": "ark", "ARK_API_KEY": "ark-test-key"}, clear=True):
            provider = provider_from_environment()
        self.assertEqual(provider.model_name, "doubao-seed-2-1-pro-260628")
        self.assertEqual(provider._generation_options(), {"thinking": {"type": "disabled"}})

    def test_ark_provider_requires_server_side_key(self) -> None:
        with patch.dict("os.environ", {"ANJU_VISION_PROVIDER": "ark"}, clear=True):
            with self.assertRaises(ProviderError) as raised:
                provider_from_environment()
        self.assertEqual(raised.exception.code, "provider_not_configured")


if __name__ == "__main__":
    unittest.main()
