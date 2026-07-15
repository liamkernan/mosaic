from copy import deepcopy


_incidents = {}
_escalation_jobs = {}
_next_job_id = 1


def reset_state():
    global _next_job_id
    _incidents.clear()
    _escalation_jobs.clear()
    _next_job_id = 1


def save_incident(incident):
    _incidents[incident["id"]] = deepcopy(incident)
    return deepcopy(_incidents[incident["id"]])


def get_incident(incident_id):
    incident = _incidents.get(incident_id)
    return deepcopy(incident) if incident is not None else None


def create_escalation_job(incident_id):
    global _next_job_id
    job = {
        "id": f"escalation-{_next_job_id}",
        "incident_id": incident_id,
        "status": "queued",
        "bundle": None,
    }
    _next_job_id += 1
    _escalation_jobs[job["id"]] = deepcopy(job)
    return deepcopy(job)


def find_open_escalation_job(incident_id):
    return None


def save_escalation_job(job):
    _escalation_jobs[job["id"]] = deepcopy(job)
    return deepcopy(job)


def get_escalation_job(job_id):
    job = _escalation_jobs.get(job_id)
    return deepcopy(job) if job is not None else None


def list_escalation_jobs():
    return [deepcopy(job) for job in _escalation_jobs.values()]
