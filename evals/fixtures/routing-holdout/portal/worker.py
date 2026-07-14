"""Background account-export worker."""

from portal.repository import save_export_job


def complete_account_export(
    job: dict,
    profile: dict,
    orders: list[dict],
    sessions: list[dict],
) -> dict:
    completed = {
        **job,
        "status": "completed",
        "bundle": {
            "profile": profile,
            "orders": orders,
            "sessions": sessions,
        },
    }
    return save_export_job(completed)
