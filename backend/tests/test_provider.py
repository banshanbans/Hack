from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

from backend.app.providers.vision import CAMERA_SCHEMA, ArkVisionProvider, OpenAIVisionProvider, ProviderError, provider_from_environment, renovation_grounding_schema, schema_with_allowed_risks
from backend.app.providers.renovation import ArkRenovationProvider, renovation_provider_from_environment
from backend.app.providers.voice import VolcengineVoiceProvider, build_rtc_token


class VoiceProviderTests(unittest.TestCase):
    def test_rtc_token_is_short_lived_and_voice_is_off_by_default(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(VolcengineVoiceProvider.configured())
        token = build_rtc_token(
            "123456789012345678901234", "test-app-key", "advisor-room", "advisor-user", 2_000_000_000,
        )
        self.assertTrue(token.startswith("001"))
        self.assertNotIn("test-app-key", token)

    def test_voice_requires_every_server_side_credential(self) -> None:
        environment = {
            "ANJU_ENABLE_VOICE_ADVISOR": "1",
            "ANJU_VOLC_RTC_APP_ID": "app",
            "ANJU_VOLC_RTC_APP_KEY": "key",
            "ANJU_VOLC_ACCESS_KEY": "ak",
            "ANJU_VOLC_SECRET_KEY": "sk",
            "ANJU_VOLC_VOICE_CONFIG_JSON": "{}",
        }
        with patch.dict(os.environ, environment, clear=True):
            self.assertTrue(VolcengineVoiceProvider.configured())
            del os.environ["ANJU_VOLC_SECRET_KEY"]
            self.assertFalse(VolcengineVoiceProvider.configured())

    def test_video_advisor_requires_https_callback_signature_and_llm_config(self) -> None:
        environment = {
            "ANJU_ENABLE_VOICE_ADVISOR": "1",
            "ANJU_ENABLE_RTC_VIDEO_ADVISOR": "1",
            "ANJU_VOLC_RTC_APP_ID": "123456789012345678901234",
            "ANJU_VOLC_RTC_APP_KEY": "key",
            "ANJU_VOLC_ACCESS_KEY": "ak",
            "ANJU_VOLC_SECRET_KEY": "sk",
            "ANJU_VOLC_VOICE_CONFIG_JSON": json.dumps({"Config": {"LLMConfig": {}}}),
            "ANJU_VOLC_FC_CALLBACK_URL": "https://example.test/api/internal/rtc/function-calls",
            "ANJU_VOLC_FC_CALLBACK_SIGNATURE": "an-independent-signature-value",
        }
        with patch.dict(os.environ, environment, clear=True):
            with patch.object(VolcengineVoiceProvider, "_video_probe_succeeded_at", 0.0):
                self.assertTrue(VolcengineVoiceProvider.video_configured())
                self.assertFalse(VolcengineVoiceProvider.video_healthy())
                VolcengineVoiceProvider.mark_video_probe_success()
                self.assertTrue(VolcengineVoiceProvider.video_healthy())
            os.environ["ANJU_VOLC_FC_CALLBACK_URL"] = "http://example.test/callback"
            self.assertFalse(VolcengineVoiceProvider.video_configured())
            os.environ["ANJU_VOLC_FC_CALLBACK_URL"] = "https://example.test/callback"
            os.environ["ANJU_VOLC_FC_CALLBACK_SIGNATURE"] = "short"
            self.assertFalse(VolcengineVoiceProvider.video_configured())

    def test_video_start_sets_snapshot_tools_and_function_callback(self) -> None:
        environment = {
            "ANJU_ENABLE_VOICE_ADVISOR": "1",
            "ANJU_ENABLE_RTC_VIDEO_ADVISOR": "1",
            "ANJU_VOLC_RTC_APP_ID": "123456789012345678901234",
            "ANJU_VOLC_RTC_APP_KEY": "key",
            "ANJU_VOLC_ACCESS_KEY": "ak",
            "ANJU_VOLC_SECRET_KEY": "sk",
            "ANJU_VOLC_VOICE_CONFIG_JSON": json.dumps({"Config": {"LLMConfig": {}}}),
            "ANJU_VOLC_FC_CALLBACK_URL": "https://example.test/api/internal/rtc/function-calls",
            "ANJU_VOLC_FC_CALLBACK_SIGNATURE": "an-independent-signature-value",
        }
        tools = [{"type": "function", "function": {"name": "record_camera_suggestions"}}]
        with patch.dict(os.environ, environment, clear=True), patch.object(
            VolcengineVoiceProvider, "_call", return_value={"Result": "ok"},
        ) as request:
            VolcengineVoiceProvider().start(
                "session-id", "开始扫描", "当前房间是卫生间。", video_enabled=True, tools=tools,
            )
        action, body = request.call_args.args
        self.assertEqual(action, "StartVoiceChat")
        llm = body["Config"]["LLMConfig"]
        self.assertEqual(llm["VisionConfig"]["SnapshotConfig"], {
            "Interval": 900, "ImagesLimit": 1, "Height": 720, "ImageDetail": "low",
        })
        self.assertEqual(llm["Tools"], tools)
        self.assertEqual(llm["ThinkingType"], "disabled")
        self.assertEqual(body["Config"]["FunctionCallingConfig"], {
            "ServerMessageUrl": environment["ANJU_VOLC_FC_CALLBACK_URL"],
            "ServerMessageSignature": environment["ANJU_VOLC_FC_CALLBACK_SIGNATURE"],
        })
        self.assertIn("风险等级", llm["SystemMessages"][-1])

    def test_function_result_uses_provider_tool_call_envelope(self) -> None:
        with patch.object(VolcengineVoiceProvider, "_call", return_value={"Result": "ok"}) as request:
            VolcengineVoiceProvider().update_function_result(
                app_id="app", room_id="room", task_id="task", tool_call_id="call-1",
                result={"ok": True, "recorded": 1},
            )
        action, body = request.call_args.args
        self.assertEqual(action, "UpdateVoiceChat")
        self.assertEqual(body["Command"], "function")
        message = json.loads(body["Message"])
        self.assertEqual(message["ToolCallID"], "call-1")
        self.assertEqual(json.loads(message["Content"]), {"ok": True, "recorded": 1})


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

    def test_renovation_grounding_constrains_actions_and_uses_after_image_coordinates(self) -> None:
        schema = renovation_grounding_schema(["grab_bar", "night_light", "grab_bar"])
        action_schema = schema["properties"]["action_regions"]["items"]["properties"]["action_code"]
        self.assertEqual(action_schema["enum"], ["grab_bar", "night_light"])
        with patch.object(self.provider, "_request", return_value=({"action_regions": []}, {})) as request:
            self.provider.ground_renovation_changes(
                "assessment-1",
                {"media_id": "before", "path": "/tmp/before.jpg", "mime_type": "image/jpeg"},
                {"media_id": "after", "path": "/tmp/after.jpg", "mime_type": "image/jpeg"},
                [{"action_code": "grab_bar", "label": "安装扶手", "risk_title": "缺少支撑"}],
            )
        prompt = request.call_args.args[1]
        self.assertIn("第二张图片左上角", prompt)
        self.assertIn("不得返回未选动作", prompt)
        self.assertEqual([item["media_id"] for item in request.call_args.args[2]], ["before", "after"])
        self.assertEqual(request.call_args.kwargs["max_attempts"], 1)

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

    def test_ark_renovation_provider_sends_private_image_and_downloads_output(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            payload = None

            def do_POST(self):  # noqa: N802
                length = int(self.headers["Content-Length"])
                type(self).payload = json.loads(self.rfile.read(length))
                body = json.dumps({"data": [{"b64_json": "/9j/cmVub3ZhdGlvbg=="}], "usage": {"generated_images": 1}}).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

            def log_message(self, *_):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "source.jpg"; path.write_bytes(b"\xff\xd8\xffsource")
                provider = ArkRenovationProvider("secret", endpoint=f"http://127.0.0.1:{server.server_address[1]}", timeout_seconds=1)
                image = provider.edit("assessment", {"path": str(path), "mime_type": "image/jpeg"}, "只增加扶手")
            self.assertEqual(image.mime_type, "image/jpeg")
            self.assertTrue(Handler.payload["image"][0].startswith("data:image/jpeg;base64,"))
            self.assertFalse(Handler.payload["watermark"])
            self.assertNotIn("secret", json.dumps(Handler.payload))
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_renovation_provider_requires_key_outside_mock(self) -> None:
        with patch.dict(os.environ, {"ANJU_MOCK_ANALYSIS": "0", "ARK_API_KEY": ""}, clear=True):
            with self.assertRaises(ProviderError) as raised:
                renovation_provider_from_environment()
        self.assertEqual(raised.exception.code, "provider_not_configured")

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

    def test_home_camera_model_is_shared_by_h5_and_ios_sources(self) -> None:
        provider = ArkVisionProvider("ark-test-key", model_name="pro-model")
        media = {
            "media_id": "native-frame", "path": "/tmp/not-read.jpg", "mime_type": "image/jpeg",
            "source_kind": "ios_camera_frame",
        }
        rules = [{"risk_code": "floor_clutter", "visual_cue": "通道中有杂物"}]
        with patch.dict("os.environ", {
            "ANJU_ARK_HOME_CAMERA_MODEL": "home-camera-model",
            "ANJU_ARK_H5_CAMERA_MODEL": "legacy-h5-model",
        }), patch.object(
            provider, "_request", return_value=({}, {})
        ) as request:
            provider.inspect_camera("assessment-1", "bathroom", media, rules, {}, [])

        self.assertEqual(request.call_args.kwargs["model_name"], "home-camera-model")
        self.assertEqual(request.call_args.kwargs["max_attempts"], 1)
        prompt = request.call_args.args[1]
        self.assertIn("ios_camera_frame", prompt)

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
