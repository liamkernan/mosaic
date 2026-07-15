import unittest

from incident import repository
from incident.api import get_incident_owner


class IncidentOwnerOracleTest(unittest.TestCase):
    def setUp(self):
        repository.reset_state()
        repository.save_incident({
            "id": "INC-84",
            "title": "Webhook backlog",
            "status": "investigating",
            "owner": "Amina",
            "internal_notes": "do not return",
        })

    def test_known_incident_returns_exact_public_owner_body(self):
        self.assertEqual({
            "status": 200,
            "body": {
                "id": "INC-84",
                "owner": "Amina",
            },
        }, get_incident_owner("INC-84"))

    def test_missing_incident_returns_stable_not_found_body(self):
        self.assertEqual({
            "status": 404,
            "body": {"error": "incident not found"},
        }, get_incident_owner("INC-missing"))
