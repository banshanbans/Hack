import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.app.environment import load_environment


class EnvironmentTests(unittest.TestCase):
    def test_loads_env_without_overriding_runtime_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(
                "# server only\nANJU_VISION_PROVIDER=ark\n"
                "ANJU_ARK_MODEL='doubao-test'\nARK_API_KEY=file-secret\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"ARK_API_KEY": "runtime-secret"}, clear=True):
                self.assertEqual(load_environment(path), path)
                self.assertEqual(os.environ["ANJU_VISION_PROVIDER"], "ark")
                self.assertEqual(os.environ["ANJU_ARK_MODEL"], "doubao-test")
                self.assertEqual(os.environ["ARK_API_KEY"], "runtime-secret")

    def test_missing_env_is_optional(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(load_environment(Path(directory) / "missing.env"))


if __name__ == "__main__":
    unittest.main()
