import unittest

from incident import repository
from incident.api import get_incident_summary


class IncidentSummaryOracleTest(unittest.TestCase):
    def setUp(self):
        repository.reset_state()
        repository.save_incident({
            "id": "INC-42",
            "title": "Payment retries",
            "status": "monitoring",
            "owner": "Nina",
            "internal_notes": "do not return",
        })

    def test_public_summary_returns_exact_visible_fields(self):
        self.assertEqual({
            "status": 200,
            "body": {
                "id": "INC-42",
                "title": "Payment retries",
                "status": "monitoring",
                "owner": "Nina",
            },
        }, get_incident_summary("INC-42"))

    def test_missing_incident_returns_a_stable_not_found_response(self):
        self.assertEqual({
            "status": 404,
            "body": {"error": "incident not found"},
        }, get_incident_summary("INC-missing"))
