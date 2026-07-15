from copy import deepcopy


_incidents = {}


def reset_state():
    _incidents.clear()


def save_incident(incident):
    _incidents[incident["id"]] = deepcopy(incident)
    return deepcopy(_incidents[incident["id"]])


def get_incident(incident_id):
    incident = _incidents.get(incident_id)
    return deepcopy(incident) if incident is not None else None
