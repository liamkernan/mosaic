from incident import repository


def process_next_escalation():
    job = next((item for item in repository.list_escalation_jobs() if item["status"] == "queued"), None)
    if job is None:
        return None

    incident = repository.get_incident(job["incident_id"])
    job["status"] = "completed"
    job["bundle"] = dict(incident)
    return repository.save_escalation_job(job)
