from __future__ import annotations

import logging
import unittest

from backend.app.logging_safety import SensitiveQueryFilter, redact_sensitive_query


class LoggingSafetyTests(unittest.TestCase):
    def test_redacts_event_and_assessment_tokens_from_query_strings(self) -> None:
        value = (
            'GET /events?token=event-secret&cursor=2&access_token=assessment-secret HTTP/1.1'
        )

        self.assertEqual(
            redact_sensitive_query(value),
            'GET /events?token=[REDACTED]&cursor=2&access_token=[REDACTED] HTTP/1.1',
        )

    def test_filter_redacts_uvicorn_access_log_arguments(self) -> None:
        record = logging.LogRecord(
            name="uvicorn.access",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg='%s - "%s %s HTTP/%s" %d',
            args=("127.0.0.1", "GET", "/events?token=event-secret", "1.1", 101),
            exc_info=None,
        )

        self.assertTrue(SensitiveQueryFilter().filter(record))
        self.assertNotIn("event-secret", record.getMessage())
        self.assertIn("token=[REDACTED]", record.getMessage())


if __name__ == "__main__":
    unittest.main()
