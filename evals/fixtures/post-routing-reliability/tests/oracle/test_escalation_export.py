import json
import unittest

from incident import api, repository, worker


def incident(incident_id, title, secret):
    return {
        "id": incident_id,
        "title": title,
        "revision": 3,
        "status": "investigating",
        "severity": "critical",
        "owner": "Operations",
        "customer_summary": "Engineers are mitigating impact",
        "timeline": [
            {"at": "12:00", "message": "Incident opened", "internal_actor": "admin@example.com"},
            {"at": "12:05", "message": "Mitigation started", "internal_actor": "root@example.com"},
        ],
        "internal_notes": f"private-{secret}",
        "api_token": f"token-{secret}",
    }


class EscalationExportOracleTest(unittest.TestCase):
    def setUp(self):
        repository.reset_state()
        repository.save_incident(incident("INC-100", "Checkout outage", "one"))
        repository.save_incident(incident("INC-200", "Search errors", "two"))

    def test_open_job_reuse_is_per_incident_and_completed_bundle_is_allowlisted(self):
        first = api.request_escalation_export("INC-100")
        repeated = api.request_escalation_export("INC-100")
        other = api.request_escalation_export("INC-200")
        self.assertEqual(first["id"], repeated["id"])
        self.assertNotEqual(first["id"], other["id"])

        first["status"] = "processing"
        repository.save_escalation_job(first)
        processing_repeat = api.request_escalation_export("INC-100")
        self.assertEqual(first["id"], processing_repeat["id"])

        completed = worker.process_next_escalation()
        self.assertEqual(first["id"], completed["id"])
        self.assertEqual("completed", completed["status"])
        self.assertEqual(completed, api.get_escalation_status(first["id"]))
        self.assertEqual(
            {"id", "title", "status", "severity", "owner", "customer_summary"},
            set(completed["bundle"]["incident"]),
        )
        self.assertEqual(
            [
                {"at": "12:00", "message": "Incident opened"},
                {"at": "12:05", "message": "Mitigation started"},
            ],
            completed["bundle"]["timeline"],
        )
        serialized = json.dumps(completed["bundle"])
        for forbidden in ("internal_notes", "api_token", "private-one", "token-one", "admin@example.com"):
            self.assertNotIn(forbidden, serialized)
