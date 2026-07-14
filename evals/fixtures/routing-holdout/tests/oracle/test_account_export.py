import json

from portal.api import request_account_export
from portal.repository import get_export_job, list_export_jobs, reset_export_jobs
from portal.worker import complete_account_export


def setup_function() -> None:
    reset_export_jobs()


def test_repeated_request_reuses_the_members_open_export_job() -> None:
    first = request_account_export("member-1")
    repeated = request_account_export("member-1")
    other_member = request_account_export("member-2")
    assert repeated["id"] == first["id"]
    assert first["status"] == "queued"
    assert other_member["id"] != first["id"]
    assert len(list_export_jobs()) == 2


def test_worker_saves_a_completed_bundle_without_credentials_or_sessions() -> None:
    job = request_account_export("member-1")
    completed = complete_account_export(
        job,
        {
            "name": "Avery Stone",
            "email": "avery@example.com",
            "password_hash": "never-export-this",
        },
        [{"id": "order-17", "total_cents": 1800}],
        [{"session_token": "never-export-this-either"}],
    )
    assert completed["status"] == "completed"
    assert completed["bundle"]["profile"] == {
        "name": "Avery Stone",
        "email": "avery@example.com",
    }
    assert completed["bundle"]["orders"] == [{"id": "order-17", "total_cents": 1800}]
    assert "sessions" not in completed["bundle"]
    serialized = json.dumps(completed)
    assert "password_hash" not in serialized
    assert "session_token" not in serialized
    assert "never-export" not in serialized
    assert get_export_job(job["id"]) == completed
