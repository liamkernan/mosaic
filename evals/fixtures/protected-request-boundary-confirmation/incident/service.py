from incident import repository


def format_incident_title(incident):
    return f"{incident['id']}: {incident['title']}"


def build_incident_summary(incident_id):
    incident = repository.get_incident(incident_id)
    if incident is None:
        raise KeyError(incident_id)
    return {
        "id": incident["id"],
        "status": incident["status"],
    }
