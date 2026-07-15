from pathlib import Path
import unittest

from incident import repository
from incident.service import format_incident_title
from tests.frontend_harness import run_dashboard


ROOT = Path(__file__).resolve().parents[2]


class FixtureBaselineTest(unittest.TestCase):
    def setUp(self):
        repository.reset_state()

    def test_dashboard_watch_behavior(self):
        state = run_dashboard(["#watchIncident"])
        self.assertEqual("true", state["watching"])
        self.assertEqual("Watching incident", state["watchStatus"])

    def test_incident_storage_and_title_format(self):
        incident = repository.save_incident({
            "id": "INC-7",
            "title": "Checkout latency",
            "revision": 1,
        })
        self.assertEqual("INC-7: Checkout latency", format_incident_title(incident))
        self.assertEqual(incident, repository.get_incident("INC-7"))

    def test_fixture_keeps_local_assets(self):
        html = (ROOT / "index.html").read_text()
        self.assertIn('src="dashboard.js"', html)
        self.assertIn('id="detailsPanel"', html)


if __name__ == "__main__":
    unittest.main()
