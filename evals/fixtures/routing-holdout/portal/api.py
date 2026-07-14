"""Account-export API boundary."""

from portal.repository import create_export_job, get_export_job


def request_account_export(member_id: str) -> dict:
    return create_export_job(member_id)


def get_account_export(export_id: str) -> dict | None:
    return get_export_job(export_id)
