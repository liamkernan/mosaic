import unittest

from incident import repository
from incident.service import apply_incident_update


class IncidentRevisionOracleTest(unittest.TestCase):
    def setUp(self):
        repository.reset_state()
        repository.save_incident({
            "id": "INC-42",
            "title": "Payment retries",
            "revision": 8,
            "status": "monitoring",
            "customer_summary": "Recovery in progress",
            "severity": "high",
            "owner": "Nina",
        })

    def test_only_strictly_newer_updates_replace_persisted_state(self):
        original = repository.get_incident("INC-42")
        for revision in (8, 7):
            result = apply_incident_update("INC-42", revision, "resolved", "Stale summary")
            self.assertEqual(original, result)
            self.assertEqual(original, repository.get_incident("INC-42"))

        updated = apply_incident_update("INC-42", 9, "resolved", "Service recovered")
        self.assertEqual(9, updated["revision"])
        self.assertEqual("resolved", updated["status"])
        self.assertEqual("Service recovered", updated["customer_summary"])
        self.assertEqual("high", updated["severity"])
        self.assertEqual("Nina", updated["owner"])
        self.assertEqual("Payment retries", updated["title"])
