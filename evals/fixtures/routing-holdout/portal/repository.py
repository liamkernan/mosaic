"""In-memory export-job repository for the fixture."""

_export_jobs: dict[str, dict] = {}
_next_export_id = 1


def reset_export_jobs() -> None:
    global _next_export_id
    _export_jobs.clear()
    _next_export_id = 1


def create_export_job(member_id: str) -> dict:
    global _next_export_id
    job = {
        "id": f"export-{_next_export_id}",
        "member_id": member_id,
        "status": "queued",
    }
    _next_export_id += 1
    _export_jobs[job["id"]] = job
    return job


def get_export_job(export_id: str) -> dict | None:
    return _export_jobs.get(export_id)


def save_export_job(job: dict) -> dict:
    _export_jobs[job["id"]] = job
    return job


def list_export_jobs() -> list[dict]:
    return list(_export_jobs.values())
