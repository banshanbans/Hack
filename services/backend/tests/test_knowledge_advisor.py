from pathlib import Path
import os
import tempfile
import threading
import unittest
from unittest.mock import patch

from backend.app.assessment_service import AssessmentError, AssessmentService
from backend.app.providers import MockKnowledgeAdvisorProvider, MockVisionProvider, ProviderError, VoiceConnection, VolcengineVoiceProvider
from backend.app.repositories import SQLiteRepository


class BlockingKnowledgeProvider(MockKnowledgeAdvisorProvider):
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def answer(self, session_id, history, question, knowledge):
        self.started.set()
        self.release.wait(timeout=3)
        return super().answer(session_id, history, question, knowledge)


class HTMLKnowledgeProvider(MockKnowledgeAdvisorProvider):
    def answer(self, session_id, history, question, knowledge):
        del session_id, history, question, knowledge
        return {
            "answer": "<script>alert('x')</script><b>保持通道整洁</b>" + "安" * 900,
            "suggested_questions": ["还可以注意什么？"],
        }, {
            "provider": "mock", "model": "safe-test", "prompt_version": "anju_knowledge_advisor_v1",
            "latency_ms": 1, "schema_result": "valid", "error_type": None,
        }


class InvalidKnowledgeProvider(MockKnowledgeAdvisorProvider):
    def answer(self, session_id, history, question, knowledge):
        del session_id, history, question, knowledge
        return {"answer": "内容", "suggested_questions": "not-an-array"}, {
            "provider": "mock", "model": "invalid-test", "prompt_version": "anju_knowledge_advisor_v1",
            "latency_ms": 1, "schema_result": "invalid", "error_type": None,
        }


class KnowledgeAdvisorServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.flags = patch.dict(os.environ, {
            "ANJU_ENABLE_KNOWLEDGE_ADVISOR": "1", "ANJU_ENABLE_VOICE_ADVISOR": "0",
        })
        self.flags.start()
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.service = AssessmentService(
            SQLiteRepository(root / "api.db"), root / "media", provider=MockVisionProvider(),
            knowledge_advisor_provider=MockKnowledgeAdvisorProvider(),
        )

    def tearDown(self) -> None:
        self.service.close()
        self.temp.cleanup()
        self.flags.stop()

    def test_hashed_token_sliding_expiry_and_no_assessment_pollution(self) -> None:
        created = self.service.knowledge_advisor.create_session()
        row = self.service.repository.fetchone(
            "SELECT * FROM knowledge_advisor_sessions WHERE id=?", (created["session_id"],),
        )
        self.assertNotEqual(row["token_hash"], created["access_token"])
        self.assertEqual(self.service.repository.fetchone("SELECT COUNT(*) AS value FROM assessments")["value"], 0)
        old_expiry = row["expires_at"]
        restored = self.service.knowledge_advisor.get_session(created["session_id"])
        self.assertGreaterEqual(restored["expires_at"], old_expiry)
        with self.assertRaises(AssessmentError) as denied:
            self.service.knowledge_advisor.authorize(created["session_id"], "wrong-token")
        self.assertEqual(denied.exception.code, "knowledge_advisor_access_denied")

    def test_expired_session_is_rejected_and_marked_expired(self) -> None:
        created = self.service.knowledge_advisor.create_session()
        self.service.repository.execute(
            "UPDATE knowledge_advisor_sessions SET expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (created["session_id"],),
        )
        with self.assertRaises(AssessmentError) as expired:
            self.service.knowledge_advisor.authorize(created["session_id"], created["access_token"])
        self.assertEqual(expired.exception.code, "knowledge_advisor_session_expired")
        self.assertIsNone(self.service.repository.fetchone(
            "SELECT status FROM knowledge_advisor_sessions WHERE id=?", (created["session_id"],),
        ))

    def test_input_message_and_single_request_limits(self) -> None:
        blocking = BlockingKnowledgeProvider()
        self.service.knowledge_advisor._provider = blocking
        created = self.service.knowledge_advisor.create_session()
        session_id = created["session_id"]
        outcome: list[object] = []
        worker = threading.Thread(target=lambda: outcome.append(
            self.service.knowledge_advisor.add_message(session_id, "卫生间扶手怎么选？")
        ))
        worker.start()
        self.assertTrue(blocking.started.wait(timeout=1))
        with self.assertRaises(AssessmentError) as busy:
            self.service.knowledge_advisor.add_message(session_id, "防滑怎么做？")
        self.assertEqual(busy.exception.code, "knowledge_advisor_request_in_progress")
        blocking.release.set()
        worker.join(timeout=2)
        self.assertEqual(len(outcome), 1)
        with self.assertRaises(AssessmentError) as invalid:
            self.service.knowledge_advisor.add_message(session_id, "问" * 501)
        self.assertEqual(invalid.exception.code, "knowledge_advisor_message_invalid")

    def test_output_is_plain_text_and_capped_at_800_characters(self) -> None:
        self.service.knowledge_advisor._provider = HTMLKnowledgeProvider()
        created = self.service.knowledge_advisor.create_session()
        answer = self.service.knowledge_advisor.add_message(created["session_id"], "通道怎么整理？")
        text = answer["assistant_turn"]["text"]
        self.assertNotIn("<script", text)
        self.assertNotIn("<b>", text)
        self.assertLessEqual(len(text), 800)
        stored_call = self.service.repository.fetchone(
            "SELECT * FROM knowledge_advisor_provider_calls WHERE session_id=?", (created["session_id"],),
        )
        self.assertNotIn("question", stored_call)
        self.assertNotIn("answer", stored_call)

    def test_session_accepts_at_most_fifty_user_messages(self) -> None:
        created = self.service.knowledge_advisor.create_session()
        for index in range(50):
            self.service.knowledge_advisor._insert_turn(
                created["session_id"], "user", "text", f"测试问题 {index}",
            )
        with self.assertRaises(AssessmentError) as limited:
            self.service.knowledge_advisor.add_message(created["session_id"], "还能继续问吗？")
        self.assertEqual(limited.exception.code, "knowledge_advisor_message_limit")

    def test_schema_failure_does_not_create_fake_assistant_answer(self) -> None:
        self.service.knowledge_advisor._provider = InvalidKnowledgeProvider()
        created = self.service.knowledge_advisor.create_session()
        with self.assertRaises(ProviderError) as invalid:
            self.service.knowledge_advisor.add_message(created["session_id"], "防滑怎么做？")
        self.assertEqual(invalid.exception.code, "provider_invalid_response")
        assistant_messages = self.service.repository.fetchone(
            "SELECT COUNT(*) AS value FROM knowledge_advisor_turns WHERE session_id=? AND role='assistant' AND kind='text'",
            (created["session_id"],),
        )
        self.assertEqual(assistant_messages["value"], 0)

    def test_voice_transcripts_are_idempotent_and_store_no_audio(self) -> None:
        created = self.service.knowledge_advisor.create_session()
        first = self.service.knowledge_advisor.add_transcript(
            created["session_id"], "user", "我想了解夜灯", "provider-event-1",
        )
        second = self.service.knowledge_advisor.add_transcript(
            created["session_id"], "user", "我想了解夜灯", "provider-event-1",
        )
        self.assertEqual(first["turn_id"], second["turn_id"])
        with self.service.repository.connection() as connection:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(knowledge_advisor_turns)")}
        self.assertFalse({"audio", "audio_path", "audio_blob"} & columns)

    def test_mock_fixture_obeys_medical_engineering_budget_and_home_boundaries(self) -> None:
        cases = [
            ("长者胸痛怎么办？", "立即联系当地急救服务"),
            ("扶手能不能打在承重墙上？", "专业人员现场评估"),
            ("卫生间改造预算多少钱？", "通用咨询不会自由估算金额"),
            ("我家这个地垫安全吗？", "上传清晰照片或开始实时检查"),
        ]
        for question, expected in cases:
            created = self.service.knowledge_advisor.create_session()
            answer = self.service.knowledge_advisor.add_message(created["session_id"], question)
            self.assertIn(expected, answer["assistant_turn"]["text"])

    def test_voice_queue_heartbeat_and_cancel_use_general_session_only(self) -> None:
        created = self.service.knowledge_advisor.create_session()
        session_id = created["session_id"]
        client_id = "11111111-1111-4111-8111-111111111111"
        connection = VoiceConnection(
            "123456789012345678901234", "room", "user", "bot", "task", "short-token", "2099-01-01T00:00:00+00:00",
        )
        with patch.object(VolcengineVoiceProvider, "configured", return_value=True), patch.object(
            VolcengineVoiceProvider, "start", return_value=connection,
        ), patch.object(VolcengineVoiceProvider, "stop") as stop:
            ticket = self.service.knowledge_advisor.enqueue_rtc(session_id, client_id, "audio")
            self.assertEqual(ticket["status"], "granted")
            rtc = self.service.knowledge_advisor.start_voice(session_id, client_id, ticket["ticket_id"])
            self.assertTrue(rtc["available"])
            heartbeat = self.service.knowledge_advisor.heartbeat_queue(
                session_id, ticket["ticket_id"], client_id,
            )
            self.assertEqual(heartbeat["status"], "active")
            self.service.knowledge_advisor.cancel_queue(session_id, ticket["ticket_id"], client_id)
            stop.assert_called_once()
        self.assertEqual(self.service.repository.fetchone(
            "SELECT status FROM knowledge_advisor_rtc_queue WHERE id=?", (ticket["ticket_id"],),
        )["status"], "released")
        self.assertEqual(self.service.repository.fetchone("SELECT COUNT(*) AS value FROM advisor_sessions")["value"], 0)


if __name__ == "__main__":
    unittest.main()
