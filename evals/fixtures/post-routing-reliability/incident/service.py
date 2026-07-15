from incident import repository


def format_incident_title(incident):
    return f"{incident['id']}: {incident['title']}"


def apply_incident_update(incident_id, revision, status, customer_summary):
    incident = repository.get_incident(incident_id)
    if incident is None:
        raise KeyError(incident_id)

    incident["revision"] = revision
    incident["status"] = status
    incident["customer_summary"] = customer_summary
    return repository.save_incident(incident)
