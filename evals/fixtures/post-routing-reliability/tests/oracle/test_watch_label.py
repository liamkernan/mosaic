from pathlib import Path
import unittest

from tests.frontend_harness import run_dashboard


ROOT = Path(__file__).resolve().parents[2]


class WatchLabelOracleTest(unittest.TestCase):
    def test_watch_button_is_named_without_changing_behavior(self):
        html = (ROOT / "index.html").read_text()
        self.assertIn('id="watchIncident" type="button" aria-label="Watch incident"', html)
        state = run_dashboard(["#watchIncident"])
        self.assertEqual("true", state["watching"])
        self.assertEqual("Watching incident", state["watchStatus"])
