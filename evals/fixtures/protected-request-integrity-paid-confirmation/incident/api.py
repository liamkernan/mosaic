from incident.service import build_incident_summary


def get_incident_summary(incident_id):
    return {
        "status": 200,
        "body": build_incident_summary(incident_id),
    }
