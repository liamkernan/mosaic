from incident import repository


def request_escalation_export(incident_id):
    if repository.get_incident(incident_id) is None:
        raise KeyError(incident_id)
    return repository.create_escalation_job(incident_id)


def get_escalation_status(job_id):
    return repository.get_escalation_job(job_id)
